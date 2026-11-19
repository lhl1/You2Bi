import React, { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

const path = '/api/v2/settings'

export function TranslatorSettings({ features }) {
  const { request, useQuery } = features
  const settings = useQuery(path)
  if (settings.error) return <p role="alert">无法读取翻译服务设置。</p>
  if (!settings.data) return <p>正在读取翻译服务设置…</p>
  const selected = settings.data.translator ?? { provider: 'llm', region: '', port: 5000 }
  return <TranslatorForm selected={selected} request={request} refresh={settings.refresh}/>
}

function TranslatorForm({ selected, request, refresh }) {
  const [provider, setProvider] = useState(selected.provider)
  const [region, setRegion] = useState(selected.region)
  const [port, setPort] = useState(selected.port)
  const [proxyPort, setProxyPort] = useState(selected.proxyPort ?? 0)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const cloud = provider === 'google' || provider === 'microsoft'
  const web = provider === 'google-free'

  async function save(event) {
    event.preventDefault()
    setBusy(true); setMessage(''); setError('')
    try {
      await request(path, { method: 'PATCH', body: JSON.stringify({ translator: {
        provider, ...(provider === 'microsoft' ? { region: region.trim().toLowerCase() } : {}),
        ...(cloud || web ? { proxyPort: Number(proxyPort) } : {}),
        ...(provider === 'libre' ? { port: Number(port) } : {}), ...(cloud && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      } }) })
      setApiKey(''); setMessage('已保存。新任务将使用此设置。')
      await refresh()
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }

  return <section className="bi-card"><h2>字幕与配音翻译服务</h2>
    <form onSubmit={save}>
      <label>翻译服务<select value={provider} onChange={event => { setProvider(event.target.value); setApiKey(''); setMessage(''); setError('') }}>
        <option value="llm">沿用已配置的大模型</option>
        <option value="google-free">Google 网页翻译（免费，无需密钥）</option>
        <option value="google">Google Cloud Translation（免费额度）</option>
        <option value="microsoft">微软 Azure Translator（F0 免费套餐）</option>
        <option value="libre">LibreTranslate（本地免费，无需密钥）</option>
        <option value="bilibili" disabled>哔哩哔哩（未提供公开翻译接口）</option>
      </select></label>
      {cloud && <label>API 密钥<input type="password" value={apiKey} autoComplete="off" onChange={event => setApiKey(event.target.value)} placeholder={selected.provider === provider && selected.hasKey ? '已保存，留空沿用' : '填写密钥，或留空沿用已保存密钥'}/></label>}
      {(cloud || web) && <label>翻译代理端口（0 为直连）<input type="number" min="0" max="65535" required value={proxyPort} onChange={event => setProxyPort(event.target.value)}/></label>}
      {web && <p className="bi-muted">使用参考扩展的 Google 网页接口。无需密钥，服务可能限流或拒绝当前线路。</p>}
      {provider === 'google' && <p className="bi-muted">每月前 50 万字符有免费额度，超额可能计费。请在 Google Cloud 配置用量配额。</p>}
      {provider === 'microsoft' && <><label>Azure 区域（例如 eastasia）<input value={region} onChange={event => setRegion(event.target.value)} placeholder="全局资源可留空"/></label><p className="bi-muted">请创建 F0 资源，标准文本翻译每月有 200 万字符免费额度。</p></>}
      {provider === 'libre' && <><label>本机 LibreTranslate 端口<input type="number" min="1" max="65535" required value={port} onChange={event => setPort(event.target.value)}/></label><p className="bi-muted">需先启动本机 LibreTranslate 并安装所需语言模型；默认端口 5000。</p></>}
      <p className="bi-muted">用于后续任务的字幕和配音文本。智能投稿文案、分区和标签继续使用已配置的大模型。</p>
      <Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存翻译服务'}</Button>
    </form>
    {message && <p role="status" className="bi-success">{message}</p>}
    {error && <p role="alert" className="bi-error">{error}</p>}
  </section>
}
