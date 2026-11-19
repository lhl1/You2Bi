import type { WorkflowDocument } from '@youdub/sdk'

const affected = new Set(['youdub.transcribe', 'youdub.translate', 'youdub.reference', 'youdub.synthesize', 'youdub.mix', 'youdub.align', 'youdub.export'])

export function restoreClassicDubbing(document: WorkflowDocument): WorkflowDocument {
  const upgraded = new Set(document.nodes.filter(node => affected.has(node.type) && node.typeVersion === '2.0.0').map(node => node.id))
  if (!upgraded.size) return document
  const graph = structuredClone(document)
  for (const node of graph.nodes) {
    if (!upgraded.has(node.id)) continue
    node.typeVersion = '1.0.0'
  }
  graph.edges = graph.edges.filter(edge => !(upgraded.has(edge.target.nodeId) && edge.target.portId === 'sourceAudio'))
  return graph
}
