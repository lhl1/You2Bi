import type { OutputPort, JsonObject, ProviderDescription } from '@youdub/sdk'
import { nodeDescriptors, outputPortLabels } from './node-contracts.js'
import { artifactRef, mediaSchemas } from './media-schemas.js'

const artifact = (name: string, schemaId: string, required = true): OutputPort => ({ name, schemaId, kind: 'artifact', required })
const json = (name: string, schemaId: string): OutputPort => ({ name, schemaId, kind: 'json', required: true, schema: mediaSchemas[schemaId] })
const input = (properties: Record<string, JsonObject>, required = Object.keys(properties)): JsonObject => ({
  type: 'object', additionalProperties: false, required, properties,
})
const audio = artifactRef('audio/wav/v1')
const video = artifactRef('file/v1', 'video/mp4/v1')
const subtitles = artifactRef('file/v1', 'application/x-subrip/v1')
const transcript = mediaSchemas['transcript/v1']
const translation = mediaSchemas['translation/v1']
const mediaInfo = mediaSchemas['media-info/v1']
const speechAudio = mediaSchemas['speech-audio/v1']
const dubbedTimeline = mediaSchemas['dubbed-timeline/v1']

export const operations: Record<string, ProviderDescription['operations'][number]> = {
  download: { id: 'media.download/v1', inputSchema: input({ url: { type: 'string', minLength: 1 } }), outputs: [artifact('video', 'video/mp4/v1')] },
  prepare: { id: 'media.prepare/v1', inputSchema: input({ video }), outputs: [artifact('sourceAudio', 'audio/wav/v1'), json('mediaInfo', 'media-info/v1')] },
  separate: { id: 'audio.separate/v1', inputSchema: input({ sourceAudio: audio }), outputs: [artifact('vocals', 'audio/wav/v1'), artifact('background', 'audio/wav/v1')] },
  recognize: { id: 'speech.transcribe/v1', inputSchema: input({ audio, mediaInfo }), outputs: [json('transcript', 'transcript/v1'), artifact('raw', 'diagnostic/json/v1', false)] },
  translate: { id: 'text.translate/v1', inputSchema: input({ transcript }), outputs: [json('translation', 'translation/v1')] },
  reference: { id: 'voice.reference/v1', inputSchema: input({ transcript, audio }), outputs: [json('references', 'voice-references/v1')] },
  synthesize: { id: 'speech.synthesize/v1', inputSchema: input({ transcript, translation, references: mediaSchemas['voice-references/v1'] }, ['transcript', 'translation']), outputs: [json('speechAudio', 'speech-audio/v1')] },
  mix: { id: 'audio.mix/v1', inputSchema: input({ transcript, speechAudio, mediaInfo, background: audio }, ['transcript', 'speechAudio', 'mediaInfo']), outputs: [artifact('finalAudio', 'audio/wav/v1'), json('dubbedTimeline', 'dubbed-timeline/v1'), json('adjustedSpeech', 'speech-audio/v1')] },
  align: { id: 'text.align/v1', inputSchema: input({ transcript, translation, dubbedTimeline, adjustedSpeech: speechAudio }), outputs: [json('wordAlignment', 'word-alignment/v1')] },
  export: { id: 'media.export/v1', inputSchema: input({ video, mediaInfo, transcript, translation, finalAudio: audio, dubbedTimeline, wordAlignment: mediaSchemas['word-alignment/v1'] }, ['video', 'mediaInfo', 'transcript', 'translation']), outputs: [artifact('video', 'video/mp4/v1'), artifact('audio', 'audio/wav/v1', false), artifact('sourceSubtitles', 'application/x-subrip/v1', false), artifact('translatedSubtitles', 'application/x-subrip/v1', false)] },
  importSubtitles: { id: 'subtitles.import/v1', inputSchema: input({ sourceSubtitles: subtitles, translatedSubtitles: subtitles }), outputs: [json('transcript', 'transcript/v1'), json('translation', 'translation/v1')] },
}

for (const [key, operation] of Object.entries(operations)) {
  operation.node = nodeDescriptors[key]
  for (const output of operation.outputs) output.label = outputPortLabels[output.name]
}

const selectiveSchemas: Record<string, string> = { transcript: 'transcript/v2', translation: 'translation/v2', references: 'voice-references/v2', speechAudio: 'speech-audio/v2', adjustedSpeech: 'speech-audio/v2', dubbedTimeline: 'dubbed-timeline/v2', wordAlignment: 'word-alignment/v2' }
for (const key of ['recognize', 'translate', 'reference', 'synthesize', 'mix', 'align', 'export']) {
  const operation = structuredClone(operations[key]);
  operation.id = operation.id.replace('/v1', '/v2')
  const node = operation.node!
  node.version = '2.0.0'
  if (key === 'recognize') {
    node.label = { default: 'Identify dialogue and singing', translations: { zh: '识别对白与歌声' } }
    node.configSchema = { type: 'object', additionalProperties: false, properties: {} }
    node.defaults = {}; node.ui = { detailId: 'youdub.transcript' }
    delete node.corrections
  } else if (key === 'translate') {
    node.corrections = { outputPorts: ['translation'], schemaIds: ['translation/v2'] }
  }
  for (const port of node.inputs) if (selectiveSchemas[port.id]) {
    port.acceptedSchemaIds = [selectiveSchemas[port.id]]
    operation.inputSchema.properties[port.id] = mediaSchemas[selectiveSchemas[port.id]]
  }
  if (key === 'recognize' || key === 'mix') {
    node.inputs.push({ id: 'sourceAudio', label: '原始音频', kind: 'artifact', required: true, acceptedSchemaIds: ['audio/wav/v1'] })
    operation.inputSchema.properties.sourceAudio = audio
    operation.inputSchema.required.push('sourceAudio')
  }
  operation.outputs = operation.outputs.map(port => selectiveSchemas[port.name] ? { ...port, ...json(port.name, selectiveSchemas[port.name]) } : port)
  if (key === 'export') operation.outputs.push(json('dubbingSummary', 'dubbing-summary/v2'))
  operations[key + 'Selective'] = operation
}
