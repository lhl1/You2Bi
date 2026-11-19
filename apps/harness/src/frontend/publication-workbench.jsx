import React, { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ArrowLeft as IconArrowLeft, ArrowRight as IconArrowRight, Broadcast as IconBroadcast, Check as IconCheck, Clock as IconClock, ExternalLink as IconExternalLink,
  Film as IconMovie, ListDetails as IconListDetails, Link2 as IconLink, Pause as IconPlayerPause, Play as IconPlayerPlay, Plus as IconPlus,
  RefreshCw as IconRefresh, Search as IconSearch, Settings as IconSettings, Upload as IconUpload, X as IconX,
} from '../../../web/src/lib/icons'
import { PageHeader } from '../../../web/src/components/page-layout'
import { useFeatures } from './runtime'

const base = '/api/v2/automation'
const filters = [
  ['', '全部'], ['active', '进行中'], ['attention', '待处理'],
  ['review', '审核中'], ['published', '已发布'], ['stopped', '已停止'],
]
const progressLabel = {
  download:'下载进度', translation:'当前识别或翻译步骤进度', export:'当前配音或导出步骤进度', upload:'上传进度',
}
const primaryActions = {edit:'编辑投稿文案',login:'前往登录',resume:'继续任务',retry:'重试当前阶段',verify:'核对原稿件'}
const stopPolling = new Set(['published','private_ready','rejected','cancelled'])
const detailPoll = data => data.publication.cleanupPending || !stopPolling.has(data.publication.state)
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'})
const date = stamp => Number.isFinite(stamp) && stamp>0 ? dateFormatter.format(stamp) : ''
const duration = value => {
  if (!Number.isFinite(value) || value<=0) return '时长待解析'
  const seconds=Math.floor(value), tail=String(seconds%60).padStart(2,'0')
  if (seconds<3600) return `${Math.floor(seconds/60)}:${tail}`
  return `${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${tail}`
}
const bytes = amount => amount>=1073741824 ? (amount/1073741824).toFixed(2)+' GB'
  : amount>=1048576 ? (amount/1048576).toFixed(1)+' MB' : (amount/1024).toFixed(0)+' KB'
const elapsed = ms => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '用时待记录'
  const seconds = Math.round(ms / 1000)
  return seconds >= 3600 ? Math.floor(seconds / 3600)+'小时'+(Math.floor(seconds / 60) % 60)+'分'+(seconds % 60)+'秒'
    : seconds >= 60 ? Math.floor(seconds / 60)+'分'+(seconds % 60)+'秒' : seconds+'秒'
}
const detailPath = id => '/automation/'+encodeURIComponent(id)

function useMutation() {
  const {request}=useFeatures()
  const [busy,setBusy]=useState(null),[error,setError]=useState('')
  async function mutate(path,method='POST',body) {
    setBusy(path);setError('')
    try{return await request(base+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})})}
    catch(failure){setError(failure.message);return null}
    finally{setBusy(null)}
  }
  return {mutate,busy,error}
}

export function PublicationPill({ group, children }) {
  return <span className="pub-pill" data-group={group || 'stopped'}><span aria-hidden="true" />{children}</span>
}

function Thumbnail({src,large=false}) {
  const [failed,setFailed]=useState(false)
  return <div className={'pub-thumb'+(large?' pub-thumb-large':'')}>
    {typeof src==='string' && (src.startsWith('https://') || src.startsWith('/api/youdub/file?')) && !failed
      ? <img src={src} alt="" loading={large?'eager':'lazy'} referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>
      : <IconMovie size={large?32:20} aria-hidden="true"/>}
  </div>
}

function InlineProgress({job,value=job.progress,showBytes=false}) {
  if(!Number.isFinite(value))return null
  const label=progressLabel[job.phase] || '当前步骤进度'
  return <div className="pub-progress">
    <progress aria-label={label} max="100" value={value}/>
    <span>{value}%</span>
    {showBytes && job.upload && <small>{bytes(job.upload.bytes)} / {bytes(job.upload.total)}</small>}
  </div>
}

export function PublicationWorkbench({focusInput=false}) {
  const {useQuery,navigate}=useFeatures(),{mutate,busy,error}=useMutation()
  const [criteria,setCriteria]=useState({group:'',q:'',offset:0}),[search,setSearch]=useState(''),[url,setUrl]=useState('')
  const query=useQuery(base+'/jobs?'+new URLSearchParams({limit:'24',...criteria}),2500)
  const page=query.data, account=page?.accounts?.find(item=>item.ready)
  const counts=page?.counts, items=page?.items ?? []
  const nextGroup=group=>setCriteria(prev=>({...prev,group,offset:0}))
  async function add(event) {
    event.preventDefault()
    if(!url.trim())return
    const result=await mutate('/videos','POST',{url:url.trim()})
    if(result?.job?.id){setUrl('');navigate(detailPath(result.job.id))}
  }
  async function pause() {
    if(page && await mutate('/settings','PATCH',{paused:!page.paused}))await query.refresh()
  }
  return <>
    <PageHeader title="发布工作台"/>
    <div className="pub-page">
      <header className="pub-header">
        <div><div className="pub-kicker"><IconBroadcast size={16} aria-hidden="true"/> YOUTUBE → BILIBILI</div>
          <h1>发布工作台</h1><p>跟踪字幕、配音和投稿。每条视频的成片与稿件都在这里。</p></div>
        <div className="pub-header-actions">
          {page && <PublicationPill group={page.paused?'attention':account?'published':'stopped'}>{page.paused?'队列已暂停':account?'B 站账号已连接':'B 站未连接'}</PublicationPill>}
          <Button onClick={()=>navigate('/automation?tab=settings')}><IconSettings size={17} aria-hidden="true"/>发布设置</Button>
        </div>
      </header>

      <section className="pub-add pub-panel" aria-label="新建自动发布任务">
        <div className="pub-add-icon"><IconLink size={23} aria-hidden="true"/></div>
        <form onSubmit={add}>
          <label htmlFor="pub-video-url">添加 YouTube 视频</label>
          <div className="pub-input-row">
            <input id="pub-video-url" value={url} required autoFocus={focusInput} onChange={event=>setUrl(event.target.value)} placeholder="粘贴 YouTube 视频链接" autoComplete="off" spellCheck={false}/>
            <button className="pub-button pub-primary" disabled={busy!==null || !account || !url.trim()} type="submit"><IconPlus size={18} aria-hidden="true"/>{busy==='/videos'?'正在解析…':'加入队列'}</button>
          </div>
        </form>
        <button className="pub-link" type="button" onClick={()=>navigate('/automation?tab=video')}>更多选项 <IconArrowRight size={15} aria-hidden="true"/></button>
      </section>

      {page && !account && <div className="pub-callout"><span>连接 B 站账号后即可添加自动投稿任务。</span><button className="pub-link" onClick={()=>navigate('/automation?tab=settings&focus=bilibili')}>去登录</button></div>}
      {page?.paused && <div className="pub-callout" role="status">队列已暂停。继续后会保留成片和已完成的投稿步骤。</div>}
      {!page?.paused && page?.blockedUntil > Date.now() && <div className="pub-callout" role="status">B 站请求正在冷却，预计 {date(page.blockedUntil)} 继续；成片处理仍可运行。</div>}
      {(error || query.error) && <div className="pub-callout pub-error" role="alert">{error || (page?'刷新失败，正在重连：':'读取发布列表失败：')+query.error}</div>}

      <section className="pub-panel pub-queue" aria-labelledby="pub-queue-title">
        <div className="pub-queue-head"><div><h2 id="pub-queue-title">发布队列</h2><p>{counts ? '共 '+counts.all+' 条任务' : '等待读取任务'}</p></div>
          <div className="pub-tools">
            {page && <Button disabled={busy!==null} onClick={pause}>{page.paused?<IconPlayerPlay size={16}/>:<IconPlayerPause size={16}/>}
              {page.paused?'继续队列':'暂停队列'}</Button>}
            <Button onClick={query.refresh} aria-label="刷新发布队列" title="刷新"><IconRefresh size={17} aria-hidden="true"/></Button>
          </div>
        </div>
        <div className="pub-toolbar">
          <div className="pub-filters" role="group" aria-label="按发布状态筛选">
            {filters.map(([id,label])=><button key={id} type="button" aria-pressed={criteria.group===id} onClick={()=>nextGroup(id)}>
              {label}{counts && <span>{counts[id||'all'] ?? 0}</span>}</button>)}
          </div>
          <form className="pub-search" role="search" onSubmit={event=>{event.preventDefault();setCriteria(prev=>({...prev,q:search.trim(),offset:0}))}}>
            <button type="submit" aria-label="搜索任务"><IconSearch size={17} aria-hidden="true"/></button>
            <input type="search" value={search} onChange={event=>{setSearch(event.target.value);if(!event.target.value)setCriteria(prev=>({...prev,q:'',offset:0}))}}
              maxLength={160} placeholder="标题或频道" aria-label="搜索标题或频道"/>
          </form>
        </div>
        {!page && !query.error && <div className="pub-empty" role="status">正在读取发布队列…</div>}
        {page && !items.length && <div className="pub-empty"><IconListDetails size={28} aria-hidden="true"/>
          <strong>{criteria.group || criteria.q?'没有符合条件的任务':'发布队列还是空的'}</strong>
          <p>{criteria.group || criteria.q?'试试切换筛选或清空搜索。':'粘贴视频链接，或到频道监控里批量选片。'}</p>
          {!criteria.group&&!criteria.q&&<button className="pub-link" onClick={()=>navigate('/monitoring')}>打开频道监控 <IconArrowRight size={15}/></button>}
        </div>}
        {items.length>0 && <ul className="pub-list" aria-label="发布任务">
          {items.map(job=><li key={job.id}><JobRow job={job} open={()=>navigate(detailPath(job.id))}/></li>)}
        </ul>}
        {(criteria.offset>0 || page?.hasMore) && <div className="pub-pagination">
          <span>第 {criteria.offset/24+1} 页</span>
          <Button disabled={!criteria.offset} onClick={()=>setCriteria(prev=>({...prev,offset:Math.max(0,prev.offset-24)}))}>上一页</Button>
          <Button disabled={!page?.hasMore} onClick={()=>setCriteria(prev=>({...prev,offset:prev.offset+24}))}>下一页</Button>
        </div>}
      </section>
    </div>
  </>
}

function JobRow({job,open}) {
  const note=job.group==='active'?job.message:job.group==='attention'?job.error?.message:job.group==='review'?job.reviewReason:null
  return <article className="pub-job-row">
    <Thumbnail src={job.thumbnail}/>
    <div className="pub-job-name"><button type="button" onClick={open} aria-label={job.title+' · '+job.status}><strong title={job.title}>{job.title}</strong></button><span>{duration(job.durationSeconds)} · {job.channel || 'YouTube'}{job.mediaReady && <> · 成片已导出</>}{job.productionTiming?.totalMs != null && <> · 制作 {elapsed(job.productionTiming.totalMs)}</>}</span></div>
    <div className="pub-row-stage"><PublicationPill group={job.group}>{job.status}</PublicationPill>
      {note && <span title={note}>{note}</span>}
      <InlineProgress job={job}/>
    </div>
    <time className="pub-row-date" dateTime={job.updatedAt?new Date(job.updatedAt).toISOString():undefined}>{date(job.updatedAt)}</time>
    <IconArrowRight className="pub-row-arrow" size={17} aria-hidden="true"/>
  </article>
}

export function PublicationDetail({params}) {
  const {useQuery,navigate}=useFeatures(),{mutate,busy,error}=useMutation()
  const path='/jobs/'+encodeURIComponent(params.id)
  const query=useQuery(base+path,1800,detailPoll)
  const [editing,setEditing]=useState(false),[showStop,setShowStop]=useState(false)
  const [showCleanup,setShowCleanup]=useState(false),[showRemake,setShowRemake]=useState(false)
  const info=query.data, job=info?.publication
  async function action(value) {
    if(value==='edit'){setEditing(true);return}
    if(value==='login'){
      navigate('/automation?tab=settings&focus='+(job.state==='needs_youtube_login'?'youtube':'bilibili'));return
    }
    if(await mutate(path+'/'+value)){setShowStop(false);setShowCleanup(false);setShowRemake(false);await query.refresh()}
  }
  const locked=!!busy || !!job?.busy
  return <>
    <PageHeader title="发布详情"/>
    <div className="pub-page pub-detail">
      <button type="button" className="pub-back" onClick={()=>navigate('/automation')}><IconArrowLeft size={17} aria-hidden="true"/>返回发布工作台</button>
      {query.error && <div className="pub-callout pub-error" role="alert">{job?'刷新失败：':''}{query.error} <Button onClick={query.refresh}>重新加载</Button></div>}
      {!job && !query.error && <div className="pub-empty" role="status">正在读取发布详情…</div>}
      {job && <>
        <section className="pub-panel pub-detail-hero">
          <Thumbnail src={job.thumbnail} large/>
          <div className="pub-detail-name"><PublicationPill group={job.group}>{job.status}</PublicationPill>
            <h1>{job.title}</h1><p>{job.channel || 'YouTube'}{job.cleanedAt?' · 本地已清理':job.mediaReady?' · 成片已导出':''}</p>
            <div className="pub-detail-links">
              {job.sourceUrl && <a href={job.sourceUrl} rel="noreferrer" target="_blank">原视频 <IconExternalLink size={15} aria-hidden="true"/></a>}
              {job.mediaAvailable && <button className="pub-link" type="button" onClick={()=>navigate('/tasks/'+encodeURIComponent(job.taskId))}>打开成片任务 <IconArrowRight size={15} aria-hidden="true"/></button>}
              {job.archive?.url && <a href={job.archive.url} rel="noreferrer" target="_blank">打开 B 站稿件 <IconExternalLink size={15} aria-hidden="true"/></a>}
            </div>
            {job.canRemake && <div className="pub-remake">
              {showRemake ? <>
                <p>{job.cleanedAt?'将重新下载 YouTube 原视频并制作。':'将从 YouTube 原视频重新制作。'}新成片上传后会替换{job.archive?.bvid ? ` ${job.archive.bvid} 的` : '原稿件的'}视频源，并由 B 站重新审核。</p>
                <div className="pub-detail-actions">
                  <button className="pub-button pub-primary" type="button" disabled={locked} onClick={()=>action('remake')}>确认重新制作</button>
                  <Button disabled={locked} onClick={()=>setShowRemake(false)}>返回</Button>
                </div>
              </> : <button className="pub-button pub-primary" type="button" disabled={locked} onClick={()=>setShowRemake(true)}>重新制作并上传</button>}
            </div>}
          </div>
        </section>
        {job.paused&&!stopPolling.has(job.state)&&<div className="pub-callout">全局队列已暂停。可在发布工作台继续队列。</div>}
        {job.error && job.state!=='cancelled' && <div className="pub-callout pub-error" role="alert"><div><strong>{job.phaseLabel} · {job.status}</strong>
          <p>{job.error.message}</p>{job.error.hint&&<p>{job.error.hint}</p>}</div></div>}
        {error && <div className="pub-callout pub-error" role="alert">{error}</div>}

        <div className="pub-detail-columns" data-urgent={job.group==='attention'}>
          <section className="pub-panel pub-detail-card" aria-labelledby="publication-progress-title">
            <h2 id="publication-progress-title">发布进度</h2>
            <ol className="pub-timeline">
              {job.timeline.map((step,index)=><li key={step.id} data-state={step.status}>
                <span className="pub-marker" aria-hidden="true">{step.status==='done'?<IconCheck size={17}/>:index+1}</span>
                <div><strong>{step.label}</strong>{step.status==='done'?<small>已完成</small>:null}
                  {step.status!=='done' && step.id===job.phase && <p>{step.message || job.reviewReason || job.message}</p>}
                  {step.status!=='done'&&step.id==='upload'&&<InlineProgress job={job} value={step.progress} showBytes/>}
                  {!['done','pending'].includes(step.status)&&step.id!=='upload'&&<InlineProgress job={job} value={step.progress}/>}
                </div>
              </li>)}
            </ol>
          </section>
          <aside className="pub-panel pub-detail-card">
            <h2>任务信息</h2>
            <dl className="pub-facts">
              <dt>当前阶段</dt><dd>{job.phaseLabel}</dd>
              {job.replacing && <><dt>发布方式</dt><dd>替换原 B 站稿件的视频源</dd></>}
              <dt>视频时长</dt><dd>{duration(job.durationSeconds)}</dd>
              {job.productionTiming?.totalMs != null && <><dt>制作总用时</dt><dd>{elapsed(job.productionTiming.totalMs)}</dd></>}
              <dt>成片</dt><dd>{job.cleanedAt?'本地文件已清理':job.mediaReady?'已导出':job.mediaStatus==='failed'?'处理失败':'尚未导出'}</dd>
              {job.dubbedSegments===0 && <><dt>音轨</dt><dd>全片保留原声</dd></>}
              {job.dubbedSegments>0 && <><dt>音轨</dt><dd>中文配音 {job.dubbedSegments} 段 · 保留原声 {job.preservedRanges} 段</dd></>}
              {job.cleanupPending && <><dt>素材清理</dt><dd>{job.cleanupError?'等待重试':'等待清理'}</dd></>}
              {job.cleanupError && <><dt>清理信息</dt><dd>{job.cleanupError}</dd></>}
              {info.draft?.origin==='local'&&<><dt>投稿文案</dt><dd>本机翻译 · 备用分区与标签</dd></>}
              {job.archive?.bvid && <><dt>BV 号</dt><dd>{job.archive.bvid}</dd></>}
              {!job.archive?.bvid&&job.archive?.aid&&<><dt>稿件号</dt><dd>{job.archive.aid}</dd></>}
              {job.lastReviewAt && <><dt>最近核对</dt><dd>{date(job.lastReviewAt)}</dd></>}
              {job.nextRunAt && <><dt>下次检查</dt><dd>{date(job.nextRunAt)}</dd></>}
              <dt>最近更新</dt><dd>{date(job.updatedAt)}</dd>
            </dl>
            <div className="pub-detail-actions">
              {job.action && <button className="pub-button pub-primary" type="button" disabled={locked} onClick={()=>action(job.action)}>{primaryActions[job.action]}</button>}
              {job.canEdit&&job.action!=='edit'&&<Button disabled={locked} onClick={()=>setEditing(true)}>编辑文案</Button>}
              {job.canPause&&<Button disabled={locked} onClick={()=>action('pause')}>暂停</Button>}
              <Button onClick={query.refresh} aria-label="刷新发布详情"><IconRefresh size={16} aria-hidden="true"/></Button>
            </div>
            {job.canCancel && (!showStop?<button className="pub-link pub-danger" type="button" onClick={()=>setShowStop(true)}>取消任务</button>
              :<div className="pub-cancel"><p>停止后续投稿，已导出的文件仍保留。</p><Button disabled={locked} onClick={()=>action('cancel')}>确认取消</Button>
                <Button onClick={()=>setShowStop(false)}>返回</Button></div>)}
            {job.canCleanup && (!showCleanup?<button className="pub-link pub-danger" type="button" onClick={()=>setShowCleanup(true)}>清理本地素材</button>
              :<div className="pub-cancel"><p>永久删除这条任务的本地素材和成片，保留 B 站稿件和发布记录。</p><Button disabled={locked} onClick={()=>action('cleanup')}>确认清理</Button>
                <Button onClick={()=>setShowCleanup(false)}>返回</Button></div>)}
            {job.state==='rejected'&&<a className="pub-link" target="_blank" rel="noreferrer" href="https://member.bilibili.com/">打开 B 站创作中心 <IconExternalLink size={15}/></a>}
          </aside>
        </div>
        {!!job.productionTiming?.stages?.length && <details className="pub-panel pub-disclosure">
          <summary>制作各阶段用时</summary>
          <dl className="pub-facts">{job.productionTiming.stages.map(stage => <React.Fragment key={stage.id}>
            <dt>{typeof stage.label === 'string' ? stage.label : stage.label?.translations?.zh || stage.label?.default || stage.id}</dt>
            <dd>{elapsed(stage.durationMs)}</dd>
          </React.Fragment>)}</dl>
        </details>}
        {editing && <MetadataDraft key={job.id} info={info} onClose={()=>setEditing(false)} onSave={async input=>{
          const ok=await mutate(path+'/metadata','PATCH',input)
          if(ok){setEditing(false);await query.refresh()}
          return ok
        }}/>}
        {info.metadata && !editing && <details className="pub-panel pub-disclosure">
          <summary>查看投稿文案</summary><h3>{info.metadata.title}</h3>
          <p className="pub-tags">{info.metadata.tags?.map(tag=><span key={tag}>{tag}</span>)}</p>
          <pre>{info.metadata.desc}</pre>
        </details>}
        <details className="pub-panel pub-disclosure"><summary>任务记录</summary>
          {!info.events?.length?<p>还没有任务记录。</p>:<ol className="pub-events">{info.events.map((event,index)=>
            <li key={event.time+'-'+index}><IconClock size={15} aria-hidden="true"/><time dateTime={new Date(event.time).toISOString()}>{date(event.time)}</time><span>{event.message}</span></li>
          )}</ol>}
        </details>
      </>}
    </div>
  </>
}

function MetadataDraft({info,onClose,onSave}) {
  const {useQuery}=useFeatures(),{publication:job,draft}=info
  const cats=useQuery(base+'/categories?accountId='+encodeURIComponent(job.accountId))
  const [title,setTitle]=useState(draft.title || ''),[description,setDescription]=useState(draft.description || '')
  const [tagText,setTagText]=useState((draft.tags || []).join('，')),[tid,setTid]=useState(draft.tid || '')
  const [revision]=useState(info.revision),[saving,setSaving]=useState(false),[failed,setFailed]=useState(false)
  const originalUnavailable=tid && cats.data && !cats.data.some(category=>category.id===Number(tid))
  async function submit(event) {
    event.preventDefault();setSaving(true);setFailed(false)
    if(!await onSave({title,description,tid:Number(tid),tags:tagText.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean),expectedUpdatedAt:revision}))setFailed(true)
    setSaving(false)
  }
  return <section className="pub-panel pub-detail-card pub-edit" aria-labelledby="pub-edit-title">
    <header><h2 id="pub-edit-title">编辑投稿文案</h2><Button type="button" onClick={onClose} aria-label="关闭文案编辑"><IconX size={17}/></Button></header>
    <p>保存后继续原稿件。标题前缀和原视频来源说明由程序补齐。</p>
    {cats.error && <div className="pub-callout pub-error" role="alert">{cats.error}<Button onClick={cats.refresh}>重试读取分区</Button></div>}
    <form onSubmit={submit}>
      <label>中文标题<input value={title} required maxLength={400} onChange={event=>setTitle(event.target.value)}/></label>
      <label>原简介中文翻译<textarea value={description} rows={6} maxLength={100000} onChange={event=>setDescription(event.target.value)}/></label>
      <div className="pub-edit-grid"><label>投稿分区<select value={tid} onChange={event=>setTid(event.target.value)} required>
        <option value="">{cats.data?'选择分区':'正在读取分区…'}</option>
        {originalUnavailable&&<option value={tid} disabled>原分区不可用，请重新选择</option>}
        {cats.data?.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      <label>投稿标签（逗号分隔，最多 6 个）<input value={tagText} required maxLength={180} onChange={event=>setTagText(event.target.value)}/></label></div>
      {failed&&<p role="alert">文案未保存，当前填写内容已保留。请检查上方错误后再试。</p>}
      <button className="pub-button pub-primary" type="submit" disabled={saving || !cats.data || !!originalUnavailable}><IconUpload size={17} aria-hidden="true"/>{saving?'正在保存…':'保存并继续'}</button>
    </form>
  </section>
}
