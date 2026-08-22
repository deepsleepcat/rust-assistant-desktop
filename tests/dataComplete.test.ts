/**
 * M34 数据完整性测试：防止知识包/数据更新重新引入汉化缺口。
 * - code.json：所有字段必须有中文译名（译名不得等于原键）和说明
 * - section.json：所有节必须有中文译名
 * - units.json：官方单位都有中文名
 * - value_zh.json：枚举词典值都有中文解释
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dataDir = resolve(__dirname, '..', 'public', 'data')
function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, name), 'utf8')) as T
}

interface CodeEntry {
  code: string
  translate: string
  description: string
  addVersion?: number
  removeVersion?: number
}

describe('code.json 汉化完整性', () => {
  const code = load<{ data: CodeEntry[] }>('code.json').data

  it('所有字段都有中文译名且译名不等于原键', () => {
    const bad = code.filter((c) => !c.translate || !c.translate.trim() || c.translate.trim() === c.code)
    expect(bad.map((c) => c.code)).toEqual([])
  })

  it('所有字段都有中文说明（悬浮提示依赖）', () => {
    const bad = code.filter((c) => !c.description || !c.description.trim())
    expect(bad.map((c) => c.code)).toEqual([])
  })

  it('译名不含可翻译的英文残留（HUD/IO 等公认缩写除外）', () => {
    const ascii = code.filter((c) => /[A-Za-z]{3,}/.test(c.translate) && !/'[^']*'/.test(c.translate) && !/\{/.test(c.translate))
    // 允许 {NUM} 宏占位与 HUD 等缩写；只拦截「整段未翻译」的残留
    const bad = ascii.filter((c) => {
      const t = c.translate.replace(/HUD|IO|AI\b|BOM|N\/A/g, '')
      return /[A-Za-z]{3,}/.test(t) && !/[\u4e00-\u9fff]/.test(t)
    })
    expect(bad.map((c) => `${c.code}=${c.translate}`)).toEqual([])
  })
})

describe('code.json 版本元数据完整性（M35：D3 补全后防回归）', () => {
  const code = load<{ data: CodeEntry[] }>('code.json').data
  const versions = load<{ data: Array<{ versionName: string; versionNumber: number }> }>('game_version.json').data
  const latest = Math.max(...versions.map((v) => v.versionNumber))

  it('所有字段都有 addVersion（无版本号 = 0 全版本存在）且非负', () => {
    const bad = code.filter((c) => typeof c.addVersion !== 'number' || c.addVersion < 0)
    expect(bad.map((c) => c.code)).toEqual([])
  })

  it('所有字段都有 removeVersion（-1 = 未移除；>=0 = 废弃）', () => {
    const bad = code.filter((c) => typeof c.removeVersion !== 'number')
    expect(bad.map((c) => c.code)).toEqual([])
  })

  it('版本号不超出版本表（无孤儿版本）；废弃标记 ≤ 最新版本', () => {
    const badAdd = code.filter((c) => (c.addVersion ?? 0) > latest)
    const badRemove = code.filter((c) => (c.removeVersion ?? -1) > latest)
    expect([...badAdd.map((c) => c.code), ...badRemove.map((c) => c.code)]).toEqual([])
  })

  it('官方废弃字段已标记（D4：removeVersion = 最新版 = 终版已废弃）', () => {
    const outdated = code.filter((c) => (c.removeVersion ?? -1) >= 0)
    expect(outdated.length).toBeGreaterThanOrEqual(19)
    expect(outdated.some((c) => c.code === 'turretSize')).toBe(true)
    expect(outdated.every((c) => c.removeVersion === latest)).toBe(true)
  })
})

describe('section.json 汉化完整性', () => {
  const sections = load<{ data: Array<{ code: string; translate: string }> }>('section.json').data

  it('所有节都有中文译名', () => {
    const bad = sections.filter((s) => !s.translate || !s.translate.trim())
    expect(bad.map((s) => s.code)).toEqual([])
  })
})

describe('units.json 官方单位中文名完整性', () => {
  const units = load<{ data: Array<{ name: string; zhName?: string; zhDesc?: string }> }>('units.json').data

  it('所有官方单位都有中文名', () => {
    const bad = units.filter((u) => !u.zhName || !u.zhName.trim())
    expect(bad.map((u) => u.name)).toEqual([])
  })

  it('所有官方单位都有中文描述（M35：37 条补齐，AI 参考与单位库展示依赖）', () => {
    const bad = units.filter((u) => !u.zhDesc || !u.zhDesc.trim())
    expect(bad.map((u) => u.name)).toEqual([])
  })

  it('中文描述使用游戏内 [[短句]] tooltip 风格（除官方原文外）', () => {
    // modularSpider_emptySlot 的官方原文是整句提示，其余统一用 [[...]] 分段
    const bad = units.filter((u) => u.zhDesc && !u.zhDesc.includes('[[') && u.name !== 'modularSpider_emptySlot')
    expect(bad.map((u) => u.name)).toEqual([])
  })
})

describe('value_zh.json 枚举词典', () => {
  const zh = load<{ data: Record<string, string> }>('value_zh.json').data

  it('所有条目是「英文值 → 中文解释」且中文非空', () => {
    const bad = Object.entries(zh).filter(([, v]) => !v || !v.trim())
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('常见引擎枚举（队伍/布尔/地形）必须覆盖', () => {
    // 与 codeData 加载逻辑一致：运行时以「小写英文值」为键
    const lower = Object.fromEntries(Object.entries(zh).map(([k, v]) => [k.toLowerCase(), v]))
    for (const v of ['own', 'enemy', 'neutral', 'any', 'true', 'false', 'LAND', 'AIR', 'BUILDING', 'hover']) {
      expect(lower, `缺枚举翻译：${v}`).toHaveProperty(v.toLowerCase())
    }
  })
})