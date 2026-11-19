import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProxyAgent } from 'undici';
import { operations } from '../../../../packages/builtin/src/media-contracts.ts';
import { validateMediaCorrection } from '../../../../packages/builtin/src/node-contracts.ts';
import {
  groupTranslation, rateLimitDetails, readTranslationJson, runTranslationBatches, saveTranslationJson,
  translationCheckpointFiles, translationCooldowns, translationProgress,
} from './translation-batches.mjs';

export const machineServices = {
  'google-free': { label: 'Google 网页翻译（免密钥）' },
  google: { label: 'Google Cloud Translation', key: 'YOUDUB_GOOGLE_TRANSLATE_KEY' },
  microsoft: { label: 'Microsoft Azure Translator', key: 'YOUDUB_MICROSOFT_TRANSLATE_KEY' },
  libre: { label: 'LibreTranslate（本地）' },
};
export const translatorConfig = state => ({ provider: 'llm', region: '', port: 5000, proxyPort: 0, ...state.plugins?.['youdub.translator'] });
const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const languages = ['en', 'zh', 'ja'];
const validText = text => typeof text === 'string' && !!text.trim();
const validBatch = (values, size) => Array.isArray(values) && values.length === size && values.every(validText);

function retryAfter(response) {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  return rateLimitDetails(/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now());
}

export async function machineTranslate(provider, config, key, texts, source, target, signal, fetcher = fetch) {
  const svc = machineServices[provider];
  if (!svc || !languages.includes(source) && !(provider === 'libre' && source === 'auto') || !languages.includes(target)) throw fail('INVALID_CONFIG', '翻译服务或语言不受支持。');
  if (source === target) return texts;
  if (svc.key && !key) throw fail('MODEL_NOT_READY', `请先配置 ${svc.label} 的 API 密钥。`);
  const headers = { 'Content-Type': 'application/json' };
  let url, body, results;
  const azure = lang => lang === 'zh' ? 'zh-Hans' : lang;
  const google = lang => lang === 'zh' ? 'zh-CN' : lang;
  if (provider === 'google-free') {
    if (texts.length !== 1 || texts[0].length > 4500) throw fail('INVALID_CONFIG', 'Google 网页翻译每次最多接收一句、4500 字符。');
    url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({
      client: 'gtx', sl: google(source), tl: google(target), dt: 't', q: texts[0],
    });
    results = data => [data?.[0]?.filter?.(item => Array.isArray(item) && typeof item[0] === 'string')?.map(item => item[0]).join('')];
  } else if (provider === 'google') {
    url = 'https://translation.googleapis.com/language/translate/v2';
    headers['x-goog-api-key'] = key;
    body = { q: texts, source: google(source), target: google(target), format: 'text' };
    results = data => data?.data?.translations?.map?.(item => item?.translatedText);
  } else if (provider === 'microsoft') {
    url = 'https://api.cognitive.microsofttranslator.com/translate?' + new URLSearchParams({ 'api-version': '3.0', from: azure(source), to: azure(target) });
    headers['Ocp-Apim-Subscription-Key'] = key;
    if (config.region) headers['Ocp-Apim-Subscription-Region'] = config.region;
    body = texts.map(Text => ({ Text }));
    results = data => data?.map?.(item => item?.translations?.[0]?.text);
  } else {
    url = `http://127.0.0.1:${config.port}/translate`;
    body = { q: texts, source, target, format: 'text' };
    results = data => data?.translatedText;
  }
  const timeout = AbortSignal.timeout(45_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try { response = await fetcher(url, { ...(provider === 'google-free' ? { method: 'GET', credentials: 'omit' } : {
    method: 'POST', headers, body: JSON.stringify(body),
  }), redirect: 'error', signal: requestSignal }); }
  catch { signal?.throwIfAborted(); throw fail('TRANSLATION_NETWORK', `${svc.label} 连接失败或超时。`, 503); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const message = provider === 'google-free' && [403, 429].includes(response.status) ? '网页接口拒绝了当前请求或出口线路。可稍后再试，或切换到本机翻译。'
      : response.status === 429 ? '超过调用频率或配额，请查看服务配额。'
      : [401, 403].includes(response.status) ? '请检查密钥、区域和资源配额。' : '请检查服务及语言配置。';
    throw Object.assign(fail('TRANSLATION_SERVICE', `${svc.label} 返回 HTTP ${response.status}：${message}`, response.status),
      { details: response.status === 429 ? retryAfter(response) : undefined });
  }
  let translated;
  try { translated = results(await response.json()); } catch { signal?.throwIfAborted(); }
  if (!validBatch(translated, texts.length)) {
    throw fail('INVALID_PROVIDER_RESULT', `${svc.label} 返回的译文数量或内容无效。`);
  }
  return translated;
}

export async function translateWithMachine(provider, config, key, request, context, fetcher, cooldowns) {
  const transcript = request.inputs.transcript;
  const source = transcript.detected_language, target = request.binding.options.targetLanguage ?? request.config.target_language;
  const identity = createHash('sha256').update(JSON.stringify([
    request.stepId, provider, request.binding.integrity, config.port, config.region, source, target, transcript.segments,
  ])).digest('hex');
  const checkpoint = join(request.taskDir, 'translation-progress', identity);
  await mkdir(checkpoint, { recursive: true });
  const items = transcript.segments.map((item, index) => ({ ...item, index }));
  const saved = new Map();
  const web = provider === 'google-free';
  const serviceKey = JSON.stringify([provider, config.proxyPort, config.port, config.region]);
  const groups = web ? items.map(item => [item]) : groupTranslation(items, 32, 4000);
  const progress = translationProgress(items.length, context);
  const name = item => `segment-${item.index}.json`;
  const checkpointFiles = await translationCheckpointFiles(checkpoint);
  for (const [index, batch] of groups.entries()) {
    const oldName = `${index}.json`;
    const legacy = checkpointFiles.has(oldName) ? await readTranslationJson(join(checkpoint, oldName)) : undefined;
    const old = validBatch(legacy, batch.length) ? legacy : [];
    for (const [offset, item] of batch.entries()) {
      context.signal.throwIfAborted();
      const file = name(item);
      const record = checkpointFiles.has(file) ? await readTranslationJson(join(checkpoint, file)) : undefined;
      if (record?.id === item.id && validText(record.text)) saved.set(item.index, record.text);
      else if (old[offset]) saved.set(item.index, old[offset]);
    }
  }
  await progress(saved.size);

  async function translate(batch, dispatch, canDispatch) {
    if (!canDispatch()) return;
    let translations;
    try {
      translations = await dispatch(async () => {
        cooldowns?.check(serviceKey);
        return machineTranslate(provider, config, key, batch.map(item => item.text), source, target, context.signal, fetcher);
      });
    } catch (error) {
      if (error.code !== 'INVALID_PROVIDER_RESULT') throw error;
      if (batch.length === 1) throw fail(error.code, `片段 ${batch[0].id}：${error.message}`);
      const split = Math.ceil(batch.length / 2);
      await translate(batch.slice(0, split), dispatch, canDispatch);
      await translate(batch.slice(split), dispatch, canDispatch);
      return;
    }
    if (!translations) return;
    for (const [offset, item] of batch.entries()) {
      context.signal.throwIfAborted();
      const text = translations[offset];
      await saveTranslationJson(join(checkpoint, name(item)), { id: item.id, text });
      saved.set(item.index, text);
    }
    await progress(batch.length);
  }

  const pending = groups.map(batch => batch.filter(item => !saved.has(item.index))).filter(batch => batch.length);
  try { await runTranslationBatches(pending, provider === 'libre' ? 1 : 2, context.signal, translate, web ? 200 : 0); }
  catch (error) { cooldowns?.note(serviceKey, error); throw error; }
  const segments = items.map(item => ({ segment_id: item.id, text: saved.get(item.index) }));
  const translation = { source_language: source, target_language: target, segments };
  await writeFile(join(request.workDir, 'translation.json'), JSON.stringify(translation, null, 2), { flag: 'wx' });
  return { state: 'completed', outputs: { translation } };
}

export function registerMachineProviders(ctx, credentialRef) {
  const cooldowns = translationCooldowns();
  for (const [provider, service] of Object.entries(machineServices)) {
    const id = `mt.${provider}`, model = 'standard';
    const integrity = 'sha256:' + createHash('sha256').update(`youdub-mt/${provider}/1`).digest('hex');
    const description = { id, adapter: id, label: service.label, pluginId: 'youdub.machine-translation', pluginVersion: '1.0.0',
      integrity, capability: 'translation', execution: 'remote', resources: { dependencyGroups: [] }, operations: [structuredClone(operations.translate), structuredClone(operations.translateSelective)],
      models: [{ id: model, name: service.label, label: service.label, devices: ['remote'], source_languages: languages, target_languages: languages, available: true }],
      available: !service.key };
    ctx.effect(() => ctx.catalog.registerProvider({
      id, describe: () => structuredClone(description),
      async probe() {
        description.available = !service.key || (await ctx.credentials.describe(credentialRef(service.key))).configured;
        description.unavailableReason = description.available ? null : '请在翻译服务设置中填写 API 密钥。';
        return { available: description.available, reason: description.unavailableReason };
      },
      validateCorrection: validateMediaCorrection,
      async execute(request, context) {
        const config = translatorConfig(ctx.settings.preferences());
        const credential = service.key ? (await ctx.credentials.resolve(credentialRef(service.key)))?.value : undefined;
        const proxy = provider !== 'libre' && config.proxyPort ? new ProxyAgent(`http://127.0.0.1:${config.proxyPort}`) : null;
        try {
          return await translateWithMachine(provider, config, credential, request, context,
            proxy ? (url, options) => fetch(url, { ...options, dispatcher: proxy }) : undefined, cooldowns);
        } finally { if (proxy) await proxy.close(); }
      },
    }));
  }
}
