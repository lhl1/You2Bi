"""Select confidently English spoken regions before transcription."""
from pathlib import Path

import numpy as np

RATE = 16_000
FRAME = 15_600
HOP = 7_680
SPEECH = {0, 1, 2, 3, 5, 12}
SINGING = {*range(24, 33), 249, 250}


def _scores(classifier, audio_data, samples):
    if len(samples) < FRAME:
        samples = np.pad(samples, (0, FRAME - len(samples)))
    result = classifier.classify(audio_data.create_from_array(samples, RATE))
    return {item.index: item.score for item in result[0].classifications[0].categories}


def _combine(ranges, start, end, reason, language=None):
    if end <= start:
        return
    if ranges and ranges[-1][1:] == (start, reason, language):
        ranges[-1] = (ranges[-1][0], end, reason, language)
    else:
        ranges.append((start, end, reason, language))


def _classify(source, vocals, classify):
    windows = []
    for start in range(0, len(source), HOP):
        center = start + HOP // 2
        left = max(0, center - FRAME // 2)
        original = classify(source[left:left + FRAME])
        voice = classify(vocals[left:left + FRAME])
        singing = max(max(original.get(i, 0), voice.get(i, 0)) for i in SINGING)
        speech = max(voice.get(i, 0) for i in SPEECH)
        windows.append((singing, speech))
    ranges = []
    for index, (singing, speech) in enumerate(windows):
        neighbors = windows[max(0, index - 1):index] + windows[index + 1:index + 2]
        protected = (singing >= .65 or singing >= .35 and any(score >= .35 for score, _ in neighbors)
                     or singing >= .25 and speech < .30)
        # The neighboring classifier window overlaps this cell. Preserve a
        # boundary cell if it contains evidence of a nearby sung phrase.
        if protected or singing >= .20 and any(score >= .65 for score, _ in neighbors):
            reason = 'singing'
        else:
            reason = 'uncertain' if singing >= .20 else 'speech' if speech >= .30 else 'no-dialogue'
        _combine(ranges, index * HOP, min(len(source), (index + 1) * HOP), reason)
    return ranges


def _localize(ranges, identify):
    selected = []
    for start, end, reason, _ in ranges:
        if reason != 'speech':
            _combine(selected, start, end, reason)
            continue
        # Anchor language decisions inside voiced regions. A single short foreign
        # interjection must never inherit the language of the whole video.
        for left in range(start, end, 2 * RATE):
            right = min(left + 2 * RATE, end)
            context_left = max(start, left - RATE // 2)
            context_right = min(end, right + RATE // 2)
            language, confidence, margin = identify(context_left, context_right) if context_right - context_left >= RATE else (None, 0, 0)
            decision = ('english' if language == 'en' else 'other-language') if confidence >= .75 and margin >= .15 else 'uncertain'
            _combine(selected, left, right, decision, language if decision != 'uncertain' else None)
    return selected


def transcribe_dialogue(whisper, model, model_path: Path, original: str, vocals: str, duration_ms: int):
    import mediapipe as mp

    source = whisper.load_audio(original)[:round(duration_ms * RATE / 1000)]
    voice = whisper.load_audio(vocals)
    if len(source) < round(duration_ms * RATE / 1000):
        source = np.pad(source, (0, round(duration_ms * RATE / 1000) - len(source)))
    options = mp.tasks.audio.AudioClassifierOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)))
    with mp.tasks.audio.AudioClassifier.create_from_options(options) as classifier:
        ranges = _classify(source, voice, lambda samples: _scores(classifier, mp.tasks.components.containers.AudioData, samples))

    def identify(start, end):
        mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(voice[start:end]), n_mels=model.dims.n_mels).to(model.device)
        _, probabilities = model.detect_language(mel)
        first, second = sorted(probabilities.items(), key=lambda item: item[1], reverse=True)[:2]
        return first[0], first[1], first[1] - second[1]

    segments, preserved = [], []
    for start, end, reason, language in _localize(ranges, identify):
        if reason == 'english' and end > start:
            result = model.transcribe(voice[start:end], language='en', task='transcribe', word_timestamps=True,
                                      fp16=str(model.device).startswith('cuda'))
            cursor = start / RATE
            for segment in result['segments']:
                lo = max(cursor, start / RATE + segment['start'])
                hi = min(end / RATE, start / RATE + segment['end'])
                if round(lo * 1000) >= round(hi * 1000) or not segment['text'].strip():
                    continue
                if cursor < lo:
                    _combine(preserved, round(cursor * RATE), round(lo * RATE), 'no-dialogue')
                local_start, local_end = round(lo * RATE), round(hi * RATE)
                candidate, confidence, margin = identify(local_start, local_end) if hi - lo >= 1.2 else (None, 0, 0)
                if candidate not in (None, 'en') and confidence >= .70 and margin >= .15:
                    _combine(preserved, local_start, local_end, 'other-language', candidate)
                else:
                    segments.append({'text': segment['text'], 'start': lo, 'end': hi})
                cursor = hi
            _combine(preserved, round(cursor * RATE), end, 'no-dialogue' if cursor > start / RATE else 'uncertain')
        else:
            _combine(preserved, start, end, reason, language)
    return {'language': 'en', 'segments': segments, 'preserved_ranges': [
        {'start_ms': round(start * 1000 / RATE), 'end_ms': round(end * 1000 / RATE), 'reason': reason,
         **({'language': language} if language else {})}
        for start, end, reason, language in preserved if round(end * 1000 / RATE) > round(start * 1000 / RATE)
    ]}
