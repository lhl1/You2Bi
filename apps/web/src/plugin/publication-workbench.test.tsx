import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PublicationDetail, PublicationWorkbench } from '../../../harness/src/frontend/publication-workbench'

const mock = vi.hoisted(() => ({
  navigate:vi.fn(), request:vi.fn(), refresh:vi.fn(), paths:[] as string[], overview:null as any, detail:null as any,
}))
vi.mock('../../../harness/src/frontend/runtime', () => ({ useFeatures:() => ({
  navigate:mock.navigate,request:mock.request,
  useQuery:(path:string) => {
    mock.paths.push(path)
    const data=path.includes('/categories')?[{id:17,name:'单机游戏'}]:path.includes('/jobs?')?mock.overview:mock.detail
    return {data,refresh:mock.refresh}
  },
}) }))
vi.mock('../components/page-layout', () => ({ PageHeader:() => null }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button:(props:any) => <button {...props}/> }))
beforeEach(() => {
  mock.paths=[]
  mock.detail={publication:{id:'job1',title:'PS5 游戏',channel:'MVG',phase:'upload',phaseLabel:'上传视频',progress:30,
    mediaReady:true,mediaStatus:'succeeded',mediaAvailable:true,taskId:'task1',accountId:'primary',group:'active',state:'uploading',status:'上传中',
    updatedAt:Date.UTC(2026,10,18,1),upload:{bytes:3145728,total:10485760},timeline:[
      {id:'export',label:'配音与导出',status:'done'}, {id:'upload',label:'上传视频',status:'current',progress:30},
      {id:'review',label:'B 站审核',status:'pending'},
    ]},events:[],revision:44,draft:{title:'测试译名',description:'本地译文',tid:17,tags:['游戏']}}
  mock.overview={counts:{all:1,attention:1},accounts:[{id:'primary',ready:true}],items:[mock.detail.publication]}
  mock.request.mockResolvedValue({job:{id:'job1'}})
})
afterEach(cleanup)

it('shows real progress separately from exported media and opens one shared detail', async () => {
  render(<PublicationWorkbench/>)
  expect(screen.getByText(/成片已导出/)).toBeVisible()
  expect(screen.getByRole('progressbar',{name:'上传进度'})).toHaveAttribute('value','30')
  expect(screen.queryByText('已发布',{exact:true,selector:'.pub-pill'})).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button',{name:'PS5 游戏 · 上传中'}))
  expect(mock.navigate).toHaveBeenLastCalledWith('/automation/job1')
  await userEvent.click(screen.getByRole('button',{name:/待处理/}))
  expect(mock.paths.at(-1)).toContain('group=attention')
})

it('shows minutes, hours and unavailable durations in the publication queue', () => {
  const job=mock.detail.publication
  mock.overview.items=[{...job,durationSeconds:705.183},{...job,id:'job2',durationSeconds:3674},{...job,id:'job3'}]
  render(<PublicationWorkbench/>);
  expect(screen.getByText(/11:45 · MVG/)).toBeVisible()
  expect(screen.getByText(/1:01:14 · MVG/)).toBeVisible()
  expect(screen.getByText(/时长待解析 · MVG/)).toBeVisible()
})

it('offers remake in the published detail even after local cleanup', async () => {
  mock.request.mockClear()
  Object.assign(mock.detail.publication,{state:'published',status:'已发布',group:'published',canRemake:true,
    cleanedAt:Date.UTC(2026,10,18,1),mediaReady:false,mediaAvailable:false,archive:{bvid:'BV1abcdefghi'}})
  render(<PublicationDetail params={{id:'job1'}}/>)
  const user=userEvent.setup()
  expect(screen.queryByRole('button',{name:'打开成片任务'})).toBeNull()
  await user.click(screen.getByRole('button',{name:'重新制作并上传'}))
  expect(screen.getByText(/重新下载 YouTube 原视频.*BV1abcdefghi/)).toBeVisible()
  expect(mock.request).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button',{name:'确认重新制作'}))
  expect(mock.request).toHaveBeenLastCalledWith('/api/v2/automation/jobs/job1/remake',{method:'POST'})
})

it('adds a URL directly and takes the user to the original job even for a duplicate', async () => {
  render(<PublicationWorkbench/>)
  const url='https://youtu.be/Ox4PTEePy3w'
  await userEvent.type(screen.getByLabelText('添加 YouTube 视频'),url)
  await userEvent.click(screen.getByRole('button',{name:'加入队列'}))
  expect(mock.request).toHaveBeenLastCalledWith('/api/v2/automation/videos',{method:'POST',body:JSON.stringify({url})})
  expect(mock.navigate).toHaveBeenLastCalledWith('/automation/job1')
})

it('exposes progress in bytes and only offers verify when submission is uncertain', async () => {
  const view=render(<PublicationDetail params={{id:'job1'}}/>)
  expect(screen.getByText('3.0 MB / 10.0 MB')).toBeVisible()
  Object.assign(mock.detail.publication,{state:'reconciling',status:'核对投稿结果',group:'review',phase:'review',action:'verify',progress:null,
    timeline:[{id:'review',label:'B 站审核',status:'current'}]})
  view.rerender(<PublicationDetail params={{id:'job1'}}/>)
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  expect(screen.queryByRole('button',{name:/重试/})).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button',{name:'核对原稿件'}))
  expect(mock.request).toHaveBeenLastCalledWith('/api/v2/automation/jobs/job1/verify',{method:'POST'})
})

it('lets users save an incomplete draft without re-running media', async () => {
  Object.assign(mock.detail.publication,{state:'needs_attention',status:'文案待处理',group:'attention',action:'edit',canEdit:true,phase:'metadata'})
  render(<PublicationDetail params={{id:'job1'}}/>)
  await userEvent.click(screen.getByRole('button',{name:'编辑投稿文案'}))
  const edit=screen.getByRole('region',{name:'编辑投稿文案'})
  await userEvent.click(within(edit).getByRole('button',{name:'保存并继续'}))
  expect(mock.request).toHaveBeenLastCalledWith('/api/v2/automation/jobs/job1/metadata',{method:'PATCH',body:JSON.stringify({
    title:'测试译名',description:'本地译文',tid:17,tags:['游戏'],expectedUpdatedAt:44,
  })})
})


it('shows completed production time in the queue and individual stage times in the detail', () => {
  const timing={totalMs:190000,stages:[{id:'translate',label:'翻译',durationMs:70000},{id:'synthesize',label:'生成配音',durationMs:120000}]}
  mock.detail.publication.productionTiming=timing
  render(<PublicationWorkbench/>)
  expect(screen.getByText(/制作 3分10秒/)).toBeVisible()
  cleanup()
  render(<PublicationDetail params={{id:'job1'}}/>)
  expect(screen.getByText('制作总用时')).toBeVisible()
  expect(screen.getByText('3分10秒')).toBeVisible()
  expect(screen.getByText('1分10秒')).toBeInTheDocument()
  expect(screen.getByText('2分0秒')).toBeInTheDocument()
})

