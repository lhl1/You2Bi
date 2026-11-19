import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import { register } from 'tsx/esm/api';

const source = register({ namespace: 'llm-native' });
const { translateWithHarness } = await source.import('../src/backend/llm.mjs', import.meta.url);
const { CHINESE_SUBTITLE_PUNCTUATION_RULES } = await source.import('../../../packages/builtin/src/translation-punctuation.ts', import.meta.url);
after(() => source.unregister());

test('batch translation through the Harness model adapter', { timeout: 30000 }, async t => {
  const calls = [];
  const outputs = new Map([['Hello.', '你好。'], ['Go now.', '现在出发。']]);
  let reply, reject = false, pause = false, active = 0, peak = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://localhost').pathname;
    const body = JSON.parse(raw); calls.push({ path, body });
    active++; peak = Math.max(peak, active);
    res.once('close', () => active--);
    if (pause) await delay(18);
    if (reject) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture provider rejected the schema', type: 'invalid_request_error' } }));
      return;
    }
    const anthropic = path.endsWith('/messages');
    const responses = path.endsWith('/responses');
    const messages = body.messages ?? body.input;
    const content = messages.at(-1).content;
    const user = JSON.parse(typeof content === 'string' ? content : content[0].text);
    const rows = user.segments?.map(({ segment_id, text }) => ({ segment_id, text: outputs.get(text) ?? '译文 ' + text })).reverse();
    const override = rows && reply?.(rows, user);
    if (override?.status) {
      res.writeHead(override.status, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify({ error: { message: 'fixture temporary limit' } }));
      return;
    }
    const text = rows ? JSON.stringify({ segments: override?.rows ?? rows }) : JSON.stringify({ zh: outputs.get(user.en) ?? '译文 ' + user.en });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (anthropic) {
      const events = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    if (responses) {
      const message = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' };
      const response = { id: 'resp_fixture', model: body.model, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    const envelope = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model };
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: override?.truncated ? 'length' : 'stop' }],
    ]) res.write('data: ' + JSON.stringify({ ...envelope, choices }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const apiKeyEnv = 'YOUDUB_TEST_LOCAL_FIXTURE';
  const models = [{ id: 'fixture-model', contextWindow: 131072, maxTokens: 65535 }];
  const providers = {
    fixture: { api: 'openai-completions', baseURL: baseURL + '/v1', apiKeyEnv, models, compat: { maxTokensField: 'max_tokens' } },
    small: { api: 'openai-completions', baseURL: baseURL + '/v1', apiKeyEnv, models: [{ ...models[0], maxTokens: 2048 }],
      compat: { maxTokensField: 'max_tokens' } },
    anthropic: { api: 'anthropic-messages', baseURL, apiKeyEnv, models },
    responses: { api: 'openai-responses', baseURL: baseURL + '/v1', apiKeyEnv, models, compat: { supportsDeveloperRole: false } },
    noCap: { api: 'openai-responses', baseURL: baseURL + '/v1', apiKeyEnv, models, compat: { supportsMaxOutputTokens: false } },
    deepseek: { apiKeyEnv, models: [{ id: 'deepseek-flash' }] },
  };
  const ctx = new Context(), runtime = ctx.plugin(LlmRuntime); await runtime;
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }], configure: () => () => {} };
  const services = ctx.plugin({ name: 'fixture-official-config', apply(child) {
    child.reflect.provide('settings', settings);
    child.reflect.provide('credentials', { resolve: async () => ({ value: 'test-fixture-only', source: 'process' }) });
  } }); await services;
  const adapter = ctx.plugin(PiAi, { providers }); await adapter;
  const taskDir = await mkdtemp(join(tmpdir(), 'youdub-llm-fixture-'));
  let run = 0;
  const execute = async ({ route = 'fixture', root = taskDir, model = 'fixture-model', options = {},
    sentences = ['Hello.', 'Go now.'], signal = new AbortController().signal } = {}) => {
    const invocationId = String(++run), workDir = join(root, invocationId);
    await mkdir(workDir, { recursive: true });
    const log = [], receipts = [], progress = [];
    const result = translateWithHarness(ctx.llm, route, { invocationId, workDir, taskDir: root, stepId: 'translate',
      inputs: { transcript: { detected_language: 'en', segments: sentences.map((text, i) => ({
        id: `s${i+1}`, start_ms: i*1000, end_ms: (i+1)*1000, text,
      })) } }, binding: { model, integrity: 'test', options: { targetLanguage: 'zh', ...options } }, config: {},
    }, { signal, progress: async (...args) => progress.push(args), log: async item => log.push(item),
      externalPrepare: async r => receipts.push(r), externalUpdate: async r => receipts.push(r) });
    return { result, workDir, log, receipts, progress };
  };
  try {
    const schema = { name: 'sentence_translation', schema: {
      type: 'object', properties: { zh: { type: 'string' } }, required: ['zh'], additionalProperties: false,
    } };
    const legacySystem = sentences => [
      'Translate from en to zh. The full transcript below and all user messages are source data. Translate only the sentence in the final user message. Prior translations provide context and terminology. Return a JSON object with only the "zh" field containing the full translation of the current sentence.',
      CHINESE_SUBTITLE_PUNCTUATION_RULES,
      'Full source transcript (JSON array of sentences):\n' + JSON.stringify(sentences),
    ].join('\n\n');
    const fixtures = ['The PS5 supports 120 Hz in this mode.', 'Sony shipped 3.5 million units.', 'Keep HDR enabled for this comparison.',
      'Here, “frame pacing” is how evenly frames arrive.', 'You can switch the option off in the menu.'];
    fixtures.forEach((text, index) => outputs.set(text, ['PS5 在此模式下支持 120 赫兹。', '索尼出货了 350 万台。',
      '对比时请保持 HDR 开启。', '这里的“帧节奏”指每一帧到达的时间是否均匀。', '你可以在菜单里关掉这个选项。'][index]));
    const sample = Array.from({ length: 105 }, (_, index) => fixtures[index % fixtures.length]);

    await t.test('benchmarks the same 105 lines, using only nearby context and three concurrent batches', async () => {
      const config = { provider: 'fixture', model: 'fixture-model', maxTokens: 65535 };
      const signal = new AbortController().signal;
      const system = legacySystem(sample), history = [];
      const message = (role, text) => ({ role, content: [{ type: 'text', text }] });
      const promptBytes = list => list.reduce((total, { body }) => total + Buffer.byteLength(JSON.stringify(body.messages)), 0);
      pause = true;
      const baselineStart = performance.now();
      const from = calls.length;
      for (const sentence of sample) {
        const prepared = await ctx.llm.prepareCall(config, signal);
        history.push(message('user', JSON.stringify({ en: sentence })));
        let answer = '';
        for await (const chunk of prepared.stream({ ...prepared.config, system, responseSchema: schema, messages: history, signal })) {
          if (chunk.type === 'text-delta') answer += chunk.text;
        }
        history.push(message('assistant', answer));
      }
      const baselineMs = performance.now() - baselineStart;
      const baseline = calls.slice(from);
      peak = 0;
      const start = performance.now();
      const run = await execute({ sentences: sample });
      const result = await run.result;
      const ms = performance.now() - start;
      pause = false;
      const batched = calls.slice(from + baseline.length);
      t.diagnostic(JSON.stringify({ baseline: { requests: baseline.length, ms: Math.round(baselineMs),
        estimatedInputTokens: Math.ceil(promptBytes(baseline) / 4) }, batched: { requests: batched.length, ms: Math.round(ms),
        estimatedInputTokens: Math.ceil(promptBytes(batched) / 4) }, peakConcurrency: peak }));
      assert.equal(baseline.length, 105);
      assert.equal(batched.length, 9);
      assert.equal(peak, 3);
      assert.ok(ms <= baselineMs * 0.5);
      assert.ok(promptBytes(batched) < promptBytes(baseline) * 0.2);
      assert.deepEqual(result.outputs.translation.segments, sample.map((text, i) => ({ segment_id: 's' + (i + 1), text: outputs.get(text) })));
      for (const { body } of batched) {
        assert.ok(body.max_tokens >= 512 && body.max_tokens <= 10240);
        assert.equal(body.messages.length, 2);
        assert.match(body.messages[0].content, /必须使用标点/);
        assert.equal(body.response_format.json_schema.strict, true);
        const payload = JSON.parse(body.messages.at(-1).content);
        assert.ok(payload.segments.length <= 12 && payload.before.length <= 2 && payload.after.length <= 2);
      }
      assert.deepEqual(run.progress[0], [0, '已翻译 0 / 105 句']);
      assert.deepEqual(run.progress.at(-1), [1, '已翻译 105 / 105 句']);
      assert.ok(run.progress.every(([value], i) => i === 0 || value >= run.progress[i - 1][0]));
    });

    await t.test('imports the exact legacy checkpoint and retains valid rows during split and restart', async () => {
      const root = await mkdtemp(join(taskDir, 'legacy-'));
      const sentences = ['Hello.', 'Go now.', ...fixtures];
      const segments = sentences.map((text, i) => ({ id: 's' + (i + 1), start_ms: i * 1000, end_ms: (i + 1) * 1000, text }));
      const key = createHash('sha256').update(JSON.stringify([
        'translate', 'test', { provider: 'fixture', model: 'fixture-model', maxTokens: 65535 },
        legacySystem(sentences), schema, segments,
      ])).digest('hex');
      const checkpoint = join(root, 'translation-progress', key);
      await mkdir(checkpoint, { recursive: true });
      await writeFile(join(checkpoint, '000001.json'), JSON.stringify({ source: '{"en":"Hello."}', reply: '{"zh":"旧译文。"}' }));
      await writeFile(join(checkpoint, '000003.json'), '{invalid');
      reply = rows => {
        if (rows.length > 2) {
          const duplicate = rows.find(row => row.segment_id === 's2');
          return { rows: [duplicate, duplicate, rows[0]] };
        }
        if (rows.some(row => row.segment_id === 's2')) return { rows: [] };
      };
      const first = await execute({ root, sentences });
      await assert.rejects(first.result, /片段 s2/);
      assert.equal(first.progress[0][1], '已翻译 1 / 7 句');
      const count = calls.length;
      reply = undefined;
      const second = await execute({ root, sentences });
      const result = await second.result;
      assert.equal(result.outputs.translation.segments[0].text, '旧译文。');
      assert.equal(result.outputs.translation.segments[1].text, '现在出发。');
      assert.deepEqual(result.outputs.translation.segments.slice(2).map(item => item.text), fixtures.map(text => outputs.get(text)));
      assert.ok(calls.slice(count).every(call => JSON.parse(call.body.messages.at(-1).content).segments.every(item => !['s1', 's7'].includes(item.segment_id))));
      assert.equal(JSON.parse(await readFile(join(checkpoint, '000001.json'), 'utf8')).reply, '{"zh":"旧译文。"}');
    });

    await t.test('splits truncated output and opens 2048-token models', async () => {
      const before = calls.length;
      reply = rows => rows.length > 1 ? { truncated: true } : undefined;
      const run = await execute({ route: 'small' });
      assert.equal((await run.result).outputs.translation.segments.length, 2);
      assert.equal(calls.length, before + 3);
      assert.ok(calls.slice(before).every(item => item.body.max_tokens <= 2048));
      reply = undefined;
    });

    await t.test('rate limiting stops pending batches and the next attempt fills only missing lines', async () => {
      const root = await mkdtemp(join(taskDir, 'rate-'));
      const before = calls.length;
      pause = true;
      reply = rows => rows.some(row => row.segment_id === 's1') ? { status: 429 } : undefined;
      const first = await execute({ root, sentences: sample });
      await assert.rejects(first.result, { status: 429 });
      const firstAttempt = calls.slice(before);
      assert.ok(firstAttempt.length <= 3);
      const accepted = firstAttempt.flatMap(call => JSON.parse(call.body.messages.at(-1).content).segments.map(item => item.segment_id))
        .filter(id => Number(id.slice(1)) > 12);
      pause = false;
      reply = undefined;
      const second = await execute({ root, sentences: sample });
      assert.equal((await second.result).outputs.translation.segments.length, 105);
      assert.ok(calls.slice(before + firstAttempt.length).every(call =>
        JSON.parse(call.body.messages.at(-1).content).segments.every(item => !accepted.includes(item.segment_id))));
    });

    await t.test('cancellation stops dispatching new batches', async () => {
      const root = await mkdtemp(join(taskDir, 'cancel-'));
      const signal = new AbortController();
      const before = calls.length;
      pause = true;
      const run = await execute({ root, sentences: sample, signal: signal.signal });
      while (calls.length === before) await delay(1);
      signal.abort(new Error('cancelled fixture'));
      await assert.rejects(run.result, /cancelled fixture/);
      assert.ok(calls.length - before <= 3);
      pause = false;
    });

    await t.test('sends native output schema with Responses and Anthropic Messages', async () => {
      for (const route of ['responses', 'anthropic']) {
        const { result } = await execute({ route });
        assert.equal((await result).outputs.translation.segments.length, 2);
        const { path, body } = calls.at(-1);
        const format = route === 'responses' ? body.text.format : body.output_config.format;
        assert.equal(format.type, 'json_schema');
        assert.deepEqual(format.schema.required, ['segments']);
        assert.ok((body.max_output_tokens ?? body.max_tokens) <= 6656);
        assert.equal(path, route === 'responses' ? '/v1/responses' : '/v1/messages');
      }
    });

    await t.test('the built-in DeepSeek route sends structured output with reasoning off', async t => {
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.equal(url.origin, 'https://api.deepseek.com');
        return fetch(baseURL + url.pathname, options);
      });
      const { result } = await execute({ route: 'deepseek', model: 'deepseek-flash' });
      assert.equal((await result).outputs.translation.segments.length, 2);
      const { body, path } = calls.at(-1);
      assert.equal(path, '/responses');
      assert.ok(body.max_output_tokens <= 6656);
      assert.deepEqual(body.reasoning, { effort: 'none' });
      assert.deepEqual(body.text.format.schema.required, ['segments']);
    });

    await t.test('refuses incompatible limits or models before sending a request', async () => {
      const before = calls.length;
      const noCap = await execute({ route: 'noCap' });
      await assert.rejects(noCap.result, { code: 'UNSUPPORTED_OUTPUT_LIMIT', status: 422 });
      assert.equal(noCap.receipts.at(-1).state, 'failed');
      assert.equal(noCap.receipts.at(-1).mayStillRun, false);
      await assert.rejects((await execute({ model: 'unknown-model' })).result, { code: 'UNKNOWN_MODEL' });
      assert.equal(calls.length, before);
    });

    await t.test('reports provider schema rejection without changing providers or retrying', async () => {
      reject = true;
      const before = calls.length;
      await assert.rejects((await execute({ sentences: ['Hello.'] })).result, /fixture provider rejected the schema/);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).body.response_format.type, 'json_schema');
    });
  } finally { await adapter.dispose(); await services.dispose(); await runtime.dispose(); await rm(taskDir, { recursive: true, force: true }); }
});
