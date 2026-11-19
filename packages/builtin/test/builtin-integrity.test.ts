import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { builtinIntegrities, reviewedIntegrities } from '../src/builtin-integrity.js'

test('execution identities ignore settings and templates but change for the affected model implementation', async () => {
  const edits = new Map<string, string>(), reads = new Set<string>()
  const root = resolve('/app')
  const read = async (path: string) => { reads.add(path); return Buffer.from(edits.get(path) ?? path) }
  const before = await builtinIntegrities(root, read)
  edits.set(join(root, 'apps/harness/src/backend/settings.mjs'), 'unrelated settings change')
  edits.set(join(root, 'apps/harness/src/backend/setup.mjs'), 'unrelated setup change')
  edits.set(join(root, 'packages/builtin/src/workflow-templates/reviewed-subtitles.json'), 'new template')
  assert.deepEqual(await builtinIntegrities(root, read), before)
  assert.ok(!reads.has(join(root, 'apps/harness/src/backend/settings.mjs')))
  edits.set(join(root, 'backend/app/v1/asr.py'), 'new recognition behavior')
  const changed = await builtinIntegrities(root, read)
  assert.notEqual(changed.whisper.integrity, before.whisper.integrity)
  for (const id of Object.keys(before).filter(id => id !== 'whisper')) assert.equal(changed[id].integrity, before[id].integrity, id)
})

test('a reviewed compatibility mapping expires when the current implementation changes', () => {
  const records = { provider: { integrity: 'reviewed-current', previous: ['verified-old'] } }
  assert.deepEqual(reviewedIntegrities('provider', 'reviewed-current', records), ['verified-old'])
  assert.deepEqual(reviewedIntegrities('provider', 'future-unreviewed', records), [])
  assert.deepEqual(reviewedIntegrities('other', 'reviewed-current', records), [])
})
