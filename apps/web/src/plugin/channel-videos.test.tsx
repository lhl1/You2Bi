import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChannelVideosPage } from '../../../harness/src/frontend/channel-videos-page'

const fixture=vi.hoisted(()=>({request:vi.fn(),navigate:vi.fn(),refresh:vi.fn(),data:{jobs:[] as any[],states:{queued:'排队中'}}}))
vi.mock('../../../harness/src/frontend/runtime',()=>({useFeatures:()=>({...fixture,useQuery:()=>({data:fixture.data,refresh:fixture.refresh})})}))
vi.mock('../components/page-layout',()=>({PageHeader:()=>null}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:(props:any)=><button {...props}/>}))
const channel={id:'creator',name:'Creator',handle:'@creator',accountId:'primary',proxyPort:7897,enabled:true}
const video=(id:string,title:string,extra={})=>({id,title,selectable:true,thumbnail:'/cover.jpg',webpage_url:`https://youtube.com/watch?v=${id}`,duration:62,upload_date:'20200102',...extra})
beforeEach(()=>{
 fixture.data.jobs=[]
 fixture.request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST')return {added:1,duplicates:0,failed:0,paused:true,results:[{videoId:'abcdefghijk',job:{id:'job-1',videoId:'abcdefghijk',state:'queued'}}]}
  return {channel,videos:[video('abcdefghijk','Older video'),video('zzzzzzzzzzz','Already queued',{job:{id:'existing',state:'queued'}}),video('yyyyyyyyyyy','Upcoming',{selectable:false,unavailableReason:'直播或未发布视频'})],nextOffset:30}
 })
})
afterEach(cleanup)

it('requires an explicit selection, excludes existing/unavailable videos and reports successful enqueue',async()=>{
 render(<ChannelVideosPage params={{id:'creator'}}/>)
 const old=await screen.findByRole('checkbox',{name:'选择 Older video'})
 expect(old).not.toBeChecked()
 expect(screen.getByRole('checkbox',{name:'选择 Already queued'})).toBeDisabled()
 expect(screen.getByRole('checkbox',{name:'选择 Upcoming'})).toBeDisabled()
 expect(screen.getByRole('button',{name:'将所选视频加入自动化队列'})).toBeDisabled()
 await userEvent.click(old)
 await userEvent.click(screen.getByRole('button',{name:'将所选视频加入自动化队列'}))
 await screen.findByRole('status')
 expect(screen.getByRole('status')).toHaveTextContent('新增 1 个任务')
 const call=fixture.request.mock.calls.find(([,init])=>init?.method==='POST')!
 expect(call[0]).toBe('/api/v2/automation/channels/creator/videos')
 expect(JSON.parse(call[1].body)).toEqual({videoIds:['abcdefghijk']})
 expect(screen.getByRole('checkbox',{name:'选择 Older video'})).toBeDisabled()
 expect(fixture.refresh).toHaveBeenCalled()
})

it('keeps selected IDs across pages, deduplicates rows, and retries only failed videos',async()=>{
 fixture.request.mockImplementation(async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST')return {added:1,duplicates:0,failed:1,paused:true,results:[{videoId:'abcdefghijk',job:{id:'job',state:'queued'}},{videoId:'zzzzzzzzzzz',error:'network unavailable'}]}
  return path.endsWith('offset=0')?{channel,videos:[video('abcdefghijk','First')],nextOffset:30}:{channel,videos:[video('abcdefghijk','First'),video('zzzzzzzzzzz','Second')],nextOffset:null}
 })
 render(<ChannelVideosPage params={{id:'creator'}}/>)
 await userEvent.click(await screen.findByRole('checkbox',{name:'选择 First'}))
 await userEvent.click(screen.getByRole('button',{name:'加载更多视频'}))
 await userEvent.click(await screen.findByRole('checkbox',{name:'选择 Second'}))
 expect(screen.getAllByRole('article')).toHaveLength(2)
 expect(screen.getByRole('checkbox',{name:'选择 First'})).toBeChecked()
 await userEvent.click(screen.getByRole('button',{name:'将所选视频加入自动化队列'}))
 await screen.findByText('network unavailable')
 expect(screen.getByRole('checkbox',{name:'选择 First'})).toBeDisabled()
 expect(screen.getByRole('checkbox',{name:'选择 Second'})).toBeChecked()
 expect(screen.getByText('已选 1 个')).toBeVisible()
})

it('selects only matching available videos and caps bulk selection at 50',async()=>{
 fixture.request.mockResolvedValue({channel,videos:Array.from({length:60},(_,index)=>video(String(index).padStart(11,'0'),`Video ${index}`)),nextOffset:null})
 render(<ChannelVideosPage params={{id:'creator'}}/>)
 await screen.findByRole('checkbox',{name:'选择 Video 0'})
 await userEvent.type(screen.getByRole('searchbox'),'Video 1')
 await userEvent.click(screen.getByRole('button',{name:'全选当前结果（最多 50 个）'}))
 expect(screen.getByText('已选 11 个')).toBeVisible()
 await userEvent.clear(screen.getByRole('searchbox'))
 await userEvent.click(screen.getByRole('button',{name:'全选当前结果（最多 50 个）'}))
 expect(screen.getByText('已选 50 个')).toBeVisible()
 expect(screen.getByRole('checkbox',{name:'选择 Video 59'})).toBeDisabled()
})

it('shows a retryable loading error without creating jobs',async()=>{
 fixture.request.mockRejectedValue(new Error('频道暂不可访问'))
 render(<ChannelVideosPage params={{id:'creator'}}/>)
 expect(await screen.findByRole('alert')).toHaveTextContent('频道暂不可访问')
 expect(fixture.request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
})
