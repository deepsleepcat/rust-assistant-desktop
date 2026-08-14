/**
 * 主进程 JSON 存储测试：加载/原子写/串行化/退出冲刷。
 */
import { describe, expect, it } from 'vitest'
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
