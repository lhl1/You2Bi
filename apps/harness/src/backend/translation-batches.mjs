import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export function groupTranslation(items, maxItems, maxChars) {
  const groups = [];
  let batch = [], length = 0;
  for (const item of items) {
    if (batch.length && (batch.length >= maxItems || length + item.text.length > maxChars)) {
      groups.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(item);
    length += item.text.length;
  }
  if (batch.length) groups.push(batch);
  return groups;
}

export async function readTranslationJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export async function translationCheckpointFiles(directory) {
  try { return new Set(await readdir(directory)); }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
}

export async function saveTranslationJson(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value), { flag: 'wx' });
  await rename(temp, path);
}

export function translationProgress(total, context) {
  let saved = 0, reported = Promise.resolve();
  return count => {
    saved += count;
    const current = saved;
    reported = reported.then(() => context.progress(total ? current / total : 1, `已翻译 ${current} / ${total} 句`));
    return reported;
  };
}

export const translationRateLimited = error => error?.status === 429 || error?.code === 'RATE_LIMIT';

export function rateLimitDetails(ms) {
  return Number.isFinite(ms) && ms > 0 ? { retryAfterMs: Math.min(Math.ceil(ms), Number.MAX_SAFE_INTEGER - Date.now()) } : undefined;
}

// Let already-dispatched requests finish and save their work before returning the failure.
export async function runTranslationBatches(groups, parallelism, signal, translate, spacingMs = 0) {
  let next = 0, failure, stopped = false;
  let lastStart = -Infinity, turn = Promise.resolve();
  const canDispatch = () => !stopped && !signal.aborted;
  function dispatch(start) {
    if (!spacingMs) return canDispatch() ? start() : undefined;
    let request;
    const gate = turn.then(async () => {
      if (!canDispatch()) return;
      const wait = spacingMs - (performance.now() - lastStart);
      if (wait > 0) await delay(Math.ceil(wait), undefined, { signal });
      if (!canDispatch()) return;
      lastStart = performance.now();
      request = start();
      // Observe a fast rejection before releasing the start gate.
      void request.catch(stop);
    });
    turn = gate.catch(stop);
    return gate.then(() => request);
  }
  function stop(error) {
    stopped = true;
    if (!failure || translationRateLimited(error)) failure = error;
  }
  async function worker() {
    while (canDispatch() && next < groups.length) {
      const batch = groups[next++];
      try { await translate(batch, dispatch, canDispatch); }
      catch (error) { stop(error); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallelism, groups.length) }, worker));
  signal.throwIfAborted();
  if (failure) throw failure;
}

export function translationCooldowns() {
  const until = new Map();
  return {
    check(key) {
      const remaining = (until.get(key) ?? 0) - Date.now();
      if (remaining <= 0) { until.delete(key); return; }
      throw Object.assign(new Error(`翻译服务限流，${Math.ceil(remaining / 1000)} 秒后可继续。`),
        { code: 'RATE_LIMIT', status: 429, details: rateLimitDetails(remaining) });
    },
    note(key, error) {
      if (!translationRateLimited(error)) return;
      const time = Date.now() + (error.details?.retryAfterMs ?? 60_000);
      until.set(key, Math.max(time, until.get(key) ?? 0));
    },
  };
}
