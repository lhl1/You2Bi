"""Conservative, pitch-preserving cleanup for newly generated speech.
Raw synthesis is backed up by the caller before applying these operations.
"""
from __future__ import annotations
import numpy as np
from scipy.ndimage import gaussian_filter1d, uniform_filter1d
from scipy.signal import butter, sosfiltfilt, resample_poly


def cleanup(samples, rate, text='', *, language='zh'):
    """Keep voiced content and consonant guards; attenuate excessive sibilance."""
    if type(rate) is not int or not 8000 <= rate <= 192000:
        raise ValueError('Unsupported speech sample rate')
    samples = np.asarray(samples, dtype='float32')
    if samples.ndim != 1 or not samples.size or not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1:
        raise ValueError('Expected a finite mono speech waveform within unit amplitude')
    mono = samples
    untouched = {'headTrimMs': 0, 'tailTrimMs': 0, 'pauseReductionMs': 0,
                 'detachedPrefixMs': 0, 'maxDeessDb': 0, 'headroomGain': 1,
                 'inputSamples': len(mono), 'outputSamples': len(mono)}
    if len(mono) < rate // 4:
        return mono.copy(), {**untouched, 'skipped': 'short'}
    if np.max(np.abs(mono)) < 1e-6:
        return mono.copy(), {**untouched, 'skipped': 'silent'}
    analysis = resample_poly(mono, 16000, rate)
    core = sosfiltfilt(butter(4, [100, 3000], fs=16000, btype='bandpass', output='sos'), analysis)
    win, hop = 480, 160
    frames = np.lib.stride_tricks.sliding_window_view(core, win)[::hop]
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    z = frames * np.hanning(win)
    spectrum = np.fft.rfft(z, n=1024, axis=1)
    correlation = np.fft.irfft(abs(spectrum) ** 2, n=1024, axis=1)
    periodicity = np.max(correlation[:, 32:240], axis=1) / (correlation[:, 0] + 1e-10)
    voiced = (rms > max(np.percentile(rms, 90) * .12, .002)) & (periodicity > .3)
    stable = np.convolve(voiced.astype(float), np.ones(5), mode='same') >= 3
    # Continuation synthesis can leave a faint isolated phoneme before a silence.
    # A real initial consonant stays attached to its vowel; retain interjections.
    detached_prefix_ms = 0
    full_frames = np.lib.stride_tricks.sliding_window_view(analysis, win)[::hop]
    full_rms = np.sqrt(np.mean(full_frames ** 2, axis=1))
    # English/Japanese endings can contain long legitimate voiceless consonants.
    # Use energy boundaries there instead of Mandarin voiced-vowel boundaries.
    mandarin = language.split('-')[0].lower() == 'zh'
    if not mandarin:
        energy_activity = full_rms > max(np.percentile(full_rms, 90) * .035, .0006)
        stable = np.convolve(energy_activity.astype(float), np.ones(3), mode='same') >= 2
    active = full_rms > max(np.percentile(full_rms, 90) * .08, .0015)
    changes = np.diff(np.r_[False, active, False].astype(int))
    islands = list(zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1)))
    if mandarin and len(islands) > 1 and not text.lstrip('“\"「（(').startswith(tuple('嗯呃哦啊唉哎欸诶哼哈嘿')):
        first, second = islands[:2]
        left, right = first
        if ((right - left) * .01 <= .10 and (second[0] - right) * .01 >= .14
                and np.max(full_rms[left:right]) < np.percentile(full_rms, 90) * .35):
            stable[:second[0]] = False
            detached_prefix_ms = round(second[0] * 10)
    indices = np.flatnonzero(stable)
    start, end = 0, len(mono)
    if len(indices):
        # Guard voiceless initial consonants and the final vowel/decay.
        start = max(0, round((indices[0] * hop / 16000 - .18) * rate))
        end = min(len(mono), round(((indices[-1] * hop + win) / 16000 + .11) * rate))
        # Uncertain short/mostly unvoiced material keeps its complete waveform.
        if end - start < min(.35 * rate, len(mono) * .75) or end - start < len(mono) * .55:
            start, end = 0, len(mono)
    y = mono[start:end].copy()
    pause_reduction = 0
    # Shorten only long near-silent internal gaps, keeping 240 ms of breathing room.
    frame = max(1, rate // 100)
    count = len(y) // frame
    if count > 60:
        energy = np.sqrt(np.mean(y[:count * frame].reshape(count, frame) ** 2, axis=1))
        quiet = energy < min(.004, max(.001, np.percentile(energy, 90) * .03))
        transitions = np.diff(np.r_[False, quiet, False].astype(int))
        runs = list(zip(np.flatnonzero(transitions == 1), np.flatnonzero(transitions == -1)))
        for left, right in reversed(runs):
            if right - left < 50 or left < 20 or right > count - 20:
                continue
            cut_start, cut_end = (left + 12) * frame, (right - 12) * frame
            width = min(round(.008 * rate), cut_start, len(y) - cut_end)
            if width:
                y[cut_start - width:cut_start] *= np.linspace(1, 0, width)
                y[cut_end:cut_end + width] *= np.linspace(0, 1, width)
            y = np.concatenate([y[:cut_start], y[cut_end:]])
            pause_reduction += cut_end - cut_start
    # A dynamic high-band reduction keeps vowels and the lower voice spectrum intact.
    high = sosfiltfilt(butter(2, min(4200, rate * .4), fs=rate, btype='highpass', output='sos'), y)
    window = max(1, round(rate * .015))
    full_power = uniform_filter1d(y ** 2, window, mode='nearest')
    high_power = uniform_filter1d(high ** 2, window, mode='nearest')
    ratio = np.sqrt(np.maximum(0, high_power) / (np.maximum(0, full_power) + 1e-12))
    activity = np.clip((np.sqrt(np.maximum(0, high_power)) - .0008) / .002, 0, 1)
    reduction_db = np.clip((ratio - .28) / .45, 0, 1) * activity * 7
    reduction_db = gaussian_filter1d(reduction_db, max(1, round(.009 * rate)))
    gain = 10 ** (-reduction_db / 20)
    y = y - high * (1 - gain)
    fade = min(round(rate * .010), len(y) // 8)
    if fade:
        ramp = np.sin(np.linspace(0, np.pi / 2, fade)) ** 2
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]
    peak = float(np.max(np.abs(y)))
    headroom = min(1, .999 / peak) if peak else 1
    y *= headroom
    return y.astype('float32'), {'headTrimMs': round(start * 1000 / rate),
        'tailTrimMs': round((len(mono) - end) * 1000 / rate),
        'pauseReductionMs': round(pause_reduction * 1000 / rate),
        'detachedPrefixMs': detached_prefix_ms,
        'headroomGain': headroom, 'inputSamples': len(mono), 'outputSamples': len(y),
        'maxDeessDb': round(float(np.max(reduction_db)), 2)}

