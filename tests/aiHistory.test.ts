/**
 * AI 修改历史测试：快照记录 / 上限（每文件 20 份、全局条数、全局字节）/ 恢复 / 持久化。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAiHistory } from '../electron/aiHistory'

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'rust-ai-history-'))
}

describe('electron/aiHistory', () => {
  it('addSnapshot 后按新 → 旧列出元数据（不含内容）', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'))
      const id1 = await history.addSnapshot('/proj', 'units/a.txt', 'v1')
      const id2 = await history.addSnapshot('/proj', 'units/a.txt', 'v2')
      expect(id1).toBeTruthy()
      expect(id2).toBeTruthy()
      const list = await history.listHistory('/proj', 'units/a.txt')
      expect(list.map((e) => e.id)).toEqual([id2, id1])
      expect(list[0]).not.toHaveProperty('content')
      expect(list[0].size).toBe(2)
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restore 入口数据可读（getEntry 按 id 命中，未知 id / 别的项目返回 undefined）', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'))
      const id = await history.addSnapshot('/proj', 'units/a.txt', 'content-1')
      expect((await history.getEntry('/proj', 'units/a.txt', id as string))?.content).toBe('content-1')
      expect(await history.getEntry('/proj', 'units/a.txt', 'nope')).toBeUndefined()
      expect(await history.getEntry('/other', 'units/a.txt', id as string)).toBeUndefined()
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('每文件上限（默认 20 份）：超出时淘汰最旧', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'))
      for (let i = 0; i < 25; i++) await history.addSnapshot('/proj', 'units/a.txt', `v${i}`)
      const list = await history.listHistory('/proj', 'units/a.txt')
      expect(list.length).toBe(20)
      // 最旧的 v0..v4 被淘汰，最新 v24 保留
      expect(list[0].size).toBe(3) // 'v24' = 3 字符
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全局条数上限：跨文件淘汰最旧', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'), { maxEntries: 3, perFile: 5 })
      await history.addSnapshot('/proj', 'a.txt', 'a1')
      await history.addSnapshot('/proj', 'b.txt', 'b1')
      await history.addSnapshot('/proj', 'c.txt', 'c1')
      await history.addSnapshot('/proj', 'd.txt', 'd1')
      // 4 条超上限 3：最早的 a1 被淘汰，其余保留
      expect((await history.listHistory('/proj', 'a.txt')).length).toBe(0)
      expect((await history.listHistory('/proj', 'b.txt')).length).toBe(1)
      expect((await history.listHistory('/proj', 'c.txt')).length).toBe(1)
      expect((await history.listHistory('/proj', 'd.txt')).length).toBe(1)
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全局字节上限：超过后淘汰最旧直到达标', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'), { maxTotalBytes: 10, perFile: 10 })
      await history.addSnapshot('/proj', 'a.txt', 'aaaa') // 4B
      await history.addSnapshot('/proj', 'b.txt', 'bbbb') // 4B
      await history.addSnapshot('/proj', 'c.txt', 'cccc') // 4B → 12B > 10B，淘汰 a
      expect((await history.listHistory('/proj', 'a.txt')).length).toBe(0)
      expect((await history.listHistory('/proj', 'b.txt')).length).toBe(1)
      expect((await history.listHistory('/proj', 'c.txt')).length).toBe(1)
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('单条内容超限（>2MB）返回 null，不记录', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'))
      const big = 'x'.repeat(2 * 1024 * 1024 + 1)
      const id = await history.addSnapshot('/proj', 'big.txt', big)
      expect(id).toBeNull()
      expect((await history.listHistory('/proj', 'big.txt')).length).toBe(0)
      // 普通内容不受影响
      expect(await history.addSnapshot('/proj', 'small.txt', 'ok')).toBeTruthy()
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('null 内容（AI 新建文件）也记录，恢复语义为「文件当时不存在」', async () => {
    const dir = makeTempDir()
    try {
      const history = createAiHistory(path.join(dir, 'h.json'))
      const id = await history.addSnapshot('/proj', 'units/new.txt', null)
      const entry = await history.getEntry('/proj', 'units/new.txt', id as string)
      expect(entry?.content).toBeNull()
      expect(entry?.size).toBe(0)
      await history.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flush 后新实例可读回（持久化）', async () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'h.json')
    try {
      const h1 = createAiHistory(file)
      await h1.addSnapshot('/proj', 'a.txt', 'persisted')
      await h1.flush()
      const h2 = createAiHistory(file)
      const list = await h2.listHistory('/proj', 'a.txt')
      expect(list.length).toBe(1)
      expect((await h2.getEntry('/proj', 'a.txt', list[0].id))?.content).toBe('persisted')
      await h2.flush()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏/不存在的历史文件从空开始，不抛错', async () => {
    const dir = makeTempDir()
    try {
      const badFile = path.join(dir, 'bad.json')
      writeFileSync(badFile, '{ not valid json')
      const history = createAiHistory(badFile)
      expect(await history.listHistory('/proj', 'a.txt')).toEqual([])
      const id = await history.addSnapshot('/proj', 'a.txt', 'ok')
      expect(id).toBeTruthy()
      await history.flush()
      // 落盘后恢复为合法 JSON
      const raw = JSON.parse(readFileSync(badFile, 'utf8')) as { entries: Record<string, Record<string, unknown[]>> }
      expect(raw.entries['/proj']['a.txt'].length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
