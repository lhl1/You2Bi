import { cn } from '@/lib/utils'

export function BrandMark({ wordmark = false, wordmarkSrc, className }: {
  wordmark?: boolean
  wordmarkSrc?: string
  className?: string
}) {
  return <span aria-hidden="true" className={cn('inline-flex h-10 items-center gap-2 align-middle', className)}>
    <img src={wordmarkSrc || '/you2bi-icon.png'} alt="" width={512} height={512} className="h-full w-auto object-contain" />
    {wordmark && <strong className="text-lg font-semibold tracking-tight">You2Bi</strong>}
  </span>
}
