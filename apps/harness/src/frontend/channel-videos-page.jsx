import React,{useEffect,useRef,useState} from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PageHeader } from '../../../web/src/components/page-layout'
import { useFeatures } from './runtime'
import { ChannelIdentity } from './automation-page'

const base='/api/v2/automation'
const duration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?[...(value>=3600?[Math.floor(value/3600)]:[]),Math.floor(value/60)%60,Math.floor(value)%60].map((part,index)=>index?String(part).padStart(2,'0'):part).join(':'):'时长待解析'
const published=value=>/^\d{8}$/.test(value || '')?`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}`:'发布日期未提供'

export function ChannelVideosPage({params}){
 const {request,useQuery,navigate}=useFeatures(),overview=useQuery(base,4000)
 const [page,setPage]=useState(null),[selected,setSelected]=useState(()=>new Set()),[filter,setFilter]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null)
 const controller=useRef(null)
 async function load(offset=0){
  controller.current?.abort();const pending=new AbortController();controller.current=pending;setLoading(true);setError('')
  try{const data=await request(`${base}/channels/${encodeURIComponent(params.id)}/videos?offset=${offset}`,{signal:pending.signal});if(pending.signal.aborted)return
   setPage(previous=>({...data,videos:offset?[...new Map([...(previous?.videos || []),...data.videos].map(video=>[video.id,video])).values()]:data.videos}));if(!offset){setSelected(new Set());setResult(null)}
  }catch(cause){if(!pending.signal.aborted)setError(cause.message)}finally{if(!pending.signal.aborted)setLoading(false)}
 }
 useEffect(()=>{void load();return()=>controller.current?.abort()},[params.id])
 const jobs=new Map((page?.videos || []).filter(video=>video.job).map(video=>[video.id,video.job]))
 for(const item of result?.results || [])if(item.job)jobs.set(item.videoId,item.job)
 for(const job of overview.data?.jobs || [])if(job.accountId===page?.channel.accountId)jobs.set(job.videoId,job)
 const failures=new Map((result?.results || []).filter(item=>item.error).map(item=>[item.videoId,item.error]))
 const selectedCount=[...selected].filter(id=>!jobs.has(id)).length
 const videos=page?.videos || [],visible=videos.filter(video=>`${video.title} ${video.id}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
 const available=video=>video.selectable&&!jobs.has(video.id)
 function toggle(id){setSelected(previous=>{const next=new Set([...previous].filter(value=>!jobs.has(value)));if(next.has(id))next.delete(id);else if(next.size<50)next.add(id);return next})}
 async function submit(){
  const videoIds=[...selected].filter(id=>!jobs.has(id));if(!videoIds.length)return
  setBusy(true);setError('');setResult(null)
  try{const value=await request(`${base}/channels/${encodeURIComponent(params.id)}/videos`,{method:'POST',body:JSON.stringify({videoIds})});setResult(value);const addedJobs=new Map(value.results.filter(item=>item.job).map(item=>[item.videoId,item.job]));setPage(previous=>({...previous,videos:previous.videos.map(video=>({...video,job:addedJobs.get(video.id) || video.job}))}));setSelected(new Set(value.results.filter(item=>item.error).map(item=>item.videoId)));void Promise.resolve(overview.refresh()).catch(()=>{})}
  catch(cause){setError(`${cause.message}。若请求中断，请刷新视频列表核对已加入的任务后重试。`)}finally{setBusy(false)}
 }
 return <><PageHeader title="You2Bi · 批量选择视频"/><div className="bi-page">
  <div className="bi-hero"><div><h1>批量选择视频</h1><p>勾选频道视频，加入同一个发布工作台。</p></div><Button disabled={busy} onClick={()=>navigate('/monitoring')}>返回监控列表</Button></div>
  {page && <section className="bi-card bi-video-channel"><ChannelIdentity channel={page.channel}/><p className="bi-muted">沿用该频道的工作流、投稿模板与代理 {page.channel.proxyPort || '直连'}。频道新视频监控{page.channel.enabled?'已开启':'已暂停'}，此处可单独选择历史视频。</p></section>}
  {error && <div className="bi-alert" role="alert">{error}</div>}
  {result && <div className="bi-notice" role="status">本次新增 {result.added} 个任务，已有 {result.duplicates} 个，失败 {result.failed} 个。{result.paused?'队列已暂停，可在发布工作台继续。':'已加入自动化队列，将按顺序处理。'}<Button onClick={()=>navigate('/automation')}>查看执行队列</Button></div>}
  <section className="bi-card">
   <div className="bi-section-title"><div><h2>频道视频</h2><p className="bi-muted">已加载 {videos.length} 个 · 每次最多选择 50 个 · 已有任务自动排除</p></div><Button disabled={loading||busy} onClick={()=>load()}>刷新视频列表</Button></div>
   <label>搜索已加载的视频<input type="search" value={filter} placeholder="输入标题或视频 ID" onChange={event=>setFilter(event.target.value)}/></label>
   <div className="bi-video-toolbar mon-picker-toolbar"><div className="bi-actions"><Button disabled={loading||busy||!visible.some(available)} onClick={()=>setSelected(previous=>new Set([...new Set([...previous].filter(id=>!jobs.has(id)).concat(visible.filter(available).map(video=>video.id)))].slice(0,50)))}>全选当前结果（最多 50 个）</Button><Button disabled={busy||!selectedCount} onClick={()=>setSelected(new Set())}>清空选择</Button></div><div className="bi-actions"><strong aria-live="polite">已选 {selectedCount} 个</strong><button type="button" className="pub-button pub-primary" disabled={busy||loading||!selectedCount} onClick={submit}>{busy?'正在解析并加入队列…':'将所选视频加入自动化队列'}</button></div></div>
   {!page && loading?<p role="status" className="bi-empty">正在读取 YouTube 频道视频…</p>:page&&!visible.length?<p className="bi-empty">{filter?'没有匹配的已加载视频，可清空搜索或加载更多。':'频道暂无可显示的普通视频。'}</p>:null}
   <div className="bi-video-grid mon-picker-grid">{visible.map(video=>{const job=jobs.get(video.id),checked=selected.has(video.id)&&!job;return <article className="bi-video-card" data-selected={checked} key={video.id} aria-label={video.title}>
    <label className="bi-video-select"><input type="checkbox" aria-label={`选择 ${video.title}`} checked={checked} disabled={busy||!available(video)||(!checked&&selectedCount>=50)} onChange={()=>toggle(video.id)}/><span>{checked?'已选择':'选择视频'}</span></label>
    <a href={video.webpage_url} target="_blank" rel="noreferrer"><img src={video.thumbnail} alt={`${video.title} 封面`} loading="lazy" decoding="async"/><h3>{video.title}</h3></a>
    <p className="bi-muted">{duration(video.duration)} · {published(video.upload_date)}</p>
    {job?<div className="bi-actions"><span className="bi-success">已有任务 · {overview.data?.states?.[job.state] || job.state}</span>
      {job.id&&<Button type="button" onClick={()=>navigate('/automation/'+encodeURIComponent(job.id))}>查看发布进度</Button>}</div>:!video.selectable?<p className="bi-muted">{video.unavailableReason || '暂不可选择'}</p>:null}
    {failures.has(video.id) && <p className="bi-error" role="alert">{failures.get(video.id)}</p>}
   </article>})}</div>
   <div className="bi-actions bi-video-more">{page?.nextOffset!==null && page && <Button disabled={loading||busy} onClick={()=>load(page.nextOffset)}>{loading?'正在读取…':'加载更多视频'}</Button>}</div>
  </section>
 </div></>
}
