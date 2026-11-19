import json
import subprocess
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.app.config import ffmpeg_binary
from backend.app.v1 import dialogue, export, mix
from backend.app.v1.steps import StageContext


def test_audio_classifier_distinguishes_singing_from_speech_with_background_music():
    spans = iter([
        {24: .8}, {0: .9},  # Speech and singing overlap: protect the full cell.
        {24: .4}, {0: .8},
        {132: .9}, {0: .85},  # Instrumental background alone permits speech.
    ])
    signal = np.zeros(3 * dialogue.HOP, dtype=np.float32)
    classified = dialogue._classify(signal, signal, lambda _: next(spans))
    assert [span[2] for span in classified] == ['singing', 'speech']


def test_local_language_switches_leave_uncertain_and_foreign_audio_untouched():
    rate = dialogue.RATE
    scores = iter([('en', .95, .9), ('ja', .94, .91), ('zh', .9, .8), ('en', .45, .1)])
    result = dialogue._localize([(0, 8 * rate, 'speech', None)], lambda *_: next(scores))
    assert [(span[2], span[3]) for span in result] == [('english', 'en'), ('other-language', 'ja'), ('other-language', 'zh'), ('uncertain', None)]


def test_unaccompanied_singing_and_ambiguous_overlay_are_preserved():
    labels = iter([{24: .31}, {0: .10}, {24: .23}, {0: .82}])
    signal = np.zeros(2 * dialogue.HOP, dtype=np.float32)
    ranges = dialogue._classify(signal, signal, lambda _: next(labels))
    assert [span[2] for span in ranges] == ['singing', 'uncertain']


@pytest.mark.parametrize('english', [True, False])
def test_mix_preserves_original_samples_and_reverts_a_dub_that_does_not_fit(tmp_path, english):
    rate = mix.SAMPLE_RATE
    source = np.repeat(np.round(np.sin(np.arange(4 * rate) * .15) * 2_000).astype(np.int16)[:, None], 2, axis=1)
    original = tmp_path / 'original.wav'
    sf.write(original, source, rate)
    rows = [{'id': 'fits', 'text': 'First', 'start_ms': 0, 'end_ms': 1000},
            {'id': 'too-long', 'text': 'Second', 'start_ms': 2000, 'end_ms': 3000}] if english else []
    regions = [{'start_ms': 1000, 'end_ms': 2000, 'reason': 'other-language', 'language': 'ja'},
               {'start_ms': 3000, 'end_ms': 4000, 'reason': 'singing'}] if english else [{'start_ms': 0, 'end_ms': 4000, 'reason': 'singing'}]
    clips = []
    for segment, milliseconds in zip(rows, [400, 2500]):
        filename = segment['id'] + '.wav'
        sf.write(tmp_path / filename, np.full(round(milliseconds * rate / 1000), 7_000, dtype=np.int16), rate)
        clips.append({'segment_id': segment['id'], 'path': filename, 'duration_ms': milliseconds, 'sample_rate_hz': rate, 'channels': 1})
    files = {'original': original}
    for name, payload in [('media_info', {'duration_ms': 4000}), ('speech_clips', {'clips': clips}),
                          ('transcript', {'detected_language': 'en', 'segments': rows, 'preserved_ranges': regions})]:
        files[name] = tmp_path / (name + '.json')
        files[name].write_text(json.dumps(payload), 'utf-8')
    context = StageContext('mix', SimpleNamespace(max_speech_rate=1.5, keep_background=False), files, tmp_path)
    output = mix.run_selective(context, lambda *_: None).output_files
    samples, _ = sf.read(output['mixed_audio'], dtype='int16')
    timeline = json.loads(output['alignment'].read_text('utf-8'))
    assert np.corrcoef(source[rate:, 0], samples[rate:, 0])[0, 1] > .99
    assert np.array_equal(source[:rate], samples[:rate]) is (not english)
    assert [row['segment_id'] for row in timeline['segments']] == (['fits'] if english else [])
    assert [row['reason'] for row in timeline['timing_fallbacks']] == (['timing'] if english else [])


def test_export_with_no_dub_has_original_audio_and_no_subtitle_filter(tmp_path):
    video = tmp_path / 'source.mp4'
    subprocess.run([ffmpeg_binary(), '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'color=blue:s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=1',
                    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(video)], check=True)
    mix_audio = tmp_path / 'mixed.wav'
    samples = np.sin(np.arange(mix.SAMPLE_RATE) * .2) * .20
    sf.write(mix_audio, samples, mix.SAMPLE_RATE)
    files = {'video': video, 'mixed_audio': mix_audio}
    for name, data in {'media_info': {'duration_ms': 1000, 'width': 64, 'height': 64},
                       'transcript': {'detected_language': 'en', 'segments': [], 'preserved_ranges': [
                           {'start_ms': 0, 'end_ms': 1000, 'reason': 'singing'}]},
                       'translation': {'source_language': 'en', 'target_language': 'zh', 'segments': []},
                       'alignment': {'segments': [], 'timing_fallbacks': []}}.items():
        files[name] = tmp_path / f'{name}.json'
        files[name].write_text(json.dumps(data), 'utf-8')
    context = StageContext('export', SimpleNamespace(selective=True, target_language='zh', output_mode='both'), files, tmp_path)
    result = export.run(context, lambda *_: None, output_dir=tmp_path / 'out').output_files
    assert set(result) == {'video', 'audio'}
    assert result['video'].stat().st_size > 0
    assert result['audio'].read_bytes() == mix_audio.read_bytes()
