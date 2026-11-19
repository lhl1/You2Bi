import React,{useEffect,useState} from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PageHeader } from '../../../web/src/components/page-layout'
import { useFeatures } from './runtime'
import { PublicationPill, PublicationWorkbench } from './publication-workbench'
import { videoEncoders } from '../../../../packages/builtin/src/video-encoders.ts'
const base='/api/v2/automation'
const tags=value=>value.split(/[,，]/).map(item=>item.trim()).filter(Boolean)
const date=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未检查'
const empty={url:'',workflowId:'youdub.subtitles-dubbing',intervalMinutes:5,proxyPort:'',fixedTid:'',fallbackTid:'',fixedTags:'',fallbackTags:''}
const channelForm=channel=>({...empty,...channel,fixedTid:channel.template.fixedTid || '',fallbackTid:channel.template.fallbackTid || '',fixedTags:channel.template.fixedTags.join('，'),fallbackTags:channel.template.fallbackTags.join('，')})
function ChannelAvatar({channel}){
 const [failed,setFailed]=useState(false)
 return <div className="bi-channel-avatar">{channel.avatar && !failed?<img src={channel.avatar} alt={`${channel.name} 频道头像`} width="52" height="52" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<span aria-hidden="true">{channel.name.slice(0,2)}</span>}</div>
}
export function ChannelIdentity({channel,showDescription=true}){
 const count=channel.subscriberCount
 return <div className="bi-channel-summary"><div className="bi-channel-identity"><ChannelAvatar key={`${channel.id}-${channel.profileUpdatedAt || 0}`} channel={channel}/><div><div className="bi-channel-title"><strong>{channel.name}</strong>{channel.isVerified && <span className="bi-verified" title="YouTube 已认证" aria-label="YouTube 已认证">✓</span>}</div><div className="bi-profile-meta">{channel.handle && <span>{channel.handle}</span>}{typeof count==='number' && <span>{new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(count)} 位订阅者</span>}</div></div></div>{showDescription && channel.description && <p className="bi-channel-description">{channel.description}</p>}</div>
}
const monitorStates={new:'待首检',checking:'检查中',scheduled:'等待检查',healthy:'监控正常',issue:'待处理',paused:'已暂停'}
const monitorState=channel=>channel.checkState || (channel.enabled?(channel.error?'issue':channel.lastCheck?'healthy':'new'):'paused')

export function MonitoringPage(){
  const {request,useQuery,navigate}=useFeatures(),query=useQuery(base+'/configuration',2500)
  const [pending,setPending]=useState(null),[feedback,setFeedback]=useState(null)
  const [filter,setFilter]=useState('all'),[search,setSearch]=useState('')
  const channels=query.data?.channels || []
  const groups={
    all:channels.length,active:channels.filter(channel=>channel.enabled).length,
    issue:channels.filter(channel=>channel.enabled&&monitorState(channel)==='issue').length,
    paused:channels.filter(channel=>!channel.enabled).length,
  }
  const auth=channels.filter(channel=>channel.enabled&&channel.errorCode==='auth').length
  const visible=channels.filter(channel=>(filter==='all'||filter==='active'&&channel.enabled||
    filter==='issue'&&channel.enabled&&monitorState(channel)==='issue'||filter==='paused'&&!channel.enabled) &&
    ((channel.name || '')+' '+(channel.handle || '')).toLowerCase().includes(search.trim().toLowerCase()))
  async function action(channel,suffix,method='POST',body,notice){
    setPending(channel.id);setFeedback(null)
    try{
      await request(base+'/channels/'+encodeURIComponent(channel.id)+suffix,{method,...(body===undefined?{}:{body:JSON.stringify(body)})})
      query.refresh();setFeedback({text:channel.name+'：'+notice})
    }catch(error){setFeedback({text:error.message,error:true})}
    finally{setPending(null)}
  }
  return <><PageHeader title="频道监控"/><div className="pub-page mon-page">
    <header className="pub-header"><div><h1>频道监控</h1><p>跟踪新视频，或在频道中选择历史视频加入发布队列。</p></div>
      <button type="button" className="pub-button pub-primary" onClick={()=>navigate('/automation?tab=channels')}><span aria-hidden="true">＋</span>添加频道</button></header>
    {auth>0&&<div className="pub-callout" role="status"><span>{auth} 个频道需要更新 YouTube 登录。同步成功后会自动安排检查。</span>
      <button type="button" className="pub-link" onClick={()=>navigate('/automation?tab=settings&focus=youtube')}>检查登录</button></div>}
    {(feedback || query.error)&&<div className={'pub-callout'+(feedback?.error||query.error?' pub-error':'')} role={feedback?.error||query.error?'alert':'status'}>
      {feedback?.text || ('读取状态失败：'+query.error)}</div>}
    <section className="pub-panel pub-queue" aria-label="监控频道">
      <div className="pub-queue-head"><div><h2>频道列表</h2><p>{channels.length} 个已添加频道</p></div>
        <label className="mon-search"><span>搜索频道</span><input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="频道名称或 @handle"/></label></div>
      <div className="pub-toolbar"><div className="pub-filters" role="group" aria-label="筛选频道">
        {[['all','全部'],['active','已启用'],['issue','待处理'],['paused','已暂停']].map(([id,label])=>
          <button key={id} aria-pressed={filter===id} type="button" onClick={()=>setFilter(id)}>{label}<span>{groups[id]}</span></button>)}
      </div></div>
      {!query.data&&!query.error&&<p className="pub-empty" role="status">正在读取频道…</p>}
      {query.data&&!visible.length&&<p className="pub-empty">{channels.length?'没有符合条件的频道。':'还没有频道，点击「添加频道」开始。'}</p>}
      <div className="mon-list">{visible.map(channel=><MonitorRow key={channel.id} channel={channel} busy={pending!==null}
        select={()=>navigate('/monitoring/'+encodeURIComponent(channel.id)+'/videos')}
        edit={()=>navigate('/automation?tab=channels&edit='+encodeURIComponent(channel.id))}
        action={(...args)=>action(channel,...args)}/>)}</div>
    </section>
  </div></>
}

function MonitorRow({channel,busy,select,edit,action}){
  const state=monitorState(channel), working=state==='checking'||state==='scheduled'
  const [removing,setRemoving]=useState(false)
  return <article className="mon-row" aria-label={channel.name}>
    <div className="mon-identity"><ChannelIdentity channel={channel} showDescription={false}/></div>
    <div className="mon-health">
      <PublicationPill group={state==='healthy'?'published':state==='issue'?'attention':state==='paused'?'stopped':'active'}>{channel.errorCode==='auth'&&state==='issue'?'需要登录':monitorStates[state]}</PublicationPill>
      <p>{state==='issue'?(channel.error || '检查未完成。'):working?'已安排一次检查':channel.lastCheck?('最近检查 '+date(channel.lastCheck)):'尚未检查'}</p>
      {state==='healthy'&&Number.isInteger(channel.lastAdded)&&<small>{channel.lastAdded?'已入队 '+channel.lastAdded+' 条新视频':'未发现新视频'}</small>}
    </div>
    <div className="mon-actions">
      <button type="button" className="pub-button mon-select" onClick={select}>选择视频</button>
      <Button disabled={busy||working||!channel.enabled} onClick={()=>action('/check','POST',undefined,'已安排检查')}>立即检查</Button>
      <details className="mon-menu"><summary>管理</summary><div>
        <a href={channel.url} target="_blank" rel="noreferrer">打开 YouTube ↗</a>
        <Button onClick={edit}>编辑</Button>
        <Button disabled={busy} onClick={()=>action('','PATCH',{enabled:!channel.enabled},channel.enabled?'已暂停监控':'已恢复监控')}>{channel.enabled?'暂停':'恢复'}</Button>
        <Button disabled={busy} onClick={()=>action('/profile','POST',undefined,'已安排刷新资料')}>刷新资料</Button>
        {removing?<Button disabled={busy} onClick={()=>action('','DELETE',undefined,'已移除频道，原发布任务保留')}>确认移除</Button>
          :<Button disabled={busy} onClick={()=>setRemoving(true)}>移除…</Button>}
        {removing&&<Button onClick={()=>setRemoving(false)}>返回</Button>}
      </div></details>
    </div>
    <p className="mon-network">每 {channel.intervalMinutes} 分钟 · {channel.proxyPort?'代理 '+channel.proxyPort:'直连'}{channel.nextCheck>0&&channel.enabled&&!working?' · 下次 '+date(channel.nextCheck):''}</p>
  </article>
}
function YoutubeSettings({action,busy,active}){
  const {useQuery}=useFeatures(),query=useQuery(base+'/youtube',15000)
  const [file,setFile]=useState(null),[message,setMessage]=useState(''),[failure,setFailure]=useState('')
  const [url,setUrl]=useState('https://www.youtube.com/watch?v=jNQXAC9IVRw')
  async function upload(event){
    event.preventDefault();setFailure('');setMessage('')
    if(!file)return
    try{
      if(file.size>1024*1024)throw new Error('请选择不超过 1 MB 的 cookies.txt')
      const result=await action('/youtube','POST',{cookies:await file.text(),resume:true})
      if(result){
        setMessage(result.deferred?'凭据已保存，继续队列后会恢复受阻任务。':'凭据已保存，恢复 '+result.resumed.length+' 条受阻任务。')
        setFile(null);await query.refresh()
      }
    }catch(error){setFailure(error.message)}
  }
  async function check(){
    setMessage('')
    const result=await action('/youtube/check','POST',{url})
    if(result)setMessage('可访问：'+result.title+'，找到 '+result.formatCount+' 个音视频格式。')
  }
  return <section id="publication-setting-youtube" className={'bi-card'+(active?' bi-active-setting':'')}>
    <h2>YouTube 登录凭据</h2>
    <p className="bi-muted">{!query.data?'正在读取…':query.data.configured?'已保存登录凭据':'尚未保存登录凭据'}{query.data?.downloaderVersion?' · 下载器 '+query.data.downloaderVersion:''}</p>
    {query.data?.error && <p role="alert" className="bi-error">{query.data.error}</p>}
    <p className="bi-muted">可以在 Edge 登录后用「You2Bi · YouTube 登录同步」自动更新。也可以手动导入 Netscape 格式的 cookies.txt。</p>
    <form onSubmit={upload}><label>YouTube cookies.txt<input key={query.data?.importedAt || 0} type="file" accept=".txt,text/plain" onChange={event=>setFile(event.target.files?.[0] || null)}/></label>
      <Button type="submit" disabled={busy||!file}>保存并恢复受阻任务</Button></form>
    <details><summary>检查 YouTube 访问</summary>
      <label>检查视频地址<input value={url} onChange={event=>setUrl(event.target.value)}/></label>
      <div className="bi-actions"><Button disabled={busy} onClick={check}>检查视频</Button>
        <Button disabled={busy||!query.data?.configured} onClick={async()=>{if(await action('/youtube','DELETE')){setMessage('已清除应用中保存的凭据。');await query.refresh()}}}>清除登录凭据</Button></div>
    </details>
    {message && <p className="bi-success" role="status">{message}</p>}
    {failure && <p className="bi-error" role="alert">{failure}</p>}
  </section>
}
function VideoTaskForm({channels,workflows,defaultProxy,accountId,ready,busy,onAdd}){
 const [draft,setDraft]=useState({url:'',channelId:'',workflowId:'',proxyPort:''})
 const selected=channels.find(channel=>channel.id===draft.channelId)
 const proxy=draft.proxyPort===''?(selected?.proxyPort ?? defaultProxy):draft.proxyPort
 const workflowId=draft.workflowId || selected?.workflowId || 'youdub.subtitles-dubbing'
 const field=(key,value)=>setDraft(previous=>({...previous,[key]:value}))
 async function submit(event){event.preventDefault();await onAdd({...draft,accountId:selected?.accountId || accountId,workflowId,proxyPort:Number(proxy)})}
 return <div className="bi-columns"><section className="bi-card"><h2>粘贴 YouTube 视频</h2><p className="bi-muted">无需先监控频道，单个已发布视频或 Shorts 都可以直接加入自动化队列。</p>{!ready && <p className="bi-alert">请先在「账号与设置」登录 B 站。</p>}<form onSubmit={submit}><label>视频地址<textarea required rows="3" value={draft.url} placeholder="https://www.youtube.com/watch?v=… 或 https://youtu.be/…" onChange={event=>field('url',event.target.value)}/></label><label>处理与投稿配置<select value={draft.channelId} onChange={event=>setDraft(previous=>({...previous,channelId:event.target.value,workflowId:'',proxyPort:''}))}><option value="">默认原声克隆 · 智能分区与标签</option>{channels.map(channel=><option key={channel.id} value={channel.id}>沿用「{channel.name}」频道配置</option>)}</select></label><label>原声克隆工作流<select value={workflowId} onChange={event=>field('workflowId',event.target.value)}>{workflows.length?workflows.map(item=><option key={item.id} value={item.id}>{item.document.title}</option>):<option value="youdub.subtitles-dubbing">字幕＋配音</option>}</select></label><label>YouTube 代理端口<input type="number" min="0" max="65535" value={proxy} onChange={event=>field('proxyPort',event.target.value)}/></label><div className="bi-actions"><Button type="submit" disabled={busy||!ready}>{busy?'正在解析视频…':'加入自动化上传队列'}</Button></div></form></section><section className="bi-card bi-video-explainer"><span className="bi-eyebrow">ONE LINK, FULL WORKFLOW</span><h2>从一个链接到中文成片</h2><ol><li>下载原视频与原封面</li><li>识别、翻译并生成中文字幕</li><li>克隆原声生成中文配音，保留背景音</li><li>翻译标题与介绍，智能选择分区和标签</li><li>自动公开转载投稿并跟踪审核</li></ol><p className="bi-muted">同一视频已由频道监控或手动添加时，会打开现有任务，避免重复投稿。直播中和尚未发布的视频需等待发布后添加。</p></section></div>
}
export function AutomationPage({params={}}={}){
  const search=new URLSearchParams(params.__search || '')
  const tab=search.get('tab')
  if(!['channels','video','settings'].includes(tab))return <PublicationWorkbench focusInput={search.get('add')==='1'}/>
  return <PublicationConfiguration key={params.__search} tab={tab} editId={search.get('edit')} focus={search.get('focus')} />
}

function PublicationConfiguration({tab,editId,focus}){
  const {request,useQuery,navigate}=useFeatures()
  const query=useQuery(base+'/configuration',tab==='settings'?5000:undefined)
  const data=query.data, title=tab==='settings'?'发布设置':tab==='video'?'添加视频':editId?'编辑频道':'添加频道'
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  async function action(path,method='POST',body){
    setBusy(true);setError('')
    try{
      const response=await request(base+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})})
      if(method!=='GET')await query.refresh()
      return response
    }catch(cause){setError(cause.message);return null}
    finally{setBusy(false)}
  }
  return <><PageHeader title={title}/><div className="bi-page">
    <button className="pub-back" type="button" onClick={()=>navigate(tab==='channels'?'/monitoring':'/automation')}>← {tab==='channels'?'返回频道监控':'返回发布工作台'}</button>
    <header className="bi-hero"><div><h1>{title}</h1><p>{tab==='settings'?'绑定账号、选择投稿文案模型和配置网络。':tab==='video'?'为单个视频指定频道配置或代理端口。':'设置频道监控、字幕配音和投稿模板。'}</p></div></header>
    {(error || query.error) && <div className="bi-alert" role="alert">{error || query.error?.message || String(query.error)}</div>}
    {!data && !query.error && <p role="status" className="bi-empty">正在读取设置…</p>}
    {data && (tab==='settings'
      ? <PublicationSettings data={data} action={action} busy={busy} focus={focus} setError={setError}/>
      : <PublicationInput tab={tab} data={data} editId={editId} action={action} busy={busy}/>)}
  </div></>
}

function PublicationInput({tab,data,editId,action,busy}){
  const {useQuery,navigate}=useFeatures(),workflows=useQuery('/api/v2/workflow-documents')
  const channels=data.channels || [],accounts=data.accounts || [],settings=data.settings || {}
  const ready=accounts.some(item=>item.ready),defaultProxy=settings.proxyPort ?? 7897
  const channel=editId && channels.find(item=>item.id===editId)
  const workflowOptions=(workflows.data?.items || []).filter(item=>item.document?.nodes?.some(node=>node.type==='youdub.synthesize'))
  if(tab==='video')return <VideoTaskForm channels={channels} workflows={workflowOptions} defaultProxy={defaultProxy}
    accountId={accounts[0]?.id} ready={ready} busy={busy} onAdd={async input=>{
      const result=await action('/videos','POST',input)
      if(result?.job?.id)navigate('/automation/'+encodeURIComponent(result.job.id))
    }}/>
  if(editId&&!channel)return <div className="bi-alert" role="alert">要编辑的频道已不存在，请返回频道监控。</div>
  return <ChannelForm channel={channel} workflows={workflowOptions} defaultProxy={defaultProxy} ready={ready}
    accountId={accounts[0]?.id} busy={busy} action={action}/>
}

function ChannelForm({channel,workflows,defaultProxy,ready,accountId,busy,action}){
  const {navigate}=useFeatures()
  const [form,setForm]=useState(()=>channel?channelForm(channel):empty)
  const [categories,setCategories]=useState([])
  const channelProxy=form.proxyPort===''?defaultProxy:form.proxyPort
  const field=(key,value)=>setForm(previous=>({...previous,[key]:value}))
  async function submit(event){
    event.preventDefault()
    const chooseVideos=event.nativeEvent.submitter?.value==='selectVideos'
    const template={fixedTid:Number(form.fixedTid)||0,fallbackTid:Number(form.fallbackTid)||0,fixedTags:tags(form.fixedTags),fallbackTags:tags(form.fallbackTags)}
    const result=await action(channel?'/channels/'+encodeURIComponent(channel.id):'/channels',channel?'PATCH':'POST',{
      url:form.url,workflowId:form.workflowId,intervalMinutes:Number(form.intervalMinutes),proxyPort:Number(channelProxy),accountId,template,
    })
    if(result)navigate(chooseVideos?'/monitoring/'+encodeURIComponent(result.id)+'/videos':'/monitoring')
  }
  const choices=value=><>{value&&!categories.some(item=>item.id===Number(value))&&<option value={value}>已保存的分区 #{value}</option>}
    {categories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</>
  return <section className="bi-card bi-channel-form mon-form">
    {!ready && <p className="bi-alert">请先连接 B 站账号，再添加频道。</p>}
    <form onSubmit={submit}>
      <label>频道主页 / @handle / 频道 ID<input required value={form.url} disabled={!!channel} placeholder="例如 @ModernVintageGamer" onChange={event=>field('url',event.target.value)}/></label>
      <p className="bi-muted">添加后仅自动处理此后的新视频。历史视频可在下一步批量选择。</p>
      <details open={channel?true:undefined} className="mon-advanced"><summary>工作流与监控设置 <span>每 {form.intervalMinutes} 分钟 · {Number(channelProxy)?'代理 '+channelProxy:'直连'}</span></summary>
      <label>原声克隆工作流<select value={form.workflowId} onChange={event=>field('workflowId',event.target.value)}>
        {workflows.length?workflows.map(item=><option key={item.id} value={item.id}>{item.document.title}</option>):<option value="youdub.subtitles-dubbing">字幕＋配音（默认原声克隆）</option>}
      </select></label>
      <div className="bi-form-row"><label>检查间隔（分钟）<input type="number" min="1" max="1440" value={form.intervalMinutes} onChange={event=>field('intervalMinutes',event.target.value)}/></label>
        <label>YouTube 代理端口<input type="number" min="0" max="65535" value={channelProxy} onChange={event=>field('proxyPort',event.target.value)}/></label></div></details>
      <details><summary>投稿模板 · 分区与标签</summary>
        <p className="bi-muted">大模型暂不可用时，会用本机翻译与有效备用设置继续。</p>
        <Button type="button" disabled={busy||!ready} onClick={async()=>{const result=await action('/categories','GET');if(result)setCategories(result)}}>读取 B 站可投稿分区</Button>
        <div className="bi-form-row"><label>固定分区<select value={form.fixedTid} onChange={event=>field('fixedTid',event.target.value)}><option value="">智能选择</option>{choices(form.fixedTid)}</select></label>
          <label>备用分区<select value={form.fallbackTid} onChange={event=>field('fallbackTid',event.target.value)}><option value="">使用全局默认</option>{choices(form.fallbackTid)}</select></label></div>
        <div className="bi-form-row"><label>固定标签（逗号分隔）<input value={form.fixedTags} onChange={event=>field('fixedTags',event.target.value)}/></label>
          <label>备用标签（逗号分隔）<input value={form.fallbackTags} onChange={event=>field('fallbackTags',event.target.value)}/></label></div>
      </details>
      <div className="bi-actions">
        {!channel&&<button className="pub-button pub-primary" type="submit" value="selectVideos" disabled={busy||!ready}>{busy?'正在添加…':'添加并选择视频'}</button>}
        {channel?<button className="pub-button pub-primary" type="submit" disabled={busy||!ready}>{busy?'正在保存…':'保存频道'}</button>
          :<Button type="submit" disabled={busy||!ready}>仅开始监控</Button>}
        <Button type="button" onClick={()=>navigate('/monitoring')}>{channel?'取消编辑':'打开监控列表'}</Button>
      </div>
    </form>
  </section>
}

const selectionKey = value => JSON.stringify([value.id,value.model])
function PublicationSettings({data,action,busy,focus,setError}){
  const {navigate,useQuery}=useFeatures(),login=useQuery(base+'/login',3000)
  const [autoStart,setAutoStart]=useState(null),[saved,setSaved]=useState('')
  const settings=data.settings || {},accounts=data.accounts || [],ready=accounts.some(item=>item.ready)
  const models=data.metadataModels || [],selected=settings.metadataSelection?selectionKey(settings.metadataSelection):''
  async function update(patch){
    if(await action('/settings','PATCH',patch))setSaved('已保存发布设置。')
  }
  async function startup(enable){
    try{setAutoStart(await globalThis.__YOUDUB2BI_DESKTOP__.autoStart(enable))}
    catch(error){setError(error.message)}
  }
  useEffect(()=>{
    if(focus==='bilibili'||focus==='youtube')document.getElementById('publication-setting-'+focus)?.scrollIntoView?.({block:'nearest'})
  },[focus])
  return <div className="bi-columns">
    <section id="publication-setting-bilibili" className={'bi-card'+(focus==='bilibili'?' bi-active-setting':'')}>
      <h2>B 站账号</h2>
      {accounts.map(account=><div className="bi-account" key={account.id}><strong>{account.name || account.mid || '待扫码账号'}</strong><span className={'bi-badge '+(account.ready?'bi-green':'')}>{account.ready?'已连接':'需要登录'}</span></div>)}
      <p className="bi-muted">用原绑定账号扫码。登录后会继续尚未完成的投稿或核对原稿件。</p>
      <Button disabled={busy||login.data?.state==='waiting'} onClick={()=>action('/login')}>{ready?'重新扫码登录':'扫码登录 B 站'}</Button>
      {login.data?.state==='waiting'&&<div className="bi-qr"><img width="220" height="220" src={login.data.image} alt="使用哔哩哔哩客户端扫描登录二维码"/><p>扫码后在手机上确认。</p></div>}
      {login.data?.state==='success'&&<p className="bi-success" role="status">账号已连接。</p>}
      {login.data?.state==='error'&&<p className="bi-error" role="alert">{login.data.error}</p>}
    </section>
    <YoutubeSettings action={action} busy={busy} active={focus==='youtube'}/>
    <section className="bi-card">
      <h2>投稿文案</h2>
      <label>投稿文案大模型<select disabled={busy} value={selected} onChange={event=>{
        const model=models.find(item=>selectionKey(item)===event.target.value)
        void update({metadataSelection:model?{id:model.id,model:model.model}:null})
      }}><option value="">自动使用当前可用大模型</option>
        {selected&&!models.some(model=>selectionKey(model)===selected)&&<option value={selected} disabled>已保存的大模型暂不可用</option>}
        {models.map(model=><option key={selectionKey(model)} value={selectionKey(model)}>{model.label}</option>)}
      </select></label>
      <p className="bi-muted">大模型不可用时，使用本机翻译和通过校验的备用分区、标签继续投稿。字幕翻译服务可单独配置。</p>
      <div className="bi-actions"><Button onClick={()=>navigate('/settings/models')}>管理大模型</Button><Button onClick={()=>navigate('/settings')}>字幕翻译设置</Button></div>
    </section>
    <section className="bi-card"><h2>运行设置</h2>
      <label>自动化配音档位<select disabled={busy} value={settings.speechPerformance ?? 'quality'} onChange={event=>void update({speechPerformance:event.target.value})}>
        <option value="quality">原质量</option><option value="balanced">均衡（优先 8 步）</option><option value="nano2">NanoVLLM 双路（10 步）</option><option value="nano4">NanoVLLM 四路（10 步）</option>
      </select></label>
      <p className="bi-muted">用于新建的成片任务，包括重新制作。已经开始的任务沿用原档位。NanoVLLM 遇到显存或上下文不足时降低并发续跑，必要时使用原生配音。进度每约 3 秒更新。</p>
      <label>自动化视频编码器<select disabled={busy} value={settings.videoEncoder ?? 'auto'} onChange={event=>void update({videoEncoder:event.target.value})}>
        {videoEncoders.map(({value,label})=><option key={value} value={value}>{typeof label==='string'?label:label.translations.zh}</option>)}
      </select></label>
      <label>自动化下载分辨率上限<select disabled={busy} value={settings.maxHeight ?? 1080} onChange={event=>void update({maxHeight:Number(event.target.value)})}>
        {[360,480,720,1080,1440,2160,4320].map(height=><option key={height} value={height}>{height}p</option>)}
      </select></label>
      <label>公开发布后清理本地素材<select disabled={busy} value={settings.cleanupAfterPublish===false?'keep':'clean'} onChange={event=>void update({cleanupAfterPublish:event.target.value==='clean'})}>
        <option value="clean">自动清理</option><option value="keep">保留本地文件</option>
      </select></label>
      <p className="bi-muted">公开可访问后删除该任务的本地文件，包括原片、字幕、配音和成片。发布记录及 B 站链接会保留。</p>
      <label>新频道默认 YouTube 代理端口<input type="number" min="0" max="65535" key={settings.proxyPort} defaultValue={settings.proxyPort ?? 7897}
        onBlur={event=>{if(event.target.value!==''&&Number(event.target.value)!==(settings.proxyPort??7897))void update({proxyPort:Number(event.target.value)})}}/></label>
      <p className="bi-muted">0 为直连。B 站上传与投稿使用直连。关闭窗口后继续在托盘运行。</p>
      {globalThis.__YOUDUB2BI_DESKTOP__ && <div className="bi-actions"><Button onClick={()=>startup()}>查看开机启动设置</Button>
        {autoStart!==null && <Button onClick={()=>startup(!autoStart)}>{autoStart?'关闭开机启动':'开启开机启动'}</Button>}</div>}
      {saved&&<p className="bi-success" role="status">{saved}</p>}
    </section>
  </div>
}
