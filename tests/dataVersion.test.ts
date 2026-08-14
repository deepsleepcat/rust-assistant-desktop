/**
 * 离线知识包（M16，任务 6）测试：数据版本信息与一致性校验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getDataVersionInfo, loadCodeData, reloadCodeData } from '../src/services/codeData'

const DATA_DIR = path.resolve(__dirname, '../public/data')

/** 用本地文件 mock fetch（vitest node 无网络；数据是应用内置的，正是离线场景） */
function stubFetchFromDisk(failVersion = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const rel = String(url).replace(/^\.?\//, '')
      if (failVersion && rel === 'data/game_version.json') {
        return { ok: false, status: 404, json: async () => { throw new Error('404') } } as Response
      }
      const file = path.join(DATA_DIR, rel.replace(/^data\//, ''))
      const content = fs.readFileSync(file, 'utf8')
      return { ok: true, status: 200, json: async () => JSON.parse(content) } as unknown as Response
    }),
  )
}

beforeEach(() => {
  reloadCodeData() // 清缓存，重新加载
})

afterEach(() => {
  vi.unstubAllGlobals()
  reloadCodeData()
})

describe('getDataVersionInfo（离线数据版本）', () => {
  it('未加载时返回 loaded=false 且计数为 0（不抛错）', () => {
    const info = getDataVersionInfo()
    expect(info.loaded).toBe(false)
    expect(info.codeCount).toBe(0)
    expect(info.versionCount).toBe(0)
    expect(info.consistent).toBeUndefined() // 无数据 → 无法判定
  })

  it('真实数据加载后：loaded=true、字段版本上限 ≤ 最新版本（一致）', async () => {
    stubFetchFromDisk()
    await loadCodeData()
    const info = getDataVersionInfo()
    expect(info.loaded).toBe(true)
    expect(info.codeCount).toBeGreaterThan(1000)
    expect(info.versionCount).toBeGreaterThan(0)
    expect(info.latestVersionName).toBeTruthy()
    expect(info.maxAddVersion).toBeLessThanOrEqual(info.latestVersionNumber!)
    expect(info.consistent).toBe(true)
  })

  it('版本表缺失时 consistent=undefined（无法判定，不误报一致）', async () => {
    stubFetchFromDisk(true)
    await loadCodeData()
    const info = getDataVersionInfo()
    expect(info.loaded).toBe(true)
    expect(info.codeCount).toBeGreaterThan(1000) // 代码表正常
    expect(info.versionCount).toBe(0) // 版本表失败
    expect(info.consistent).toBeUndefined()
  })
})
