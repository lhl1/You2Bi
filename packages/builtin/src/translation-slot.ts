/** One local translation job at a time, with FIFO admission and cancellable waits. */
export class TranslationSlot {
  private occupied = false
  private readonly waiting = new Set<() => void>()

  async run<T>(signal: AbortSignal, translate: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.occupied) {
      await new Promise<void>((resolve, reject) => {
        const admit = () => {
          signal.removeEventListener('abort', cancel)
          resolve()
        }
        const cancel = () => {
          this.waiting.delete(admit)
          reject(signal.reason)
        }
        this.waiting.add(admit)
        signal.addEventListener('abort', cancel, { once: true })
      })
    } else {
      this.occupied = true
    }
    try {
      signal.throwIfAborted()
      return await translate()
    } finally {
      const next = this.waiting.values().next().value
      if (next) {
        this.waiting.delete(next)
        next()
      } else {
        this.occupied = false
      }
    }
  }
}
