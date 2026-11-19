"""Bounded speech timing on the unchanged video timeline.

The duration multiplier is base * local, where base is
clamp(0.99 * sum(source durations) / sum(TTS durations), 0.8, 1.2), and local
is clamp((source_end - scheduled_start) / (TTS_duration * base), 0.75, 1.25).
These are the production pipeline's bounds. FFmpeg atempo uses the reciprocal
multiplier. Scheduling always advances by actual output samples, never by the
estimated duration or the old source end. The final placement works backward
from the video end, borrowing preceding silence when the tail needs room.
No speech samples are trimmed or re-timed by that placement.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from pathlib import Path

import numpy as np
import soundfile as sf

from ..config import ffmpeg_binary
from . import media
from .audio_segments import AlignedSegment, Alignment, SpeechClip, read_speech_clips
from .errors import ApiError
from .segments import read_transcript
from .steps import Completed, StageContext

SAMPLE_RATE = 48000
CHANNELS = 2
BACKGROUND_GAIN = 0.3


def _input_file(context: StageContext, name: str) -> Path:
    path = context.input_files.get(name)
    if path is None or not path.is_file():
        raise ApiError(500, "INPUT_MISSING", f"The {name} input is missing.", stage="mix", action="retry")
    return path


def _invalid(message: str) -> ApiError:
    return ApiError(500, "INVALID_PROVIDER_RESULT", message, stage="mix", action="retry")


def _clip_input(context: StageContext, clip: SpeechClip) -> tuple[Path, float]:
    path = (context.work_dir / clip.path).resolve()
    if Path(clip.path).is_absolute() or not path.is_relative_to(context.work_dir.resolve()) or not path.is_file():
        raise _invalid("A speech clip is missing or outside its work directory.")
    try:
        info = sf.info(path)
    except (OSError, RuntimeError) as exc:
        raise _invalid("A speech clip could not be read.") from exc
    if (info.frames <= 0 or info.samplerate != clip.sample_rate_hz or info.channels != clip.channels
            or round(info.frames * 1000 / info.samplerate) != clip.duration_ms):
        raise _invalid("Speech clip metadata differs from the actual audio.")
    return path, info.frames * 1000 / info.samplerate


def _decode(context: StageContext, source: Path, destination: Path, *, duration_ratio: float = 1.0) -> np.ndarray:
    command = [ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror",
               "-i", str(source.resolve()), "-map", "0:a:0", "-vn"]
    if duration_ratio != 1.0:
        command.extend(["-af", f"atempo={1 / duration_ratio:.12g}"])
    command.extend(["-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "-c:a", "pcm_f32le", str(destination.resolve())])
    try:
        result = media._run_media(command, check_cancel=context.check_cancel)
    except FileNotFoundError as exc:
        raise ApiError(503, "RUNTIME_UNAVAILABLE", "ffmpeg is unavailable.", stage="mix") from exc
    if result.returncode != 0:
        raise ApiError(500, "INTERNAL_ERROR", f"FFmpeg audio processing failed (exit {result.returncode}).",
                       stage="mix", action="retry")
    try:
        samples, rate = sf.read(destination, dtype="float32", always_2d=True)
    except (OSError, RuntimeError) as exc:
        raise _invalid("Processed audio is missing or invalid.") from exc
    if rate != SAMPLE_RATE or samples.shape[1] != CHANNELS or not len(samples) or not np.isfinite(samples).all():
        raise _invalid("Processed audio has invalid samples or format.")
    return samples


def run(context: StageContext, progress: Callable[[float | None, str], None]) -> Completed:
    context.check_cancel()
    max_rate = getattr(context.config, 'max_speech_rate', 5 / 3)
    if isinstance(max_rate, bool) or not isinstance(max_rate, (int, float)) or not math.isfinite(max_rate) or not 1 <= max_rate <= 1.67:
        raise ApiError(422, 'INVALID_CONFIG', 'Maximum speech rate must be between 1 and 1.67.', stage='mix')
    if context.config.output_mode == "subtitles":
        raise ApiError(422, "INVALID_CONFIG", "Subtitle-only tasks do not have a mixing step.", stage="mix")
    transcript = read_transcript(_input_file(context, "transcript"), stage="mix")
    clips = read_speech_clips(_input_file(context, "speech_clips"), transcript).match(transcript)
    try:
        info = json.loads(_input_file(context, "media_info").read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise _invalid("The source media information is invalid.") from exc
    duration = info.get("duration_ms") if isinstance(info, dict) else None
    if type(duration) is not int or duration <= 0:
        raise _invalid("The source video duration is invalid.")
    previous_source_end = 0
    inputs = {}
    for segment in transcript.segments:
        if segment.start_ms < previous_source_end:
            raise ApiError(422, "UNSUPPORTED_OVERLAPPING_SPEECH", "Source speech segments overlap.",
                           stage="mix", action="none")
        previous_source_end = segment.end_ms
        inputs[segment.id] = _clip_input(context, clips[segment.id])
    background = _input_file(context, "background") if context.config.keep_background else None
    context.work_dir.mkdir(parents=True, exist_ok=True)
    adjusted = context.work_dir / "adjusted"
    adjusted.mkdir(exist_ok=True)
    total_samples = round(duration * SAMPLE_RATE / 1000)
    final_audio = np.zeros((total_samples, CHANNELS), dtype=np.float32)
    base = min(1.2, max(0.8, 0.99 * sum(segment.end_ms - segment.start_ms for segment in transcript.segments)
                        / sum(milliseconds for _, milliseconds in inputs.values())))
    previous_end = 0
    planned = []
    pacing = []
    for index, segment in enumerate(transcript.segments):
        context.check_cancel()
        path, raw_duration = inputs[segment.id]
        start_sample = max(round(segment.start_ms * SAMPLE_RATE / 1000), previous_end)
        start_ms = start_sample * 1000 / SAMPLE_RATE
        local = min(1.25, max(0.75, (segment.end_ms - start_ms) / (raw_duration * base)))
        ratio = max(base * local, 1 / max_rate)
        samples = _decode(context, path, adjusted / f"{index + 1:04d}.wav", duration_ratio=ratio)
        pacing.append({'segmentId': segment.id, 'speechRate': 1 / ratio, 'rateLimited': ratio > base * local})
        end_sample = start_sample + len(samples)
        planned.append([start_sample, len(samples)])
        previous_end = end_sample
        progress((index + 1) / (len(transcript.segments) + 1), f"Adjusted {index + 1}/{len(transcript.segments)} speech clips")

    # Place every complete clip before allocating its final interval. Moving a
    # tail cluster into earlier silence preserves audio, rate and video length.
    next_start = total_samples
    for item in reversed(planned):
        item[0] = min(item[0], next_start - item[1])
        if item[0] < 0:
            raise ApiError(422, "AUDIO_EXCEEDS_VIDEO", "The complete dubbed speech does not fit the source video.",
                           stage="mix", action="adjust_settings")
        next_start = item[0]
    aligned = []
    for index, (segment, (start_sample, count)) in enumerate(zip(transcript.segments, planned, strict=True)):
        context.check_cancel()
        samples, _ = sf.read(adjusted / f"{index + 1:04d}.wav", dtype="float32", always_2d=True)
        end_sample = start_sample + count
        final_audio[start_sample:end_sample] = samples
        aligned.append(AlignedSegment(
            segment_id=segment.id, source_start_ms=segment.start_ms, source_end_ms=segment.end_ms,
            dubbed_start_ms=round(start_sample * 1000 / SAMPLE_RATE), dubbed_end_ms=round(end_sample * 1000 / SAMPLE_RATE),
        ))
    if background is not None:
        samples = _decode(context, background, adjusted / "background.wav")
        count = min(len(samples), total_samples)
        final_audio[:count] += BACKGROUND_GAIN * samples[:count]
        # Preserve headroom for the additive mix, with a fixed documented gain.
        final_audio /= 1 + BACKGROUND_GAIN
    context.check_cancel()
    if not np.isfinite(final_audio).all() or np.max(np.abs(final_audio)) > 1:
        raise _invalid("Mixed audio exceeds the supported sample amplitude.")
    alignment = Alignment(segments=aligned)
    alignment.match(transcript, duration)
    audio_path, alignment_path = context.work_dir / "mixed.wav", context.work_dir / "alignment.json"
    sf.write(audio_path, final_audio, SAMPLE_RATE, subtype="PCM_16")
    progress(None, '正在检查成品音量')
    _master_audio(context, audio_path, total_samples)
    alignment_path.write_text(alignment.model_dump_json(indent=2), encoding="utf-8")
    (context.work_dir / 'timing-quality.json').write_text(json.dumps({'maxSpeechRate': max_rate, 'segments': pacing}, indent=2), 'utf-8')
    progress(1.0, "Mixed audio and dubbed timeline are ready")
    return Completed(output_files={"mixed_audio": audio_path, "alignment": alignment_path})


def run_selective(context: StageContext, progress: Callable) -> Completed:
    transcript = read_transcript(_input_file(context, 'transcript'), stage='mix', selective=True)
    info = json.loads(_input_file(context, 'media_info').read_bytes())
    duration = info['duration_ms']
    clips = {clip.segment_id: clip for clip in (SpeechClip.model_validate(item) for item in
             json.loads(_input_file(context, 'speech_clips').read_bytes())['clips'])}
    if set(clips) != {segment.id for segment in transcript.segments}:
        raise _invalid('缺少英语对白对应的配音片段。')
    adjusted = context.work_dir / 'adjusted'
    adjusted.mkdir(exist_ok=True)
    count = round(duration * SAMPLE_RATE / 1000)
    original = _decode(context, _input_file(context, 'original'), adjusted / 'original.wav')
    final = np.zeros((count, CHANNELS), dtype=np.float32)
    final[:min(count, len(original))] = original[:count]
    background = (_decode(context, _input_file(context, 'background'), adjusted / 'background.wav')
                  if transcript.segments and context.config.keep_background else None)
    aligned, fallbacks = [], []
    previous_end = 0
    for index, segment in enumerate(transcript.segments):
        context.check_cancel()
        if segment.start_ms < previous_end or segment.end_ms > duration or any(
                region.start_ms < segment.end_ms and segment.start_ms < region.end_ms for region in transcript.preserved_ranges):
            raise _invalid('英语对白区间与保留原声的区间冲突。')
        previous_end = segment.end_ms
        path, milliseconds = _clip_input(context, clips[segment.id])
        start = round(segment.start_ms * SAMPLE_RATE / 1000)
        end = round(segment.end_ms * SAMPLE_RATE / 1000)
        allowed = segment.end_ms - segment.start_ms
        rate = min(context.config.max_speech_rate, max(1.0, milliseconds / max(1, allowed - 8)))
        track = adjusted / f'{index + 1:04d}.wav'
        samples = _decode(context, path, track, duration_ratio=1 / rate) if milliseconds / rate <= allowed else None
        if samples is None or len(samples) > end - start:
            fallbacks.append({'start_ms': segment.start_ms, 'end_ms': segment.end_ms, 'reason': 'timing'})
            continue
        replacement = np.zeros_like(final[start:end])
        replacement[:len(samples)] = samples
        if background is not None and len(background) > start:
            length = min(end, len(background)) - start
            replacement[:length] = (replacement[:length] + BACKGROUND_GAIN * background[start:start + length]) / (1 + BACKGROUND_GAIN)
        fade = min(SAMPLE_RATE // 100, len(replacement) // 2)
        if fade:
            gain = np.linspace(0, 1, fade, dtype=np.float32)[:, None]
            replacement[:fade] = final[start:start + fade] * (1 - gain) + replacement[:fade] * gain
            replacement[-fade:] = final[end - fade:end] * (1 - gain[::-1]) + replacement[-fade:] * gain[::-1]
        final[start:end] = replacement
        aligned.append(AlignedSegment(segment_id=segment.id, source_start_ms=segment.start_ms, source_end_ms=segment.end_ms,
                                      dubbed_start_ms=segment.start_ms, dubbed_end_ms=min(segment.end_ms, segment.start_ms + max(1, round(len(samples) * 1000 / SAMPLE_RATE)))))
        progress((index + 1) / len(transcript.segments), f'已处理 {index + 1}/{len(transcript.segments)} 段英语配音')
    audio_path, timeline = context.work_dir / 'mixed.wav', context.work_dir / 'alignment.json'
    sf.write(audio_path, final, SAMPLE_RATE, subtype='PCM_16')
    if aligned:
        _master_audio(context, audio_path, count)
    timeline.write_text(json.dumps({'segments': [item.model_dump() for item in aligned], 'timing_fallbacks': fallbacks}), 'utf-8')
    progress(1.0, f'已配音 {len(aligned)} 段，原声音轨已保留' if aligned else '全片保留原声')
    return Completed(output_files={'mixed_audio': audio_path, 'alignment': timeline})


def _master_audio(context, path, frames):
    """Raise quiet programmes, preserving normal/loud tracks and sample counts."""
    temporary = path.with_name('mixed-louder.wav')
    command = [ffmpeg_binary(), '-hide_banner', '-nostdin', '-y', '-i', str(path)]
    analysis = media._run_media(command + [
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-',
    ], check_cancel=context.check_cancel)
    if analysis.returncode:
        raise _invalid('无法测量成品音量。')
    start = analysis.stderr.rfind('{')
    try:
        measured, _ = json.JSONDecoder().raw_decode(analysis.stderr[start:])
        loudness = float(measured['input_i'])
    except (ValueError, KeyError):
        raise _invalid('成品音量测量结果无效。')
    # Leave a 4 LU margin below the target so normal programme variation does
    # not trigger processing. Only quiet programmes receive a gain adjustment.
    if not math.isfinite(loudness) or loudness >= -20:
        (path.parent / 'loudness.json').write_text(json.dumps({
            'adjusted': False, 'thresholdLufs': -20,
            'inputLufs': loudness if math.isfinite(loudness) else None,
        }), 'utf-8')
        return
    settings = (
        'loudnorm=I=-16:TP=-1.5:LRA=11:linear=true'
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}"
    )
    try:
        result = media._run_media(command + [
            '-af', settings + f',aresample=48000,apad,atrim=end_sample={frames}',
            '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(temporary),
        ], check_cancel=context.check_cancel)
        if result.returncode or sf.info(temporary).frames != frames:
            raise _invalid('无法调整成品音量或音轨时长不一致。')
        temporary.replace(path)
        (path.parent / 'loudness.json').write_text(json.dumps({
            'adjusted': True, 'thresholdLufs': -20,
            'targetLufs': -16, 'truePeakDb': -1.5, 'inputLufs': loudness,
        }), 'utf-8')
    finally:
        temporary.unlink(missing_ok=True)

