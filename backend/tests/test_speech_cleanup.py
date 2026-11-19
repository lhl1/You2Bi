import numpy as np
import pytest
from scipy.signal import butter, sosfiltfilt
from backend.app.v1.speech_cleanup import cleanup

RATE = 48000


def tone(seconds, frequency=220, amplitude=.2):
    return (amplitude * np.sin(2 * np.pi * frequency * np.arange(round(seconds * RATE)) / RATE)).astype('float32')


def hiss(seconds, amplitude=.025):
    rng = np.random.default_rng(42)
    raw = rng.normal(size=round(seconds * RATE))
    high = sosfiltfilt(butter(3, 6000, fs=RATE, btype='highpass', output='sos'), raw)
    return (high / np.max(np.abs(high)) * amplitude).astype('float32')


def test_removes_quiet_edges_while_retaining_the_voiced_body_and_input():
    source = np.r_[np.zeros(round(RATE * .4)), tone(1), np.zeros(round(RATE * .5))].astype('float32')
    original = source.copy()
    output, report = cleanup(source, RATE, '我们到了。')
    assert np.array_equal(source, original)
    assert len(output) >= RATE
    assert report['headTrimMs'] >= 150 and report['tailTrimMs'] >= 200
    assert np.isfinite(output).all() and np.max(np.abs(output)) <= 1
    assert np.sqrt(np.mean(output ** 2)) > .1


def test_reduces_excessive_sibilance_without_removing_the_low_voice_band():
    source = tone(1) + hiss(1, amplitude=.35)
    output, report = cleanup(source, RATE, '是这样。')
    assert len(output) == len(source)
    lowpass = butter(3, 1000, fs=RATE, output='sos')
    highpass = butter(3, 6000, fs=RATE, btype='highpass', output='sos')
    low_before = np.sqrt(np.mean(sosfiltfilt(lowpass, source)[2000:-2000] ** 2))
    low_after = np.sqrt(np.mean(sosfiltfilt(lowpass, output)[2000:-2000] ** 2))
    high_before = np.sqrt(np.mean(sosfiltfilt(highpass, source)[2000:-2000] ** 2))
    high_after = np.sqrt(np.mean(sosfiltfilt(highpass, output)[2000:-2000] ** 2))
    assert .95 < low_after / low_before < 1.05
    assert high_after < high_before * .8
    assert 0 < report['maxDeessDb'] <= 7.01


def test_english_final_fricative_remains_after_the_voiced_vowel():
    source = np.r_[tone(.8), hiss(.3, .1), np.zeros(round(.15 * RATE))].astype('float32')
    output, report = cleanup(source, RATE, 'tests', language='en')
    assert len(output) >= round(1.1 * RATE)
    assert np.max(np.abs(output[round(.9 * RATE):round(1.05 * RATE)])) > .005


def test_short_voiced_interjection_before_a_pause_is_preserved():
    source = np.r_[tone(.08, amplitude=.025), np.zeros(round(.25 * RATE)), tone(.8)].astype('float32')
    output, report = cleanup(source, RATE, '嗯，我们到了。')
    assert report['detachedPrefixMs'] == 0 and report['headTrimMs'] == 0
    assert np.max(np.abs(output[:round(.08 * RATE)])) > .01


@pytest.mark.parametrize('source', [tone(.1), np.zeros(RATE, dtype='float32')])
def test_short_phonemes_and_complete_silence_are_not_truncated(source):
    output, report = cleanup(source, RATE)
    assert np.array_equal(output, source)
    assert report['outputSamples'] == len(source)


def test_long_internal_silence_is_shortened_but_both_phrases_survive():
    source = np.r_[tone(.5), np.zeros(round(.8 * RATE)), tone(.5, 330)].astype('float32')
    output, report = cleanup(source, RATE, '第一句，第二句。')
    assert 450 <= report['pauseReductionMs'] <= 650
    assert len(output) >= RATE
    assert np.sqrt(np.mean(output[:RATE // 3] ** 2)) > .1
    assert np.sqrt(np.mean(output[-RATE // 3:] ** 2)) > .1


@pytest.mark.parametrize('source', [np.array([]), np.array([np.nan]), np.array([np.inf]), np.ones(10) * 1.1, np.zeros((100, 2))])
def test_invalid_waveforms_are_rejected(source):
    with pytest.raises(ValueError):
        cleanup(source, RATE)
