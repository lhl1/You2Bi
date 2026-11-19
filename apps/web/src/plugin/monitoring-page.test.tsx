import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutomationPage, MonitoringPage } from '../../../harness/src/frontend/automation-page'

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(), request: vi.fn(), refresh: vi.fn(),
  data: { channels: [] as any[], accounts: [{ id: 'primary', ready: true }], jobs: [], settings: { proxyPort: 7897, paused: true } },
}))
vi.mock('../../../harness/src/frontend/runtime', () => ({ useFeatures: () => ({
  navigate: fixture.navigate, request: fixture.request,
  useQuery: (path: string) => ({ data: path === '/api/v2/automation/configuration' ? fixture.data : {}, refresh: fixture.refresh }),
}) }))
vi.mock('../components/page-layout', () => ({ PageHeader: () => null }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: (props: any) => <button {...props} /> }))

beforeEach(() => {
  fixture.data.channels = [{ id: 'channel-1', name: 'Digital Foundry', handle: '@DigitalFoundry', avatar: '/avatar.jpg', subscriberCount: 1000000, enabled: true, url: 'https://www.youtube.com/@DigitalFoundry', intervalMinutes: 5, proxyPort: 0, workflowId: 'youdub.subtitles-dubbing', template: { fixedTid: 0, fallbackTid: 0, fixedTags: ['游戏'], fallbackTags: [] } }]
  fixture.request.mockResolvedValue({ id: 'channel-1' })
})
afterEach(cleanup)

it('shows channel information and management in a separate list without the add form', async () => {
  render(<MonitoringPage />)
  const card = screen.getByRole('article', { name: 'Digital Foundry' })
  expect(within(card).getByRole('img')).toHaveAttribute('src', '/avatar.jpg')
  expect(within(card).getByText('@DigitalFoundry')).toBeVisible()
  expect(screen.queryByLabelText('频道主页 / @handle / 频道 ID')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '添加频道' }))
  expect(fixture.navigate).toHaveBeenLastCalledWith('/automation?tab=channels')
  await userEvent.click(within(card).getByText('管理', {selector:'summary'}))
  await userEvent.click(within(card).getByRole('button', { name: '编辑' }))
  expect(fixture.navigate).toHaveBeenLastCalledWith('/automation?tab=channels&edit=channel-1')
  await userEvent.click(within(card).getByRole('button', { name: '选择视频' }))
  expect(fixture.navigate).toHaveBeenLastCalledWith('/monitoring/channel-1/videos')
})

it('pauses the selected channel and refreshes the independent list', async () => {
  render(<MonitoringPage />)
  await userEvent.click(screen.getByText('管理', {selector:'summary'}))
  await userEvent.click(screen.getByRole('button', { name: '暂停' }))
  await waitFor(() => expect(fixture.request).toHaveBeenCalledWith('/api/v2/automation/channels/channel-1', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }))
  expect(fixture.refresh).toHaveBeenCalled()
})

it('opens an edit link, preserves direct connection and tags, and returns to the list after saving', async () => {
  render(<AutomationPage params={{ __search: '?tab=channels&edit=channel-1' }} />)
  await waitFor(() => expect(screen.getByLabelText('频道主页 / @handle / 频道 ID')).toHaveValue('https://www.youtube.com/@DigitalFoundry'))
  expect(screen.getByLabelText('YouTube 代理端口')).toHaveValue(0)
  await userEvent.click(screen.getByRole('button', { name: '保存频道' }))
  await waitFor(() => expect(fixture.navigate).toHaveBeenLastCalledWith('/monitoring'))
  const [path, options] = fixture.request.mock.calls[0]
  expect(path).toBe('/api/v2/automation/channels/channel-1')
  expect(options.method).toBe('PATCH')
  expect(JSON.parse(options.body)).toMatchObject({ proxyPort: 0, template: { fixedTags: ['游戏'] } })
})

it('keeps the add page separate and uses the default proxy', async () => {
  render(<AutomationPage params={{ __search: '?tab=channels' }} />)
  await userEvent.click(screen.getByText(/工作流与监控设置/))
  expect(screen.getByLabelText('YouTube 代理端口')).toHaveValue(7897)
  expect(screen.queryByRole('article', { name: 'Digital Foundry' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '打开监控列表' }))
  expect(fixture.navigate).toHaveBeenLastCalledWith('/monitoring')
})

it('adds a YouTuber and opens its video picker directly', async () => {
  render(<AutomationPage params={{ __search: '?tab=channels' }} />)
  await userEvent.type(screen.getByLabelText('频道主页 / @handle / 频道 ID'), '@creator')
  await userEvent.click(screen.getByRole('button', { name: '添加并选择视频' }))
  await waitFor(() => expect(fixture.navigate).toHaveBeenLastCalledWith('/monitoring/channel-1/videos'))
  expect(fixture.request.mock.calls[0][0]).toBe('/api/v2/automation/channels')
})
