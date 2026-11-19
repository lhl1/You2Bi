export const videoEncoders = [
  { value: 'auto', label: { default: 'Auto (prefer GPU)', translations: { zh: '自动（优先 GPU）', ja: '自動（GPU 優先）' } } },
  { value: 'nvenc', label: 'NVIDIA NVENC' },
  { value: 'qsv', label: 'Intel Quick Sync' },
  { value: 'amf', label: 'AMD AMF' },
  { value: 'videotoolbox', label: 'Apple VideoToolbox' },
  { value: 'cpu', label: 'CPU · libx264' },
] as const
