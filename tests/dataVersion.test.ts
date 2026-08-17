/**
 * 离线知识包（M16，任务 6）测试：数据版本信息与一致性校验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  findCodesBySection,
  findSectionsByQuery,
  findValueTypes,
  getDataVersionInfo,
  loadCodeData,
  normalizeSectionName,
  reloadCodeData,
} from '../src/services/codeData'

const DATA_DIR = path.resolve(__dirname, '../public/data')

/** 用本地文件 mock fetch（vitest node 无网络；数据是应用内置的，正是离线场景） */
function stubFetchFromDisk(failVersion = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const rel = String(url).replace(/^\.?\//, '')
      if (failVersion && rel === 'data/game_version.json') {
        return { ok: false, status: 404, json: async () => { throw new Error('404') } } as unknown as Response
      }
      // 测试夹具：resolve 后做根目录边界校验（防 ../ 越出数据目录）
      const file = path.resolve(DATA_DIR, rel.replace(/^data\//, ''))
      if (file !== DATA_DIR && !file.startsWith(DATA_DIR + path.sep)) throw new Error('测试夹具：路径越出数据目录')
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

describe('M31 补全数据查询（真实数据）', () => {
  beforeEach(() => {
    stubFetchFromDisk()
  })

  it('多值类型 findValueTypes：float,logicBoolean 合并全部命中段（补全不再只取第一段）', async () => {
    await loadCodeData()
    const vts = findValueTypes('float,logicBoolean')
    expect(vts.length).toBeGreaterThanOrEqual(2)
    // float 段给数值候选，logicBoolean 段给 true/false/@type 指令
    const merged = vts.flatMap((v) => (v.list ?? '').split(','))
    expect(merged.some((s) => s.trim() === 'true')).toBe(true)
    expect(merged.some((s) => s.trim() === 'false')).toBe(true)
    expect(merged.some((s) => s.trim().startsWith('@type('))).toBe(true)
  })

  it('编号节 findCodesBySection：turret_1 归一化为基础节 turret，当前节键候选不丢', async () => {
    await loadCodeData()
    const base = findCodesBySection('turret', '')
    expect(base.length).toBeGreaterThan(0)
    const numbered = findCodesBySection('turret_1', '')
    expect(numbered.length).toBeGreaterThan(0)
    expect(numbered.map((c) => c.code)).toEqual(base.map((c) => c.code))
  })

  it('normalizeSectionName：中文编号节和命名节归一化到已知基础节', async () => {
    await loadCodeData()
    expect(normalizeSectionName('turret_1')).toBe('turret')
    expect(normalizeSectionName('炮塔_1')).toBe('turret')
    expect(normalizeSectionName('turret_main')).toBe('turret')
    expect(normalizeSectionName('炮塔_主炮')).toBe('turret')
    expect(normalizeSectionName('core')).toBe('core')
    expect(normalizeSectionName('custom_main')).toBe('custom_main')
    expect(normalizeSectionName('custom_1')).toBe('custom_1')
  })

  it('findSectionsByQuery：编号和命名节前缀仍返回基础 needName 节候选', async () => {
    await loadCodeData()
    const list = findSectionsByQuery('turret_1')
    expect(list.some((s) => s.code === 'turret')).toBe(true)
    const named = findSectionsByQuery('turret_main')
    expect(named.some((s) => s.code === 'turret')).toBe(true)
    const zh = findSectionsByQuery('炮塔_主炮')
    expect(zh.some((s) => s.code === 'turret')).toBe(true)
  })
})
