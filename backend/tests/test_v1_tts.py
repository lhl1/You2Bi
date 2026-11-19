from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.app.v1 import media, tts, tts_process
from backend.app.v1.audio import audio_info
from backend.app.v1.audio_segments import read_speech_clips
from backend.app.v1.contracts import TaskConfig
from backend.app.v1.errors import ApiError
from backend.app.v1.segments import Transcript
from backend.app.v1.steps import StageContext
from backend.workers.protocol import WorkerError


@pytest.mark.parametrize("format,subtype", [("WAV", "PCM_16"), ("WAVEX", "FLOAT")])
def test_audio_info_accepts_pcm_and_ffmpeg_extensible_wave(tmp_path, format, subtype):
    path = tmp_path / "adjusted.wav"
    sf.write(path, np.full((4800, 2), 0.1, dtype=np.float32), 48000, format=format, subtype=subtype)
    info = audio_info(path, stage="tts")
    assert (info.format, info.frames, info.samplerate, info.channels) == (format, 4800, 48000, 2)


def test_audio_info_rejects_non_wave_with_file_and_metadata_in_error(tmp_path):
    path = tmp_path / "wrong.wav"
    sf.write(path, np.full(4800, 0.1), 48000, format="FLAC")
    with pytest.raises(ApiError, match="wrong.wav.*format=FLAC") as error:
        audio_info(path, stage="tts")
    assert error.value.content["error"]["code"] == "INVALID_PROVIDER_RESULT"


def prepare_references(context):
    transcript = Transcript.model_validate_json(context.input_files["transcript"].read_text())
    return tts.prepare_reference_audio(context, transcript, lambda *_: None)


@pytest.fixture
def context(tmp_path, monkeypatch):
    models = tmp_path / "VoxCPM2"
    models.mkdir()
    for name in ("tokenizer_config.json", "tokenizer.json", "model.safetensors", "audiovae.safetensors"):
        (models / name).write_bytes(b"test asset metadata")
    (models / "config.json").write_text('{"architecture":"voxcpm2"}')
    monkeypatch.setenv("YOUDUB_VOXCPM_MODEL_DIR", str(models))
    samples = np.arange(4 * 16000) / 16000
    source = tmp_path / "vocals.wav"
    sf.write(source, np.sin(2 * np.pi * 220 * samples) * (0.1 + samples * 0.03), 16000, subtype="PCM_16")
    transcript = {"detected_language": "en", "segments": [
        {"id": "one", "start_ms": 0, "end_ms": 1000, "text": "Original A1", "speaker_id": "speaker-a"},
        {"id": "two", "start_ms": 1000, "end_ms": 2000, "text": "Original B", "speaker_id": "speaker-b"},
        {"id": "three", "start_ms": 2000, "end_ms": 3500, "text": "Original A2", "speaker_id": "speaker-a"},
    ]}
    transcript_path, translation_path = tmp_path / "transcript.json", tmp_path / "translation.json"
    transcript_path.write_text(json.dumps(transcript))
    translation_path.write_text(json.dumps({"source_language": "en", "target_language": "zh", "segments": [
        {"segment_id": "three", "text": " 第三段。 "}, {"segment_id": "one", "text": " 第一段。\n"},
        {"segment_id": "two", "text": "第二段。"},
    ]}, ensure_ascii=False))
    config = TaskConfig.model_validate({
        "source_language": "en", "target_language": "zh", "output_mode": "both", "keep_background": False,
        "asr": {"adapter": "whisper", "model": "tiny", "device": "cpu"},
        "translation": {"adapter": "openai", "model": "test-model", "device": "remote"},
        "tts": {"adapter": "voxcpm", "model": "VoxCPM2", "device": "cpu", "voice": {"mode": "source_clone"}},
        "separation": {"adapter": "demucs", "model": "htdemucs", "device": "cpu"},
    })
    return StageContext(stage="tts", config=config,
                        input_files={"transcript": transcript_path, "translation": translation_path, "vocals": source},
                        work_dir=tmp_path / "work")


@pytest.fixture
def model_process(monkeypatch):
    real_run = media._run_media
    state = SimpleNamespace(commands=[], clips=[], output=True, invalid=False)

    def run(command, **kwargs):
        if len(command) < 2 or not command[1].endswith("tts_process.py"):
            return real_run(command, **kwargs)
        kwargs["check_cancel"]()
        state.commands.append(command)
        request_path = Path(command[command.index("--request-path") + 1])
        state.clips = json.loads(request_path.read_text())["clips"]
        for index, clip in enumerate(state.clips):
            if state.invalid:
                Path(clip["output_path"]).write_bytes(b"invalid WAV")
            elif state.output:
                rate = 24000 if index % 2 == 0 else 48000
                sf.write(clip["output_path"], np.full(rate // 4, 0.1), rate, subtype="PCM_16")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(media, "_run_media", run)
    return state


def test_model_inventory_requires_local_nonempty_asset_groups_only(context, monkeypatch):
    monkeypatch.setitem(sys.modules, "voxcpm", None)
    assert tts.available_models() == ["VoxCPM2"]
    root = tts.model_directory()
    (root / "model.safetensors").rename(root / "pytorch_model.bin")
    (root / "audiovae.safetensors").rename(root / "audiovae.pth")
    (root / "tokenizer.json").rename(root / "tokenizer.model")
    assert tts.available_models() == ["VoxCPM2"]
    (root / "audiovae.pth").write_bytes(b"")
    assert tts.available_models() == []
    monkeypatch.delenv("YOUDUB_VOXCPM_MODEL_DIR")
    assert tts.model_directory().parts[-3:] == ("models", "voxcpm", "VoxCPM2")


def test_tts_preserves_source_and_translation_and_clones_each_corresponding_utterance(context, model_process):
    before = {name: context.input_files[name].read_bytes() for name in ("transcript", "translation")}
    progress = []
    prepared = tts.prepare_reference_audio(
        context, Transcript.model_validate_json(before["transcript"]),
        lambda value, message: progress.append((value, message, len(list((context.work_dir / "tts/references").glob("*.wav"))))),
    )
    assert [value for value, _, _ in progress] == [0, 1 / 3, 2 / 3, 1]
    assert [count for _, _, count in progress] == [0, 1, 2, 3]
    assert progress[-1][1] == "Prepared source reference 3/3"
    result = tts.run(context, lambda *args: None, prepared_references=prepared)
    assert {name: context.input_files[name].read_bytes() for name in before} == before
    clips = model_process.clips
    assert [clip["segment_id"] for clip in clips] == ["one", "two", "three"]
    assert [clip["text"] for clip in clips] == [" 第一段。\n", "第二段。", " 第三段。 "]
    assert [clip["reference_text"] for clip in clips] == ["Original A1", "Original B", "Original A2"]
    assert len({clip["reference_path"] for clip in clips}) == 3
    source, rate = sf.read(context.input_files["vocals"])
    for clip, (start_ms, end_ms) in zip(clips, [(0, 1000), (1000, 2000), (2000, 3500)], strict=True):
        reference, reference_rate = sf.read(clip["reference_path"])
        assert reference_rate == rate == 16000
        assert np.array_equal(reference, source[start_ms * rate // 1000:end_ms * rate // 1000])
    transcript = Transcript.model_validate_json(before["transcript"])
    payload = read_speech_clips(result.output_files["speech_clips"], transcript)
    assert [clip.path for clip in payload.clips] == ["tts/000001.wav", "tts/000002.wav", "tts/000003.wav"]
    assert [clip.sample_rate_hz for clip in payload.clips] == [24000, 48000, 24000]
    assert all(clip.duration_ms == 250 and clip.channels == 1 for clip in payload.clips)
    command = model_process.commands[0]
    assert command[command.index("--model-path") + 1] == str(tts.model_directory().resolve())
    assert command[command.index("--device") + 1] == "cpu"


@pytest.mark.parametrize("speaker_id", [None, "speaker-a"])
def test_unknown_or_identical_speakers_still_use_each_utterances_own_audio_and_text(context, model_process, speaker_id):
    payload = json.loads(context.input_files["transcript"].read_text())
    for segment in payload["segments"]:
        if speaker_id is None:
            segment.pop("speaker_id")
        else:
            segment["speaker_id"] = speaker_id
    context.input_files["transcript"].write_text(json.dumps(payload))
    prepared = prepare_references(context)
    assert set(prepared) == {"one", "two", "three"}
    tts.run(context, lambda *args: None, prepared_references=prepared)
    assert len({clip["reference_path"] for clip in model_process.clips}) == 3
    source, rate = sf.read(context.input_files["vocals"])
    for clip, segment in zip(model_process.clips, payload["segments"], strict=True):
        assert clip["reference_text"] == segment["text"]
        reference, reference_rate = sf.read(clip["reference_path"])
        assert reference_rate == rate
        assert np.array_equal(reference, source[segment["start_ms"] * rate // 1000:segment["end_ms"] * rate // 1000])


@pytest.mark.parametrize("duration_ms", [1000, 10_000, 13_040])
def test_reference_uses_the_complete_corresponding_utterance_without_word_timestamps(context, model_process, duration_ms):
    payload = json.loads(context.input_files["transcript"].read_text())
    payload["segments"][2].update(start_ms=2000, end_ms=2000 + duration_ms)
    context.input_files["transcript"].write_text(json.dumps(payload))
    sf.write(context.input_files["vocals"], np.full(16000 * 16, 0.1), 16000, subtype="PCM_16")
    tts.run(context, lambda *args: None, prepared_references=prepare_references(context))
    assert sf.info(model_process.clips[2]["reference_path"]).duration == duration_ms / 1000
    assert model_process.clips[2]["reference_text"] == "Original A2"


@pytest.mark.parametrize("invalid", ["missing", "extra", "speaker-keys"])
def test_prepared_references_must_match_all_utterance_ids_before_inference(context, model_process, invalid):
    prepared = prepare_references(context)
    if invalid == "missing":
        prepared.pop("two")
    elif invalid == "extra":
        prepared["unrelated"] = prepared["one"]
    else:
        prepared = {"speaker-a": prepared["one"], "speaker-b": prepared["two"]}
    with pytest.raises(ApiError) as error:
        tts.run(context, lambda *args: None, prepared_references=prepared)
    assert error.value.content["error"]["code"] == "INVALID_MEDIA"
    assert "utterance IDs exactly" in error.value.content["error"]["message"]
    assert not model_process.commands
    assert not (context.work_dir / "tts" / "request.json").exists()


@pytest.fixture
def long_utterance_context(context):
    words = [{"start": 2 + index * 2, "end": 4 + index * 2, "word": text}
             for index, text in enumerate([" First,", " second,", " third,", " fourth,", " fifth,", " sixth."])]
    text = "".join(word["word"] for word in words)
    context.input_files["transcript"].write_text(json.dumps({"detected_language": "en", "segments": [
        {"id": "whole", "start_ms": 2000, "end_ms": 14_000, "text": text, "speaker_id": "speaker-a",
         "words": [{"text": w["word"], "start_ms": round(w["start"] * 1000), "end_ms": round(w["end"] * 1000)} for w in words]},
    ]}))
    context.input_files["translation"].write_text(json.dumps({
        "source_language": "en", "target_language": "zh", "segments": [
            {"segment_id": "whole", "text": "整句生成，连续表达，保留完整语气。"},
        ],
    }, ensure_ascii=False))
    samples = np.arange(16 * 16000) / 16000
    sf.write(context.input_files["vocals"], np.sin(2 * np.pi * 220 * samples) * 0.25,
             16000, subtype="PCM_16")
    return context


@pytest.mark.parametrize("word_timing", ["original", "overlap", "outside-segment"])
def test_long_utterance_keeps_its_complete_reference_even_with_word_timestamps(long_utterance_context, model_process, word_timing):
    context = long_utterance_context
    payload = json.loads(context.input_files["transcript"].read_text())
    words = payload["segments"][0]["words"]
    if word_timing == "overlap":
        words[1]["start_ms"] = 3000
    elif word_timing == "outside-segment":
        words[0]["start_ms"] = 1800
        words[-1]["end_ms"] = 14300
    context.input_files["transcript"].write_text(json.dumps(payload))
    before = {name: context.input_files[name].read_bytes() for name in ("transcript", "translation")}
    result = tts.run(context, lambda *args: None, prepared_references=prepare_references(context))
    assert {name: context.input_files[name].read_bytes() for name in before} == before
    assert len(model_process.commands) == len(model_process.clips) == 1
    clip = model_process.clips[0]
    assert clip["segment_id"] == "whole"
    assert clip["text"] == "整句生成，连续表达，保留完整语气。"
    assert clip["reference_text"] == " First, second, third, fourth, fifth, sixth."
    reference, rate = sf.read(clip["reference_path"])
    source, _ = sf.read(context.input_files["vocals"])
    assert len(reference) == 12 * rate
    assert np.array_equal(reference, source[2 * rate:14 * rate])
    transcript = Transcript.model_validate_json(before["transcript"])
    assert [item.segment_id for item in read_speech_clips(result.output_files["speech_clips"], transcript).clips] == ["whole"]


@pytest.mark.parametrize("invalid", ["word-text", "word-reversed"])
def test_reference_rejects_inconsistent_word_metadata_when_present(long_utterance_context, model_process, invalid):
    from pydantic import ValidationError
    context = long_utterance_context
    raw = json.loads(context.input_files["transcript"].read_text())
    segment = raw["segments"][0]
    if invalid == "word-text":
        segment["words"][0]["text"] = " Unrelated,"
    else:
        segment["words"][1]["start_ms"] = 7000
    context.input_files["transcript"].write_text(json.dumps(raw))
    with pytest.raises(ValidationError):
        prepare_references(context)
    assert not model_process.commands
    assert not (context.work_dir / "tts").exists()


@pytest.mark.parametrize("invalid", ["preset", "missing-vocals", "wrong-target", "missing-translation-id"])
def test_invalid_inputs_are_rejected_before_any_inference(context, model_process, invalid):
    if invalid == "preset":
        config = context.config.model_dump(mode="json")
        config["tts"]["voice"] = {"mode": "preset", "id": "unavailable"}
        config["separation"] = None
        context = replace(context, config=TaskConfig.model_validate(config))
    elif invalid == "missing-vocals":
        context.input_files["vocals"].unlink()
    else:
        payload = json.loads(context.input_files["translation"].read_text())
        if invalid == "wrong-target":
            payload["target_language"] = "ja"
        else:
            payload["segments"].pop()
        context.input_files["translation"].write_text(json.dumps(payload))
    with pytest.raises(ApiError):
        tts.run(context, lambda *args: None, prepared_references=prepare_references(context))
    assert not model_process.commands
    assert not (context.work_dir / "speech_clips.json").exists()


@pytest.mark.parametrize("invalid", [False, True])
def test_missing_or_invalid_generated_wav_cannot_publish_clip_manifest(context, model_process, invalid):
    model_process.output = False
    model_process.invalid = invalid
    with pytest.raises(ApiError) as error:
        tts.run(context, lambda *args: None, prepared_references=prepare_references(context))
    assert error.value.content["error"]["code"] == ("INVALID_PROVIDER_RESULT" if invalid else "STAGE_OUTPUT_MISSING")
    assert not (context.work_dir / "speech_clips.json").exists()


def test_cancel_terminates_and_reaps_actual_tts_process(context, monkeypatch):
    real_popen = subprocess.Popen
    children = []
    checks = 0

    def popen(command, **kwargs):
        if len(command) > 1 and command[1].endswith("tts_process.py"):
            process = real_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
            children.append(process)
            return process
        return real_popen(command, **kwargs)

    def cancel():
        nonlocal checks
        if children:
            checks += 1
            if checks == 2:
                raise WorkerError("CANCELLED", "The host cancelled this invocation.")

    monkeypatch.setattr(media.subprocess, "Popen", popen)
    with pytest.raises(WorkerError, match="The host cancelled this invocation") as error:
        tts.run(replace(context, check_cancel=cancel), lambda *args: None, prepared_references=prepare_references(replace(context, check_cancel=cancel)))
    assert error.value.code == "CANCELLED"
    assert len(children) == 1 and children[0].poll() is not None
    assert not (context.work_dir / "speech_clips.json").exists()


def child_request(context):
    clips = [{"segment_id": str(index), "text": text, "reference_path": str(context.input_files["vocals"]),
              "reference_text": " Source reference transcript.\n",
              "output_path": str(context.work_dir.parent / f"child-{index}.wav")}
             for index, text in enumerate([" 精确译文。\n", "Second exact text."])]
    path = context.work_dir.parent / "request.json"
    path.write_text(json.dumps({"clips": clips}, ensure_ascii=False))
    return clips, ["--model-path", str(tts.model_directory()), "--request-path", str(path), "--device", "cpu"]


def test_child_loads_local_model_once_and_calls_generate_once_per_exact_text(context, monkeypatch):
    from backend.app import config

    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "0")
    loaded, generated, configured = [], [], []
    monkeypatch.setattr(config, "configure_windows_ffmpeg_dll_directory", lambda: configured.append(True))

    def generate(**kwargs):
        generated.append(kwargs)
        return np.full(4800, 0.25)

    def load(*args, **kwargs):
        assert configured == [True]
        loaded.append((args, kwargs))
        return SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000), generate=generate)

    monkeypatch.setitem(sys.modules, "voxcpm", SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=load)))
    clips, arguments = child_request(context)
    assert tts_process.main(arguments) == 0
    assert loaded == [((str(tts.model_directory().resolve()),), {
        "local_files_only": True, "load_denoiser": False, "optimize": False, "device": "cpu",
    })]
    assert generated == [{"text": clip["text"], "reference_wav_path": clip["reference_path"],
                          "prompt_wav_path": clip["reference_path"], "prompt_text": clip["reference_text"],
                          "normalize": False, "denoise": False, "retry_badcase": True} for clip in clips]
    assert all(sf.info(clip["output_path"]).samplerate == 48000 for clip in clips)
    assert all(sf.info(clip["output_path"]).frames == 4800 for clip in clips)


def test_child_keeps_raw_takes_and_report_and_does_not_overwrite_previous_backup(context, monkeypatch):
    from backend.app import config
    monkeypatch.setattr(config, 'configure_windows_ffmpeg_dll_directory', lambda: None)
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        amplitude = .2 if len(calls) <= 2 else .3
        body = amplitude * np.sin(2 * np.pi * 220 * np.arange(48000) / 48000)
        return np.r_[np.zeros(19200), body, np.zeros(19200)]
    monkeypatch.setitem(sys.modules, 'voxcpm', SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=lambda *a, **k: SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000), generate=generate))))
    clips, arguments = child_request(context)
    assert tts_process.main(arguments) == 0
    request = Path(arguments[arguments.index('--request-path') + 1])
    report = json.loads((request.parent / 'quality-report.json').read_text('utf-8'))
    raw_paths = [Path(item['rawAudio']) for item in report['segments']]
    before = [path.read_bytes() for path in raw_paths]
    for item, clip in zip(report['segments'], clips, strict=True):
        assert sf.info(item['rawAudio']).frames > sf.info(clip['output_path']).frames
        assert item['inputSamples'] == sf.info(item['rawAudio']).frames
    assert tts_process.main(arguments) == 0
    assert [path.read_bytes() for path in raw_paths] == before
    assert len(list((request.parent / 'raw').glob('*.wav'))) == 4


@pytest.mark.parametrize('source_language', ['zh', 'en'])
def test_child_cleanup_can_be_disabled_without_changing_the_original_take(context, monkeypatch, source_language):
    from backend.app import config
    monkeypatch.setattr(config, 'configure_windows_ffmpeg_dll_directory', lambda: None)
    waveform = np.full(4800, .25)
    generated = []

    def generate(**kwargs):
        generated.append(kwargs)
        return waveform

    monkeypatch.setitem(sys.modules, 'voxcpm', SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=lambda *a, **k: SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000), generate=generate))))
    clips, arguments = child_request(context)
    clips[0]['text'] = '涨幅 12.5%，用了 8GB。'
    path = Path(arguments[arguments.index('--request-path') + 1])
    path.write_text(json.dumps({'clips': clips, 'speech_cleanup': False, 'source_language': source_language, 'target_language': 'zh-CN'}), 'utf-8')
    assert tts_process.main(arguments) == 0
    assert not (path.parent / 'raw').exists()
    assert np.array_equal(sf.read(clips[0]['output_path'])[0], waveform)
    report = json.loads((path.parent / 'quality-report.json').read_text('utf-8'))
    assert report['enabled'] is False
    assert generated[0]['text'] == '涨幅 百分之十二点五，用了 八吉字节。'
    assert generated[0]['reference_wav_path'] == clips[0]['reference_path']
    assert report['referenceOnly'] is (source_language == 'en')
    if source_language == 'en':
        assert 'prompt_text' not in generated[0] and 'prompt_wav_path' not in generated[0]
    else:
        assert generated[0]['prompt_text'] == clips[0]['reference_text']
    assert report['normalizedText'] == [{'segmentId': clips[0]['segment_id'], 'originalText': clips[0]['text'],
                                         'spokenText': generated[0]['text']}]


def test_child_resumes_only_unfinished_clips(context, monkeypatch):
    from backend.app import config

    monkeypatch.setattr(config, 'configure_windows_ffmpeg_dll_directory', lambda: None)
    clips, arguments = child_request(context)
    path = Path(arguments[arguments.index('--request-path') + 1])
    cache = path.parent / 'cache'
    cache.mkdir()
    path.write_text(json.dumps({'clips': clips, 'speech_cleanup': False, 'checkpoint_path': str(cache)}), 'utf-8')
    generated = []
    interrupted = True

    def generate(**kwargs):
        generated.append(kwargs['text'])
        if interrupted and len(generated) == 2:
            raise RuntimeError('interrupted')
        return np.full(4800, .25)

    model = SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000), generate=generate)
    monkeypatch.setitem(sys.modules, 'voxcpm', SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=lambda *a, **k: model)))
    assert tts_process.main(arguments) == 1
    first = Path(clips[0]['output_path'])
    expected = first.read_bytes()
    first.unlink()
    interrupted = False
    generated.clear()
    assert tts_process.main(arguments) == 0
    assert generated == [clips[1]['text']]
    assert first.read_bytes() == expected


def test_full_legacy_wav_checkpoint_skips_model_load(context, monkeypatch):
    clips, arguments = child_request(context)
    path = Path(arguments[arguments.index('--request-path') + 1])
    cache = path.parent / 'cache'
    cache.mkdir()
    (tts.model_directory() / 'config.json').write_text(json.dumps({
        'architecture': 'voxcpm2', 'audio_vae_config': {'out_sample_rate': 48000},
    }))
    path.write_text(json.dumps({'clips': clips, 'checkpoint_path': str(cache)}), 'utf-8')
    for clip in clips:
        sf.write(cache / Path(clip['output_path']).name, np.full(4800, .25), 48000, subtype='PCM_16')
    monkeypatch.setitem(sys.modules, 'voxcpm', None)
    assert tts_process.main(arguments) == 0
    assert all(Path(clip['output_path']).read_bytes() == (cache / Path(clip['output_path']).name).read_bytes()
               for clip in clips)
    snapshot = json.loads((path.parent / 'progress.json').read_text('utf-8'))
    assert snapshot['saved'] == len(clips) and snapshot['current'] is None


def test_balanced_uses_one_reference_encoding_for_a_ten_step_fallback_and_protects_short_replies(context, monkeypatch):
    clips, arguments = child_request(context)
    clips[0]['text'], clips[1]['text'] = '这段文字适合使用均衡配音。', '好的。'
    path = Path(arguments[arguments.index('--request-path') + 1])
    path.write_text(json.dumps({'clips': clips, 'target_language': 'zh', 'source_language': 'en',
                               'speech_performance': 'balanced', 'speech_cleanup': False}), 'utf-8')
    encoded, calls, direct = [], [], []
    cache = object()

    def encode(**inputs):
        encoded.append(inputs)
        return cache

    def cached(**kwargs):
        calls.append(kwargs)
        data = np.full(4800, .25)
        audio = SimpleNamespace(squeeze=lambda _: SimpleNamespace(cpu=lambda: SimpleNamespace(numpy=lambda: data)))
        return audio, SimpleNamespace(numel=lambda: 10), SimpleNamespace(shape=(60, 4, 8))

    def short(**kwargs):
        direct.append(kwargs)
        return np.full(4800, .25)

    engine = SimpleNamespace(sample_rate=48000, build_prompt_cache=encode, generate_with_prompt_cache=cached)
    model = SimpleNamespace(tts_model=engine, generate=short)
    monkeypatch.setitem(sys.modules, 'voxcpm', SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=lambda *a, **k: model)))
    assert tts_process.main(arguments) == 0
    assert encoded == [{'reference_wav_path': clips[0]['reference_path']}]
    assert [(call['inference_timesteps'], call['retry_badcase']) for call in calls] == [(8, False), (10, True)]
    assert all(call['prompt_cache'] is cache for call in calls)
    assert [call['text'] for call in direct] == ['好的。']
    report = json.loads((path.parent / 'quality-report.json').read_text('utf-8'))
    assert [(row['inferenceSteps'], row['qualityFallback']) for row in report['segments']] == [(10, True), (10, False)]


def test_oom_keeps_the_previous_clip_saved(context, monkeypatch, capsys):
    clips, arguments = child_request(context)
    path = Path(arguments[arguments.index('--request-path') + 1])
    cache = path.parent / 'cache'
    cache.mkdir()
    path.write_text(json.dumps({'clips': clips, 'speech_cleanup': False, 'checkpoint_path': str(cache)}), 'utf-8')

    def generate(**kwargs):
        if kwargs['text'] == clips[1]['text']:
            raise RuntimeError('CUDA out of memory')
        return np.full(4800, .25)

    model = SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000), generate=generate)
    monkeypatch.setitem(sys.modules, 'voxcpm', SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=lambda *a, **k: model)))
    assert tts_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])['code'] == 'TTS_OUT_OF_MEMORY'
    assert [file.name for file in cache.glob('*.wav')] == [Path(clips[0]['output_path']).name]
    assert json.loads((path.parent / 'progress.json').read_text('utf-8'))['saved'] == 1


def test_report_uses_only_committed_count_and_reports_rate_and_eta(context, monkeypatch):
    reports = []
    path = context.work_dir.parent / 'progress.json'
    clock = iter([10, 11, 12])
    monkeypatch.setattr(tts, 'monotonic', lambda: next(clock))
    monitor = tts._monitor_progress(path, 10, context, lambda *args: reports.append(args))
    path.write_text(json.dumps({'saved': 3, 'current': 5, 'clipsPerMinute': 20, 'remainingSeconds': 21}))
    monitor()
    monitor()
    monitor()
    assert reports == [(0.3, '已保存 3/10 段配音 · 正在处理第 5 段 · 20 段/分钟 · 预计剩余 0分21秒')]


def test_child_preserves_ffmpeg_dll_error_before_importing_model(context, monkeypatch):
    from backend.app import config

    original = RuntimeError("Failed to register the FFmpeg DLL directory: C:/YouDub/runtime/ffmpeg/bin")

    def configure():
        raise original

    monkeypatch.setattr(config, "configure_windows_ffmpeg_dll_directory", configure)
    monkeypatch.setitem(sys.modules, "voxcpm", None)
    clips, arguments = child_request(context)
    with pytest.raises(RuntimeError) as result:
        tts_process.main(arguments)
    assert result.value is original
    assert not any(Path(clip["output_path"]).exists() for clip in clips)


@pytest.mark.parametrize("reference_text", [None, "", " \n", 12])
def test_child_rejects_missing_reference_transcript_before_model_loading(context, monkeypatch, capsys, reference_text):
    loaded = []
    monkeypatch.setitem(sys.modules, "voxcpm", SimpleNamespace(VoxCPM=SimpleNamespace(
        from_pretrained=lambda *args, **kwargs: loaded.append(True))))
    clips, arguments = child_request(context)
    clips[0]["reference_text"] = reference_text
    request_path = Path(arguments[arguments.index("--request-path") + 1])
    request_path.write_text(json.dumps({"clips": clips}))
    assert tts_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "INPUT_MISSING"
    assert not loaded
    assert not any(Path(clip["output_path"]).exists() for clip in clips)


def test_child_missing_model_package_is_explicit(context, monkeypatch, capsys):
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "0")
    monkeypatch.setitem(sys.modules, "voxcpm", None)
    clips, arguments = child_request(context)
    assert tts_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "MODEL_NOT_READY"
    assert not any(Path(clip["output_path"]).exists() for clip in clips)


@pytest.mark.parametrize("waveform", [np.array([]), np.array([float("nan")]), np.array([1.1]), np.zeros((2, 100))])
def test_child_invalid_model_output_is_not_retried(context, monkeypatch, capsys, waveform):
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "0")
    calls = []

    def generate(**kwargs):
        calls.append(kwargs)
        return waveform

    monkeypatch.setitem(sys.modules, "voxcpm", SimpleNamespace(VoxCPM=SimpleNamespace(
        from_pretrained=lambda *args, **kwargs: SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000), generate=generate))))
    clips, arguments = child_request(context)
    assert tts_process.main(arguments) == 1
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["code"] == "INVALID_PROVIDER_RESULT"
    assert len(calls) == 1
    assert not any(Path(clip["output_path"]).exists() for clip in clips)


def test_nano_failure_retries_with_lower_concurrency_and_shared_checkpoint(context, model_process, monkeypatch):
    context.config.speech_performance = 'nano4'
    context.config.tts.device = 'cuda:0'
    from backend.app.paths import data_directory
    executable = data_directory() / 'runtime/nano-voxcpm/Scripts/python.exe'
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b'test')
    original = media._run_media
    attempts = []

    def run(command, **kwargs):
        if len(command) > 1 and command[1].endswith('tts_process.py'):
            request_path = Path(command[command.index('--request-path') + 1])
            request = json.loads(request_path.read_text('utf-8'))
            attempts.append((request['speech_performance'], request['checkpoint_path']))
            if len(attempts) == 1:
                return subprocess.CompletedProcess(command, 1, '', 'KV cache allocation failed')
        return original(command, **kwargs)

    monkeypatch.setattr(media, '_run_media', run)
    transcript = Transcript.model_validate_json(context.input_files['transcript'].read_bytes())
    prepared = tts.prepare_reference_audio(context, transcript, lambda *_: None)
    result = tts.run(context, lambda *_: None, prepared_references=prepared,
                     checkpoint_root=context.work_dir / 'cache')
    assert result.output_files['speech_clips'].is_file()
    assert [profile for profile, _ in attempts] == ['nano4', 'nano2']
    assert len({checkpoint for _, checkpoint in attempts}) == 1


def test_progress_polling_limits_events_and_keeps_cancellation_checks(context, monkeypatch):
    reports, cancellations = [], []
    path = context.work_dir.parent / 'progress.json'
    clock = iter([10, 11, 13])
    monkeypatch.setattr(tts, 'monotonic', lambda: next(clock))
    from dataclasses import replace
    monitored = replace(context, check_cancel=lambda: cancellations.append(True))
    monitor = tts._monitor_progress(path, 10, monitored, lambda *args: reports.append(args))
    for saved in (1, 2, 3):
        path.write_text(json.dumps({'saved': saved, 'current': saved + 1}), 'utf-8')
        monitor()
    assert [value for value, _ in reports] == [.1, .3]
    assert len(cancellations) == 3

