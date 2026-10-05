import type { EngineDlcRenderResult } from './engineDlc'

const cancelled = (): EngineDlcRenderResult => ({ ok: false, reason: '引擎渲染已取消' })
interface Job {
  owner: number
  id: string
  controller: AbortController
  work: (signal: AbortSignal) => Promise<EngineDlcRenderResult>
  resolve: (value: EngineDlcRenderResult) => void
}

/** Latest request per window; bounded global slots, including validation and tree shutdown. */
export class EngineDlcHost {
  private readonly active = new Set<Job>()
  private readonly pending = new Map<number, Job>()
  constructor(private readonly concurrency = 2, private readonly maxPending = 16) {}

  run(owner: number, id: string, work: Job['work']): Promise<EngineDlcRenderResult> {
    this.cancel(owner)
    if (this.pending.size >= this.maxPending) return Promise.resolve({ ok: false, reason: '引擎渲染队列已满' })
    return new Promise((resolve) => {
      this.pending.set(owner, { owner, id, work, resolve, controller: new AbortController() })
      this.pump()
    })
  }

  cancel(owner: number, id?: string): void {
    for (const job of this.active) {
      if (job.owner === owner && (!id || job.id === id)) job.controller.abort()
    }
    const queued = this.pending.get(owner)
    if (queued && (!id || queued.id === id)) {
      this.pending.delete(owner)
      queued.controller.abort()
      queued.resolve(cancelled())
    }
  }

  cancelAll(): void {
    for (const job of this.active) job.controller.abort()
    for (const job of this.pending.values()) { job.controller.abort(); job.resolve(cancelled()) }
    this.pending.clear()
  }

  private pump(): void {
    for (const [owner, job] of this.pending) {
      if (this.active.size >= this.concurrency) break
      if ([...this.active].some((running) => running.owner === owner)) continue
      this.pending.delete(owner)
      this.active.add(job)
      void this.execute(job)
    }
  }

  private async execute(job: Job): Promise<void> {
    try {
      const result = await job.work(job.controller.signal)
      job.resolve(job.controller.signal.aborted ? cancelled() : result)
    } catch (error) {
      job.resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      this.active.delete(job)
      this.pump()
    }
  }
}
