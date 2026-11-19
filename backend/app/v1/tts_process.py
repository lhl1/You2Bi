"""Generate a task's speech clips with one local VoxCPM2 model instance."""

from __future__ import annotations

import argparse
import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import shutil
import sys
from threading import Lock
from time import monotonic
import traceback
from uuid import uuid4

# Direct script execution and spawned NanoVLLM workers share the packaged root.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))


def _fail(code: str, message: str) -> int:
    print(json.dumps({"code": code, "message": message}), file=sys.stderr)
    return 1


def _atomic_replace(path, write):
    partial = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        write(partial)
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)


def _write_json(path, data):
    _atomic_replace(path, lambda partial: partial.write_text(json.dumps(data, ensure_ascii=False), 'utf-8'))


def _out_of_memory(error):
    return type(error).__name__ == 'OutOfMemoryError' or (
        isinstance(error, RuntimeError) and 'out of memory' in str(error).lower()
    )


class SpeechProgress:
    def __init__(self, path, total):
        self.path = path
        self.total = total
        self.saved = 0
        self.current = None
        self.recent = deque(maxlen=12)
        self.lock = Lock()
        self.last_write = float("-inf")

    def _write(self, *, force=False):
        now = monotonic()
        if not force and now - self.last_write < 3 and self.saved != self.total and self.current is not None:
            return
        elapsed = self.recent[-1] - self.recent[0] if len(self.recent) >= 4 else 0
        rate = (len(self.recent) - 1) / elapsed if elapsed > 0 else None
        try:
            _write_json(self.path, {'saved': self.saved, 'total': self.total, 'current': self.current,
                                   'phase': '正在准备配音引擎' if self.current is None and self.saved < self.total else None,
                                   'clipsPerMinute': round(rate * 60, 1) if rate else None,
                                   'remainingSeconds': round((self.total - self.saved) / rate) if rate else None})
            self.last_write = now
        except PermissionError:
            # A Windows reader may briefly hold the previous progress file open.
            pass

    def start(self, index):
        with self.lock:
            self.current = index
            self._write()

    def commit(self, count=1, *, generated=False):
        with self.lock:
            self.saved += count
            if generated:
                self.recent.append(monotonic())
            self._write(force=True)


def _valid_checkpoint(sf, path, rate):
    if path is None or not path.is_file():
        return False
    try:
        info = sf.info(path)
        return (info.format == 'WAV' and info.channels == 1 and info.frames > 0
                and info.samplerate == rate and info.subtype == 'PCM_16')
    except (OSError, RuntimeError):
        return False


def _valid_waveform(np, waveform):
    if waveform.ndim != 1 or not waveform.size or not np.isfinite(waveform).all():
        return False
    return 1e-6 <= np.max(np.abs(waveform)) <= 1


def _generate(np, model, clip, spoken, reference_only, balanced, mandarin):
    path = clip['reference_path']
    prompt = {} if reference_only else {'prompt_wav_path': path, 'prompt_text': clip['reference_text']}
    if not balanced or mandarin and len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]', spoken)) <= 4:
        return np.asarray(model.generate(text=spoken, reference_wav_path=path, normalize=False, denoise=False,
                                         retry_badcase=True, **prompt)), 10, False

    # Use the same isolated reference and continuation inputs as VoxCPM.generate.
    # The cached API exposes feature length so the first take can be screened and
    # a 10-step retry can reuse the exact same encoded reference.
    engine = model.tts_model
    cache = engine.build_prompt_cache(reference_wav_path=path, **prompt)
    text = re.sub(r'\s+', ' ', spoken)
    audio, tokens, features = engine.generate_with_prompt_cache(
        target_text=text, prompt_cache=cache, max_len=4096, inference_timesteps=8, retry_badcase=False,
    )
    waveform = np.asarray(audio.squeeze(0).cpu().numpy())
    if _valid_waveform(np, waveform) and features.shape[0] < tokens.numel() * 6:
        return waveform, 8, False
    audio, _, _ = engine.generate_with_prompt_cache(
        target_text=text, prompt_cache=cache, max_len=4096, inference_timesteps=10, retry_badcase=True,
    )
    return np.asarray(audio.squeeze(0).cpu().numpy()), 10, True


def _save_clip(sf, waveform, rate, spoken, output, checkpoint, raw_root, language):
    metrics = {}
    if raw_root is not None:
        from backend.app.v1.speech_cleanup import cleanup
        raw = raw_root / output.name
        if raw.exists():
            raw = raw.with_name(raw.stem + '-' + uuid4().hex + raw.suffix)
        with raw.open('xb') as stream:
            sf.write(stream, waveform, rate, format='WAV', subtype='PCM_16')
        waveform, metrics = cleanup(waveform, rate, spoken, language=language)
        metrics['rawAudio'] = str(raw)
    _atomic_replace(output, lambda partial: sf.write(partial, waveform, rate, format='WAV', subtype='PCM_16'))
    if checkpoint is not None:
        _atomic_replace(checkpoint, lambda partial: shutil.copyfile(output, partial))
    return metrics


def _generate_clips(options, config, request, clips, cleanup_enabled, checkpoint_path, language, performance):
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return _fail('MODEL_NOT_READY', 'The local audio dependencies are missing.')

    from backend.app.v1.speech_text import normalize_speech_text

    mandarin = language.lower().replace('_', '-').split('-')[0] == 'zh'
    reference_only = mandarin and request.get('source_language') in {'en', 'ja'}
    expected_rate = config.get('audio_vae_config', {}).get('out_sample_rate')
    pulse = SpeechProgress(options.request_path.parent / 'progress.json', len(clips))
    quality, changes, pending = {}, [], []
    raw_root = options.request_path.parent / 'raw' if cleanup_enabled else None

    def find_missing(entries, rate):
        missing = []
        for index, clip, spoken, output, checkpoint in entries:
            if _valid_checkpoint(sf, checkpoint, rate):
                _atomic_replace(output, lambda partial: shutil.copyfile(checkpoint, partial))
                quality[index] = {'segmentId': clip['segment_id'], 'processedAudio': str(output), 'resumed': True}
            else:
                missing.append((index, clip, spoken, output, checkpoint))
        return missing

    for index, clip in enumerate(clips, start=1):
        spoken = normalize_speech_text(clip['text'], language)
        if spoken != clip['text']:
            changes.append({'segmentId': clip['segment_id'], 'originalText': clip['text'], 'spokenText': spoken})
        output = Path(clip['output_path'])
        checkpoint = checkpoint_path / output.name if checkpoint_path is not None else None
        pending.append((index, clip, spoken, output, checkpoint))

    if type(expected_rate) is int and expected_rate > 0:
        pending = find_missing(pending, expected_rate)
    pulse.commit(len(quality))
    if pending:
        # Tokenizer and model lookup remain offline.
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ.setdefault('TQDM_DISABLE', '1')
        try:
            from voxcpm import VoxCPM
            model = VoxCPM.from_pretrained(str(options.model_path), local_files_only=True, load_denoiser=False,
                                           optimize=False, device=options.device)
            rate = model.tts_model.sample_rate
            if type(rate) is not int or rate <= 0 or expected_rate is not None and rate != expected_rate:
                raise ValueError('Unexpected model output sample rate')
        except Exception as exc:
            traceback.print_exc()
            if _out_of_memory(exc):
                return _fail('TTS_OUT_OF_MEMORY', '配音显存或内存不足，已保存的片段可续跑。')
            return _fail('MODEL_NOT_READY', f'The local VoxCPM2 model could not be loaded ({type(exc).__name__}).')
        if expected_rate is None:
            pending = find_missing(pending, rate)
            pulse.commit(len(quality) - pulse.saved)
        if raw_root is not None and pending:
            raw_root.mkdir(parents=True, exist_ok=True)

        def finish(index, clip, spoken, output, checkpoint, waveform, steps, retried):
            metrics = _save_clip(sf, waveform, rate, spoken, output, checkpoint, raw_root, language)
            pulse.commit(generated=True)
            return index, {'segmentId': clip['segment_id'], 'processedAudio': str(output),
                           'inferenceSteps': steps, 'qualityFallback': retried, **metrics}

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix='speech-cleanup') as processor:
            inflight = deque()
            for index, clip, spoken, output, checkpoint in pending:
                while inflight and (len(inflight) >= 2 or inflight[0].done()):
                    done, details = inflight.popleft().result()
                    quality[done] = details
                pulse.start(index)
                waveform, steps, retried = _generate(np, model, clip, spoken, reference_only,
                                                    performance == 'balanced', mandarin)
                if not _valid_waveform(np, waveform):
                    raise ValueError(f"VoxCPM2 returned an invalid waveform for {clip['segment_id']}")
                inflight.append(processor.submit(finish, index, clip, spoken, output, checkpoint, waveform, steps, retried))
            while inflight:
                done, details = inflight.popleft().result()
                quality[done] = details
    pulse.start(None)
    _write_json(options.request_path.parent / 'quality-report.json',
                {'enabled': cleanup_enabled, 'language': language, 'referenceOnly': reference_only,
                 'performance': performance, 'segments': [quality[index] for index in sorted(quality)],
                 'normalizedText': changes})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', type=Path, required=True)
    parser.add_argument('--request-path', type=Path, required=True)
    parser.add_argument('--device', required=True)
    options = parser.parse_args(argv)
    options.model_path = options.model_path.resolve()
    if not options.model_path.is_dir():
        return _fail('MODEL_NOT_READY', 'The local VoxCPM2 model directory is missing.')
    try:
        config = json.loads((options.model_path / 'config.json').read_text(encoding='utf-8'))
        if str(config.get('architecture', '')).lower() != 'voxcpm2':
            raise ValueError('VoxCPM2 architecture is required')
    except (OSError, ValueError, AttributeError):
        return _fail('MODEL_NOT_READY', 'The selected model is not a valid local VoxCPM2 model.')
    try:
        request = json.loads(options.request_path.read_text(encoding='utf-8'))
        clips = request['clips']
        cleanup_enabled = request.get('speech_cleanup', True)
        checkpoint_path = Path(request['checkpoint_path']) if 'checkpoint_path' in request else None
        language = request.get('target_language', 'zh')
        performance = request.get('speech_performance', 'quality')
        if type(cleanup_enabled) is not bool or not isinstance(language, str) or not language:
            raise ValueError('Invalid speech cleanup settings')
        if performance not in ('quality', 'balanced', 'nano1', 'nano2', 'nano4') or not isinstance(clips, list) or not clips:
            raise ValueError('Invalid speech generation settings')
        ids = set()
        for clip in clips:
            if not isinstance(clip['text'], str) or not clip['text'].strip() or clip['segment_id'] in ids:
                raise ValueError('Invalid speech clip')
            ids.add(clip['segment_id'])
            if not Path(clip['reference_path']).is_file():
                raise ValueError('Reference audio is missing')
            if not isinstance(clip['reference_text'], str) or not clip['reference_text'].strip():
                raise ValueError('Reference audio transcript is missing')
    except (OSError, ValueError, KeyError, TypeError):
        return _fail('INPUT_MISSING', 'The speech generation request or reference audio is invalid.')

    # Do not recategorize the runtime's FFmpeg DLL registration error.
    from backend.app.config import configure_windows_ffmpeg_dll_directory
    configure_windows_ffmpeg_dll_directory()
    try:
        if performance.startswith('nano'):
            if not options.device.startswith('cuda:'):
                return _fail('MODEL_NOT_READY', 'NanoVLLM 配音需要 CUDA 显卡。')
            if checkpoint_path is None:
                checkpoint_path = options.request_path.parent / 'checkpoint'
                checkpoint_path.mkdir(exist_ok=True)
            from backend.app.v1.tts_nano import run
            return asyncio.run(run(options, config, request, clips, cleanup_enabled, checkpoint_path, language, performance))
        return _generate_clips(options, config, request, clips, cleanup_enabled, checkpoint_path, language, performance)
    except Exception as exc:
        traceback.print_exc()
        if _out_of_memory(exc):
            return _fail('TTS_OUT_OF_MEMORY', '配音显存或内存不足，已保存的片段可续跑。')
        return _fail('INVALID_PROVIDER_RESULT', f'VoxCPM2 speech generation failed ({exc}).')


if __name__ == '__main__':
    raise SystemExit(main())
