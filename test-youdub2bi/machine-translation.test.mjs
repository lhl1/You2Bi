import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { machineTranslate, translateWithMachine } from '../apps/harness/src/backend/machine-translation.mjs';
import { translationCooldowns } from '../apps/harness/src/backend/translation-batches.mjs';

test('Google web mode uses the reference endpoint without credentials and reassembles fragments', async () => {
  const result = await machineTranslate('google-free', {}, undefined, ['Hello, world.'], 'en', 'zh', undefined, async (address, request) => {
    const url = new URL(address);
    assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
    assert.equal(url.searchParams.get('client'), 'gtx');
    assert.equal(url.searchParams.get('tl'), 'zh-CN');
    assert.equal(url.searchParams.get('q'), 'Hello, world.');
    assert.equal(request.method, 'GET');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.headers, undefined);
    return Response.json([[['你好，', 'Hello, '], ['世界。', 'world.']]]);
  });
  assert.deepEqual(result, ['你好，世界。']);
});

test('Microsoft uses the F0-compatible API and maps Simplified Chinese; wrong result count fails', async () => {
  const request = (count) => async (address, init) => {
    assert.equal(new URL(address).searchParams.get('to'), 'zh-Hans');
    assert.equal(init.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
    assert.deepEqual(JSON.parse(init.body), [{ Text: 'hello' }, { Text: 'bye' }]);
    return Response.json(['你好', '再见'].slice(0, count).map(text => ({ translations: [{ text }] })));
  };
  const translate = fetcher => machineTranslate('microsoft', { region: 'eastasia' }, 'fixture', ['hello', 'bye'], 'en', 'zh', undefined, fetcher);
  assert.deepEqual(await translate(request(2)), ['你好', '再见']);
  await assert.rejects(translate(request(1)), { code: 'INVALID_PROVIDER_RESULT' });
});

test('failed batches resume without reissuing completed translations or moving segment IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'youdub-mt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const segments = Array.from({ length: 35 }, (_, i) => ({ id: `seg-${i}`, text: `Original ${i}` }));
  const request = { workDir, taskDir: root, stepId: 'translate', invocationId: 'try1', config: {},
    binding: { integrity: 'fixture', options: { targetLanguage: 'zh' } }, inputs: { transcript: { detected_language: 'en', segments } } };
  const context = { signal: new AbortController().signal, progress: async () => {} };
  let calls = 0;
  const call = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:5000/translate');
    if (++calls === 2) return new Response(null, { status: 503 });
    return Response.json({ translatedText: JSON.parse(init.body).q.map(text => '译文 ' + text) });
  };
  await assert.rejects(translateWithMachine('libre', { port: 5000 }, undefined, request, context, call), { status: 503 });
  const result = await translateWithMachine('libre', { port: 5000 }, undefined, { ...request, invocationId: 'try2' }, context, call);
  assert.equal(calls, 3);
  assert.deepEqual(result.outputs.translation.segments, segments.map(item => ({ segment_id: item.id, text: '译文 ' + item.text })));
});

async function fixture(t, count) {
  const root = await mkdtemp(join(tmpdir(), 'youdub-mt-lanes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const segments = Array.from({ length: count }, (_, index) => ({ id: 'seg-' + index, text: 'Original ' + index }));
  return {
    request: { taskDir: root, workDir, stepId: 'translate', invocationId: 'fixture', config: {},
      binding: { integrity: 'fixture', options: { targetLanguage: 'zh' } }, inputs: { transcript: { detected_language: 'en', segments } } },
    context: { signal: new AbortController().signal, progress: async () => {} }, segments,
  };
}

test('cloud batches overlap and keep source order even when responses finish out of order', async t => {
  const { request, context, segments } = await fixture(t, 105);
  let active = 0, peak = 0, calls = 0;
  const fetcher = async (_url, options) => {
    const { q } = JSON.parse(options.body);
    const index = calls++;
    peak = Math.max(peak, ++active);
    await delay(index === 0 ? 40 : 10);
    active--;
    return Response.json({ data: { translations: q.map(text => ({ translatedText: '中 ' + text })) } });
  };
  const result = await translateWithMachine('google', {}, 'test-key', request, context, fetcher);
  assert.equal(peak, 2);
  assert.equal(calls, 4);
  assert.deepEqual(result.outputs.translation.segments, segments.map(item => ({ segment_id: item.id, text: '中 ' + item.text })));
});

test('Google web spaces overlapping calls, keeps an accepted sentence and pauses on Retry-After', { timeout: 5000 }, async t => {
  const { request, context } = await fixture(t, 5);
  const cooldowns = translationCooldowns(), times = [];
  const secondStarted = Promise.withResolvers();
  const fetcher = async url => {
    times.push(performance.now());
    if (new URL(url).searchParams.get('q') === 'Original 1') {
      secondStarted.resolve();
      return new Response(null, { status: 429, headers: { 'Retry-After': '3' } });
    }
    await secondStarted.promise;
    return Response.json([[['第一句。', 'Original 0']]]);
  };
  const send = () => translateWithMachine('google-free', {}, undefined, request, context, fetcher, cooldowns);
  await assert.rejects(send(), { status: 429, details: { retryAfterMs: 3000 } });
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 195);
  await assert.rejects(send(), { code: 'RATE_LIMIT', status: 429 });
  assert.equal(times.length, 2);
});

test('legacy machine batch cache stays usable and malformed new batches are split', async t => {
  const { request, context, segments } = await fixture(t, 35);
  const config = { port: 5000 };
  const id = createHash('sha256').update(JSON.stringify([
    request.stepId, 'libre', request.binding.integrity, config.port, config.region, 'en', 'zh', segments,
  ])).digest('hex');
  const checkpoint = join(request.taskDir, 'translation-progress', id);
  await mkdir(checkpoint, { recursive: true });
  await writeFile(join(checkpoint, '0.json'), JSON.stringify(segments.slice(0, 32).map(item => '旧 ' + item.text)));
  const requests = [];
  const result = await translateWithMachine('libre', config, undefined, request, context, async (_url, options) => {
    const { q } = JSON.parse(options.body);
    requests.push(q);
    return Response.json({ translatedText: q.length === 3 ? [] : q.map(text => '新 ' + text) });
  });
  assert.deepEqual(requests.map(q => q.length), [3, 2, 1]);
  assert.deepEqual(result.outputs.translation.segments, segments.map((item, i) => ({
    segment_id: item.id, text: (i < 32 ? '旧 ' : '新 ') + item.text,
  })));
});
