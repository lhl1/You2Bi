import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/test/language-provider'
import { ConfigEditor } from './builtin/schema-form'
import type { Bindings } from './sdk'
import { nodeDescriptors } from '../../../../packages/builtin/src/node-contracts'

const schema = { type: 'object', properties: {
  speechCleanup: nodeDescriptors.synthesize.configSchema.properties!.speechCleanup,
  speechPerformance: nodeDescriptors.synthesize.configSchema.properties!.speechPerformance,
  maxSpeechRate: nodeDescriptors.mix.configSchema.properties!.maxSpeechRate,
} }
const useSlot = (() => []) as Bindings<'useSlot'>['useSlot']
afterEach(() => { cleanup(); window.localStorage.clear() })

it('shows the effective quality defaults for older saved workflows with missing fields', () => {
  render(<LanguageProvider><ConfigEditor ownerId="quality" useSlot={useSlot} diagnostics={[]} readOnly={false} value={{}} schema={schema} onChange={vi.fn()} /></LanguageProvider>)
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(screen.getByRole('spinbutton')).toHaveValue(1.5)
  expect(screen.getByRole('button', { name: '配音档位' })).toHaveTextContent('原质量')
})

it('writes an explicitly selected dubbing profile', async () => {
  const changed = vi.fn()
  render(<LanguageProvider><ConfigEditor ownerId="quality" useSlot={useSlot} diagnostics={[]} readOnly={false} value={{}} schema={schema} onChange={changed} /></LanguageProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '配音档位' }))
  await user.click(screen.getByText('均衡（优先 8 步）'))
  expect(changed).toHaveBeenLastCalledWith({ speechPerformance: 'balanced' })
})

it('keeps an explicit disabled quality option and persists turning the default off', async () => {
  const changed = vi.fn()
  const view = render(<LanguageProvider><ConfigEditor ownerId="quality" useSlot={useSlot} diagnostics={[]} readOnly={false} value={{ speechCleanup: false, maxSpeechRate: 1.2 }} schema={schema} onChange={changed} /></LanguageProvider>)
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('spinbutton')).toHaveValue(1.2)
  view.rerender(<LanguageProvider><ConfigEditor ownerId="quality" useSlot={useSlot} diagnostics={[]} readOnly={false} value={{}} schema={schema} onChange={changed} /></LanguageProvider>)
  await userEvent.setup().click(screen.getByRole('checkbox'))
  expect(changed).toHaveBeenLastCalledWith({ speechCleanup: false })
})


it.each([['NanoVLLM 双路（10 步）', 'nano2'], ['NanoVLLM 四路（10 步）', 'nano4']])('persists %s', async (label, value) => {
  const changed = vi.fn()
  render(<LanguageProvider><ConfigEditor ownerId="nano" useSlot={useSlot} diagnostics={[]} readOnly={false} value={{}} schema={schema} onChange={changed} /></LanguageProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '配音档位' }))
  await user.click(screen.getByText(label))
  expect(changed).toHaveBeenLastCalledWith({ speechPerformance: value })
})

