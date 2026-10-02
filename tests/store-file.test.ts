/**
 * 主进程 JSON 存储测试：加载/原子写/串行化/退出冲刷。
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../electron/store'

function makeTempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'rust-store-')), 'state.json')
}

describe('electron/store JSON 存储', () => {
  it('set 后持久化可读回（等待防抖 + flush）', async () => {
    const file = makeTempFile()
    try {
      const store = createStore(file)
      await store.ready()
      await store.set('settings', { a: 1 })
      await store.flush()
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(raw.settings).toEqual({ a: 1 })
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('不可序列化的值不会毒化写链（后续写入仍成功）', async () => {
    const file = makeTempFile()
    try {
      const store = createStore(file)
      await store.ready()
      // 循环引用对象：JSON.stringify 抛错
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      await store.set('bad', cyclic)
      await store.flush()
      // 写链未被毒化：正常值仍能落盘
      await store.set('good', { ok: true })
      await store.flush()
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(raw.good).toEqual({ ok: true })
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it.each(['k', 'other'])('durable 写盘期间普通 set(%s) 不丢更新', async (key) => {
    const file = makeTempFile()
    const store = createStore(file)
    await store.ready()
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const originalWrite = fs.writeFile.bind(fs)
    const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      entered()
      await paused
      return originalWrite(...args)
    })
    try {
      const durable = store.setDurable('k', 'older')
      await started
      await store.set(key, 'newer')
      release()
      await durable
      await store.flush()
      const expected = key === 'k' ? { k: 'newer' } : { k: 'older', other: 'newer' }
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected)
      for (const [name, value] of Object.entries(expected)) expect(store.get(name)).toBe(value)
      // A later durable call can supersede the ordinary set normally.
      await store.setDurable('k', 'latest')
      expect(store.get('k')).toBe('latest')
      expect(JSON.parse(readFileSync(file, 'utf8')).k).toBe('latest')
    } finally {
      release()
      write.mockRestore()
      await store.flush()
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('durable 交错失败保留普通 set，后续 durable 和 flush 队列继续成功', async () => {
    const file = makeTempFile()
    const store = createStore(file)
    await store.ready()
    await store.setDurable('k', 'initial')
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async () => {
      entered()
      await paused
      throw new Error('controlled write failure')
    })
    try {
      const durable = store.setDurable('k', 'older')
      const rejected = expect(durable).rejects.toThrow('controlled write failure')
      await started
      await store.set('k', 'newer')
      await store.set('other', 'kept')
      const next = store.setDurable('after', 'success')
      release()
      await rejected
      await next
      await store.flush()
      expect(store.get('k')).toBe('newer')
      expect(store.get('other')).toBe('kept')
      expect(store.get('after')).toBe('success')
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ k: 'newer', other: 'kept', after: 'success' })
    } finally {
      release()
      write.mockRestore()
      await store.flush()
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('并发 set 串行落盘：最后一次写入胜出且文件完整', async () => {
    const file = makeTempFile()
    try {
      const store = createStore(file)
      await store.ready()
      await Promise.all([
        store.set('k', 'v1'),
        store.set('k', 'v2'),
        store.set('k', 'v3'),
      ])
      await store.flush()
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(raw.k).toBe('v3')
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})
