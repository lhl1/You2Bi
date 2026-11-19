"""Bounded NanoVLLM speech generation with per-utterance references and durable WAVs."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re


async def run(options, config, request, clips, cleanup_enabled, checkpoint_path, language, performance):
    import numpy as np
    import soundfile as sf
    from transformers import LlamaTokenizerFast
    from nanovllm_voxcpm.models.voxcpm2.server import AsyncVoxCPM2ServerPool
    from nanovllm_voxcpm.models.voxcpm2.utils import mask_multichar_chinese_tokens
    from backend.app.v1.speech_text import normalize_speech_text
    from backend.app.v1.tts_process import (
        SpeechProgress, _atomic_replace, _save_clip, _valid_checkpoint, _valid_waveform, _write_json,
    )

    folder = options.request_path.parent
    rate = config['audio_vae_config']['out_sample_rate']
    pulse = SpeechProgress(folder / 'progress.json', len(clips))
    pending, results = [], []
    for index, clip in enumerate(clips, 1):
        output = Path(clip['output_path'])
        checkpoint = checkpoint_path / output.name
        if _valid_checkpoint(sf, checkpoint, rate):
            import shutil
            _atomic_replace(output, lambda partial: shutil.copyfile(checkpoint, partial))
            results.append({'segmentId': clip['segment_id'], 'resumed': True, 'index': index})
        else:
            pending.append((index, clip))
    pulse.commit(len(results))
    if not pending:
        pulse.start(None)
        _write_json(folder / 'quality-report.json', {'engine': performance, 'segments': results})
        return 0

    concurrency = {'nano2': 2, 'nano4': 4, 'nano1': 1}[performance]
    context_size = 2048 if concurrency == 4 else 4096
    tokenizer = mask_multichar_chinese_tokens(LlamaTokenizerFast.from_pretrained(options.model_path))
    raw = folder / 'raw' if cleanup_enabled else None
    if raw:
        raw.mkdir(exist_ok=True)
    device = int(options.device.split(':')[-1])
    server = AsyncVoxCPM2ServerPool(
        str(options.model_path), devices=[device], inference_timesteps=10,
        max_num_seqs=concurrency, gpu_memory_utilization=0.70,
        max_model_len=context_size, max_num_batched_tokens=4 * context_size,
    )
    gate = asyncio.Semaphore(concurrency)
    processor = asyncio.Lock()
    reference_only = language.lower().split('-')[0] == 'zh' and request.get('source_language') in ('en', 'ja')

    async def generate(index, clip):
        async with gate:
            pulse.start(index)
            spoken = re.sub(r'\s+', ' ', normalize_speech_text(clip['text'], language))
            reference_path = Path(clip['reference_path'])
            reference = await server.encode_latents(reference_path.read_bytes(), 'wav')
            prompt_text = '' if reference_only else clip['reference_text']
            tokens = len(tokenizer(prompt_text + spoken))
            limit = max(1, len(tokenizer(spoken)) * 6)
            reference_tokens = len(reference) // (4 * config['feat_dim'] * config['patch_size'])
            if reference_tokens + tokens + limit + 13 > context_size:
                raise ValueError(f"片段 {clip['segment_id']} 需要更大上下文")
            prompt = {} if reference_only else {'prompt_latents': reference, 'prompt_text': prompt_text}
            for attempt in range(3):
                parts = [chunk async for chunk in server.generate(
                    spoken, ref_audio_latents=reference, cfg_value=2.0,
                    max_generate_length=min(limit + 10, 4096), **prompt,
                )]
                waveform = np.concatenate(parts) if parts else np.empty(0, dtype=np.float32)
                if _valid_waveform(np, waveform) and len(parts) < limit:
                    break
            else:
                raise ValueError(f"片段 {clip['segment_id']} 生成结果无效")
            output = Path(clip['output_path'])
            async with processor:
                metrics = await asyncio.to_thread(
                    _save_clip, sf, waveform, rate, spoken, output, checkpoint_path / output.name, raw, language,
                )
                pulse.commit(generated=True)
            results.append({'segmentId': clip['segment_id'], 'index': index,
                            'inferenceSteps': 10, 'retries': attempt, **metrics})

    try:
        await asyncio.wait_for(server.wait_for_ready(), timeout=240)
        info = await server.get_model_info()
        if info['output_sample_rate'] != rate or info['channels'] != 1:
            raise ValueError('NanoVLLM 输出音频格式无效')
        # One task per worker bounds the number of outstanding requests.
        queue = asyncio.Queue()
        for item in pending:
            queue.put_nowait(item)

        async def worker():
            while not queue.empty():
                index, clip = queue.get_nowait()
                await generate(index, clip)

        async with asyncio.TaskGroup() as group:
            for _ in range(concurrency):
                group.create_task(worker())
    finally:
        await server.stop()
    pulse.start(None)
    _write_json(folder / 'quality-report.json', {
        'engine': performance, 'segments': sorted(results, key=lambda row: row['index']),
    })
    return 0

