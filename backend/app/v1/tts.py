"""Clone each translated utterance from its corresponding source utterance."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from time import monotonic

from .audio_segments import SpeechClip, SpeechClips
from .audio import audio_info
from .errors import ApiError
from .segments import LANGUAGES, Transcript, read_transcript, read_translation
from .steps import Completed, StageContext
from ..paths import data_directory

def model_directory() -> Path:
    configured = os.getenv("YOUDUB_VOXCPM_MODEL_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else data_directory() / "models" / "voxcpm" / "VoxCPM2"


def available_models() -> list[str]:
    """Inspect only local asset metadata; never import or download a model."""
    root = model_directory()

    def present(name: str) -> bool:
        path = root / name
        return path.is_file() and path.stat().st_size > 0

    groups = (("config.json",), ("tokenizer_config.json",), ("tokenizer.json", "tokenizer.model"),
              ("model.safetensors", "pytorch_model.bin"), ("audiovae.safetensors", "audiovae.pth"))
    return ["VoxCPM2"] if all(any(present(name) for name in choices) for choices in groups) else []


def _reference_error(message: str) -> ApiError:
    return ApiError(422, "INVALID_MEDIA", message, field="tts.voice.mode", stage="tts")


def _monitor_progress(path, count, context, progress):
    next_poll = 0.0
    last = None

    def check_cancel_and_report():
        nonlocal next_poll, last
        context.check_cancel()
        now = monotonic()
        if now < next_poll:
            return
        next_poll = now + 3
        try:
            snapshot = json.loads(path.read_text('utf-8'))
        except (OSError, ValueError):
            return
        if not isinstance(snapshot, dict):
            return
        saved = snapshot.get('saved')
        if type(saved) is not int or not 0 <= saved <= count or snapshot == last:
            return
        last = snapshot
        status = f'已保存 {saved}/{count} 段配音'
        if snapshot.get('phase'):
            status += f" · {snapshot['phase']}"
        if snapshot.get('current'):
            status += f" · 正在处理第 {snapshot['current']} 段"
        if snapshot.get('clipsPerMinute'):
            status += f" · {snapshot['clipsPerMinute']} 段/分钟"
        if snapshot.get('remainingSeconds'):
            minutes, seconds = divmod(snapshot['remainingSeconds'], 60)
            status += f' · 预计剩余 {minutes}分{seconds:02d}秒'
        progress(saved / count, status)

    return check_cancel_and_report


def prepare_reference_audio(context: StageContext, transcript: Transcript, progress: Callable) -> dict:
    """Prepare cloning inputs independently of a speech model invocation."""
    from ..config import ffmpeg_binary
    from .media import _run_media

    vocals = context.input_files["vocals"]
    source_info = audio_info(vocals, stage=context.stage)
    source_duration_ms = round(source_info.frames * 1000 / source_info.samplerate)
    if any(segment.end_ms > source_duration_ms for segment in transcript.segments):
        raise ApiError(422, "INVALID_MEDIA", "A source utterance lies outside the separated vocals.", stage="tts")
    # Keep each utterance's complete audio and matching text, including imported
    # subtitles that have sentence timings without ASR word timings.
    references = transcript.segments
    output_dir = context.work_dir / "tts"
    reference_dir = output_dir / "references"
    reference_dir.mkdir(parents=True, exist_ok=True)
    prepared = {}
    progress(0.0, "Preparing source utterance references")
    for index, reference in enumerate(references, start=1):
        context.check_cancel()
        start_ms = reference.start_ms
        duration_ms = reference.end_ms - start_ms
        path = reference_dir / f"{index:06d}.wav"
        try:
            result = _run_media(
                [ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror",
                 "-ss", f"{start_ms / 1000:.3f}", "-i", str(vocals.resolve()),
                 "-t", f"{duration_ms / 1000:.3f}", "-map", "0:a:0", "-vn", "-ac", "1",
                 "-ar", "16000", "-c:a", "pcm_s16le", str(path.resolve())],
                check_cancel=context.check_cancel,
            )
        except FileNotFoundError as exc:
            raise ApiError(503, "RUNTIME_UNAVAILABLE", "ffmpeg is unavailable.", stage="tts") from exc
        if result.returncode != 0:
            raise ApiError(422, "INVALID_MEDIA", "The source utterance reference could not be extracted.", stage="tts")
        info = audio_info(path, stage=context.stage)
        if round(info.frames * 1000 / info.samplerate) != duration_ms:
            raise ApiError(422, "INVALID_MEDIA", "The source reference does not cover the selected utterance interval.", stage="tts")
        prepared[reference.id] = {"path": path, "text": reference.text}
        progress(index / len(references), f"Prepared source reference {index}/{len(references)}")
    return prepared


def run(context: StageContext, progress: Callable[[float | None, str], None], *,
        prepared_references: dict, checkpoint_root: Path | None = None, checkpoint_identity=None) -> Completed:
    from .media import _run_media

    context.check_cancel()
    selection = context.config.tts
    if selection is None or selection.adapter != "voxcpm" or selection.model != "VoxCPM2" or selection.device == "remote":
        raise ApiError(422, "INVALID_CONFIG", "TTS requires the local VoxCPM2 model and a CPU/CUDA/ROCm/MPS device.",
                       field="tts", stage="tts")
    if selection.voice.mode != "source_clone":
        raise ApiError(422, "INVALID_CONFIG", "VoxCPM2 preset voice assets are not configured; select source_clone.",
                       field="tts.voice.mode", stage="tts")
    if not available_models():
        raise ApiError(503, "MODEL_NOT_READY", "The local VoxCPM2 model assets are missing or incomplete.",
                       field="tts.model", stage="tts")
    for name in ("transcript", "translation"):
        path = context.input_files.get(name)
        if path is None or not path.is_file() or path.stat().st_size == 0:
            raise ApiError(500, "INPUT_MISSING", f"The {name} input is missing or empty.", stage="tts")
    transcript = read_transcript(context.input_files["transcript"], stage="tts", selective=getattr(context.config, 'selective', False))
    translation = read_translation(context.input_files["translation"], transcript, stage="tts")
    if transcript.detected_language not in LANGUAGES or context.config.target_language not in LANGUAGES:
        raise ApiError(422, "UNSUPPORTED_LANGUAGE", "VoxCPM2 supports English, Chinese and Japanese in this pipeline.",
                       stage="tts", action="adjust_settings")
    if translation.target_language != context.config.target_language:
        raise ApiError(502, "INVALID_PROVIDER_RESULT", "The translation target language differs from the Task.", stage="tts")
    texts = translation.match(transcript)
    prepared = prepared_references
    if set(prepared) != {segment.id for segment in transcript.segments}:
        raise _reference_error("Prepared source references must match transcript utterance IDs exactly.")
    output_dir = context.work_dir / "tts"
    output_dir.mkdir(parents=True, exist_ok=True)
    clips = [{"segment_id": segment.id, "text": texts[segment.id],
              "reference_path": str(Path(prepared[segment.id]["path"]).resolve()),
              "reference_text": prepared[segment.id]["text"],
              "output_path": str((output_dir / f"{index:06d}.wav").resolve())}
             for index, segment in enumerate(transcript.segments, start=1)]
    request_path = output_dir / "request.json"
    performance = getattr(context.config, 'speech_performance', 'quality')
    if performance not in ('quality', 'balanced', 'nano2', 'nano4'):
        raise ApiError(422, 'INVALID_CONFIG', '请选择有效的配音档位。', stage='tts', field='speechPerformance')
    request = {"clips": clips, "speech_cleanup": getattr(context.config, 'speech_cleanup', True),
               "speech_performance": performance,
               "target_language": context.config.target_language, "source_language": transcript.detected_language}
    if checkpoint_root is not None:
        references = []
        for clip in clips:
            path = Path(clip['reference_path'])
            info = path.stat()
            references.append((clip['segment_id'], clip['text'], clip['reference_text'], str(path), info.st_size, info.st_mtime_ns))
        identity = [2, checkpoint_identity, str(model_directory().resolve()), selection.device,
                    request['speech_cleanup'], request['source_language'], request['target_language'], references]
        if performance != 'quality':
            identity.extend([performance, 1])
        key = sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
        checkpoint = checkpoint_root / key
        checkpoint.mkdir(parents=True, exist_ok=True)
        request['checkpoint_path'] = str(checkpoint)
    progress(None, '正在校验配音断点并准备 VoxCPM2')
    request_path.write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
    nano_python = data_directory() / 'runtime' / 'nano-voxcpm' / 'Scripts' / 'python.exe'
    profiles = {
        'nano4': ['nano4', 'nano2', 'nano1', 'quality'],
        'nano2': ['nano2', 'nano1', 'quality'],
    }.get(performance, [performance])
    if performance.startswith('nano'):
        if 'checkpoint_path' not in request:
            checkpoint = output_dir / 'checkpoint'
            checkpoint.mkdir(exist_ok=True)
            request['checkpoint_path'] = str(checkpoint)
        if not nano_python.is_file() or not selection.device.startswith('cuda:'):
            progress(None, 'NanoVLLM 环境或 CUDA 不可用，使用原生配音并保留断点')
            profiles = ['quality']
    for profile in profiles:
        request['speech_performance'] = profile
        request_path.write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
        # Remove the prior invocation's progress before polling the new attempt.
        (output_dir / 'progress.json').unlink(missing_ok=True)
        progress(None, f"正在准备配音 · {profile}")
        result = _run_media(
            [str(nano_python) if profile.startswith('nano') else sys.executable,
             str(Path(__file__).with_name("tts_process.py")),
             "--model-path", str(model_directory().resolve()), "--request-path", str(request_path.resolve()),
             "--device", selection.device],
            check_cancel=_monitor_progress(output_dir / 'progress.json', len(clips), context, progress),
        )
        if result.returncode == 0:
            break
        if profile != profiles[-1]:
            progress(None, '当前加速档未完成，降低并发并从已保存的配音继续')
    if result.returncode != 0:
        try:
            error = json.loads(result.stderr.strip().splitlines()[-1])
        except (ValueError, IndexError):
            error = {}
        if (not isinstance(error, dict) or error.get("code") not in {"MODEL_NOT_READY", "INPUT_MISSING", "INVALID_PROVIDER_RESULT", "TTS_OUT_OF_MEMORY"}
                or not isinstance(error.get("message"), str)):
            error = {"code": "WORKER_EXITED", "message": f"VoxCPM2 process exited with code {result.returncode}."}
        status = 503 if error["code"] in {"MODEL_NOT_READY", "TTS_OUT_OF_MEMORY"} else 502
        raise ApiError(status, error["code"], error["message"], stage="tts",
                       action="adjust_settings" if error["code"] == "MODEL_NOT_READY" else "retry") from RuntimeError(result.stderr)
    measured = []
    for clip in clips:
        context.check_cancel()
        path = Path(clip["output_path"])
        info = audio_info(path, stage=context.stage)
        duration_ms = round(info.frames * 1000 / info.samplerate)
        if duration_ms <= 0:
            raise ApiError(502, "INVALID_PROVIDER_RESULT", "A generated speech clip has no measurable duration.", stage="tts")
        measured.append(SpeechClip(segment_id=clip["segment_id"], path=path.relative_to(context.work_dir.resolve()).as_posix(),
                                   duration_ms=duration_ms, sample_rate_hz=info.samplerate, channels=info.channels))
    payload = SpeechClips(clips=measured)
    payload.match(transcript)
    output = context.work_dir / "speech_clips.json"
    output.write_text(payload.model_dump_json(indent=2), encoding="utf-8")
    progress(1.0, f'已保存 {len(clips)}/{len(clips)} 段配音')
    return Completed(output_files={"speech_clips": output})
