/**
 * 版本差异可视化（M17，P2 任务 1）测试：
 * - getVersionDiff：真实数据的「新增/弃用/改版替代」计算、版本参数校验
 * - getMigrateSuggestion / buildReplaceMap：描述启发式（自指脏数据跳过）
 * - buildUpgradeReport：项目升级改动清单（fake bridge + 注入代码表）
 * - upgradeReportToText：文本导出（脱敏、相对路径）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { CodeInfo } from '../src/services/codeData'
import { reloadCodeData } from '../src/services/codeData'
import { buildReplaceMap, buildUpgradeReport, getMigrateSuggestion, getVersionDiff, upgradeReportToText } from '../src/services/versionDiff'

const DATA_DIR = path.resolve(__dirname, '../public/data')

/** 用本地文件 mock fetch（vitest node 无网络；数据是应用内置的） */
function stubFetchFromDisk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const rel = String(url).replace(/^\.?\//, '')
      // 测试夹具：resolve 后做根目录边界校验（防 ../ 越出数据目录）
      const file = path.resolve(DATA_DIR, rel.replace(/^data\//, ''))
      if (file !== DATA_DIR && !file.startsWith(DATA_DIR + path.sep)) throw new Error('测试夹具：路径越出数据目录')
      const content = fs.readFileSync(file, 'utf8')
      return { ok: true, status: 200, json: async () => JSON.parse(content) } as unknown as Response
    }),
  )
}

beforeEach(async () => {
  reloadCodeData()
  stubFetchFromDisk()
  // 显式等数据加载：reloadCodeData 现在会清空旧索引，测试不得依赖上个用例的残留数据
  await import('../src/services/codeData').then((m) => m.loadCodeData())
})

afterEach(() => {
  vi.unstubAllGlobals()
  reloadCodeData()
})

function code(partial: Partial<CodeInfo> & { code: string }): CodeInfo {
  return {
    translate: partial.code,
    description: '',
    type: 'string',
    section: 'core',
    addVersion: 1,
    removeVersion: -1,
    ...partial,
  }
}

describe('getVersionDiff（真实数据）', () => {
  it('1.15 → 1.15-p7：新增 11 个字段（addVersion 5/6），含已知字段', async () => {
    await import('../src/services/codeData').then((m) => m.loadCodeData())
    const diff = getVersionDiff('1.15', '1.15-p7')
    expect(diff.from).toEqual({ versionName: '1.15', versionNumber: 4 })
    expect(diff.to).toEqual({ versionName: '1.15-p7', versionNumber: 6 })
    expect(diff.added.length).toBe(11)
    expect(diff.added.some((c) => c.code === 'showShotDelayBar' && c.version === 5)).toBe(true)
    expect(diff.added.some((c) => c.code === 'self.isReversing()' && c.version === 6)).toBe(true)
    // 窗口外字段不混入（memory/updateUnitMemory 是 1.15 加入，不属于窗口 (4,6]）
    expect(diff.added.some((c) => c.code === 'memory')).toBe(false)
    expect(diff.added.some((c) => c.code === 'updateUnitMemory')).toBe(false)
  })

  it('1.12 → 1.15：新增 659 个字段（addVersion 2/3/4）', async () => {
    await import('../src/services/codeData').then((m) => m.loadCodeData())
    const diff = getVersionDiff('1.12', '1.15')
    expect(diff.added.length).toBe(659)
  })

  it('当前数据没有弃用字段（removeVersion 全部 -1）→ removed 为空', async () => {
    await import('../src/services/codeData').then((m) => m.loadCodeData())
    const diff = getVersionDiff('1.12', '1.15-p10')
    expect(diff.removed.length).toBe(0)
  })

  it('改版替代：outpostT1 → laserDefence（官方描述声明）', async () => {
    await import('../src/services/codeData').then((m) => m.loadCodeData())
    const diff = getVersionDiff('1.12', '1.15-p10')
    const pair = diff.replaced.find((p) => p.oldCode === 'outpostT1')
    expect(pair).toBeDefined()
    expect(pair?.newCode).toBe('laserDefence')
    expect(pair?.newTranslate).toBe('激光塔')
  })

  it('未知版本名抛错', () => {
    expect(() => getVersionDiff('1.99', '1.15-p10')).toThrow(/未知的游戏版本/)
  })

  it('起始版本必须早于目标版本（等于或倒序抛错）', () => {
    expect(() => getVersionDiff('1.15', '1.15')).toThrow(/早于/)
    expect(() => getVersionDiff('1.15-p7', '1.15')).toThrow(/早于/)
  })
})

describe('getVersionDiff（注入代码表：弃用/迁移分支）', () => {
  const fakeCodes: CodeInfo[] = [
    code({ code: 'legacyField', translate: '旧字段', description: '旧版字段，代替newField', type: 'float', section: 'core', addVersion: 1, removeVersion: 5 }),
    code({ code: 'newField', translate: '新字段', description: '新版字段', type: 'float', section: 'core', addVersion: 5, removeVersion: -1 }),
    code({ code: 'stableField', translate: '稳定字段', description: '', type: 'string', section: 'core', addVersion: 1, removeVersion: -1 }),
    code({ code: 'windowAdded', translate: '窗口内新增', description: '', type: 'string', section: 'attack', addVersion: 4, removeVersion: -1 }),
    code({ code: 'goneInWindow', translate: '窗口内移除', description: '', type: 'string', section: 'core', addVersion: 5, removeVersion: 5 }),
  ]

  it('弃用 = 窗口内移除且 from 时存在；带迁移建议', () => {
    const diff = getVersionDiff('1.14', '1.15-p7', fakeCodes)
    expect(diff.removed.map((c) => c.code).sort()).toEqual(['legacyField'])
    // goneInWindow 加入与移除都在窗口内：只算新增（闪存字段），不算弃用
    expect(diff.added.map((c) => c.code).sort()).toEqual(['goneInWindow', 'newField', 'windowAdded'])
    const legacy = diff.removed[0]
    expect(legacy.version).toBe(5)
    expect(legacy.migrateTo).toBe('newField')
    expect(legacy.migrateHint).toContain('新字段')
  })

  it('改版替代对：旧名 → 现名（描述声明）', () => {
    const diff = getVersionDiff('1.14', '1.15-p7', fakeCodes)
    const pair = diff.replaced.find((p) => p.oldCode === 'legacyField')
    expect(pair?.newCode).toBe('newField')
  })

  it('弃用字段 removeVersion 在窗口外不报（目标版本仍有效）', () => {
    const codes = [...fakeCodes, code({ code: 'laterRemoved', translate: '更晚移除', description: '', type: 'string', section: 'core', addVersion: 1, removeVersion: 8 })]
    const diff = getVersionDiff('1.14', '1.15-p7', codes)
    expect(diff.removed.map((c) => c.code)).not.toContain('laterRemoved')
  })
})

describe('buildReplaceMap / getMigrateSuggestion', () => {
  const codes: CodeInfo[] = [
    code({ code: 'oldName', translate: '旧名', description: '内置单位，代替newName', type: 'constant', section: 'all' }),
    code({ code: 'newName', translate: '现名', description: '内置单位', type: 'constant', section: 'all' }),
    code({ code: 'selfRef', translate: '自指', description: '代替selfRef', type: 'constant', section: 'all' }),
    code({ code: 'ghostTarget', translate: '幽灵', description: '代替notExists', type: 'constant', section: 'all' }),
  ]

  it('只保留「目标存在且非自指」的映射', () => {
    const map = buildReplaceMap(codes)
    expect(map.get('oldname')?.code).toBe('newName')
    expect(map.has('selfref')).toBe(false) // 自指脏数据跳过
    expect(map.has('ghosttarget')).toBe(false) // 目标不在代码表跳过
  })

  it('getMigrateSuggestion：旧名 → 现名 + 说明', () => {
    const sug = getMigrateSuggestion('oldName', codes)
    expect(sug.migrateTo).toBe('newName')
    expect(sug.migrateHint).toContain('现名')
  })

  it('getMigrateSuggestion：无映射时返回空', () => {
    const sug = getMigrateSuggestion('newName', codes)
    expect(sug.migrateTo).toBeUndefined()
  })
})

describe('buildUpgradeReport（项目升级改动清单）', () => {
  const fakeBridge = {
    mod: {
      scanResources: async () => ({ files: ['units/rifle.ini', 'units/archer.template', 'images/icon.png'], unitNames: ['rifle'] }),
    },
    project: {
      readFile: async (_root: string, file: string) => ({
        content:
          file === '/fake/root/units/rifle.ini'
            ? '[core]\r\nname: 步枪兵\r\nlegacyField: 5\r\nwindowAdded: 3\r\nstableField: 2\r\n[attack]\r\nnewField: 0.5\r\n'
            : '[core]\r\nname: 弓手\r\nnewField: 0.3\r\n',
      }),
    },
  }
  const fakeCodes: CodeInfo[] = [
    code({ code: 'legacyField', translate: '旧字段', description: '旧版字段，代替newField', type: 'float', section: 'core', addVersion: 1, removeVersion: 5 }),
    code({ code: 'newField', translate: '新字段', description: '', type: 'float', section: 'attack', addVersion: 5, removeVersion: -1 }),
    code({ code: 'stableField', translate: '稳定字段', description: '', type: 'string', section: 'core', addVersion: 1, removeVersion: -1 }),
    code({ code: 'windowAdded', translate: '窗口内新增', description: '', type: 'string', section: 'core', addVersion: 4, removeVersion: -1 }),
  ]

  it('统计弃用使用次数（全量）与新增字段引用', async () => {
    const report = await buildUpgradeReport('/fake/root', '1.14', '1.15-p7', { projectName: '测试模组', codes: fakeCodes }, fakeBridge)
    expect(report.meta.fileCount).toBe(2) // 只有 ini/template 参与扫描
    expect(report.meta.fromVersion).toBe('1.14')
    expect(report.meta.toVersion).toBe('1.15-p7')
    expect(report.mustFixCount).toBe(1) // rifle.ini 的 legacyField
    expect(report.newFieldCount).toBe(3) // rifle: windowAdded + newField；archer: newField
    const must = report.items.find((i) => i.kind === 'must_migrate')
    expect(must).toBeDefined()
    expect(must?.file).toBe('units/rifle.ini')
    expect(must?.line).toBe(3)
    expect(must?.suggestion).toContain('newField')
    const news = report.items.filter((i) => i.kind === 'new_field')
    expect(news.length).toBe(3)
    expect(news.some((i) => i.file === 'units/archer.template' && i.code === 'newField')).toBe(true)
  })

  it('无差异时清单为空', async () => {
    const report = await buildUpgradeReport('/fake/root', '1.15-p7', '1.15-p10', { projectName: '测试模组', codes: fakeCodes }, fakeBridge)
    expect(report.mustFixCount).toBe(0)
    expect(report.newFieldCount).toBe(0)
    expect(report.items.length).toBe(0)
  })

  it('进度回调按批推进', async () => {
    const seen: Array<[number, number]> = []
    await buildUpgradeReport('/fake/root', '1.14', '1.15-p7', { projectName: '测试模组', codes: fakeCodes, onProgress: (d, t) => seen.push([d, t]) }, fakeBridge)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toEqual([2, 2])
  })
})

describe('upgradeReportToText', () => {
  it('包含统计与相对路径（脱敏）', async () => {
    const full = await buildUpgradeReport('/fake/root', '1.14', '1.15-p7', { projectName: '测试模组', codes: [
      code({ code: 'legacyField', translate: '旧字段', description: '旧版字段，代替newField', type: 'float', section: 'core', addVersion: 1, removeVersion: 5 }),
      code({ code: 'newField', translate: '新字段', description: '', type: 'float', section: 'attack', addVersion: 5, removeVersion: -1 }),
    ] }, {
      mod: { scanResources: async () => ({ files: ['units/rifle.ini'], unitNames: [] }) },
      project: { readFile: async () => ({ content: '[core]\r\nname: x\r\nlegacyField: 1\r\n' }) },
    })
    const text = upgradeReportToText(full)
    expect(text).toContain('测试模组')
    expect(text).toContain('1.14 → 1.15-p7')
    expect(text).toContain('必须处理 1 处弃用字段')
    expect(text).toContain('units/rifle.ini:3')
    expect(text).toContain('[必须处理]')
    expect(text).not.toContain('/fake/root')
    // 空报告
    const empty = upgradeReportToText({ meta: { projectName: 'x', generatedAt: 1, fileCount: 0, fromVersion: 'a', toVersion: 'b' }, mustFixCount: 0, newFieldCount: 0, items: [] })
    expect(empty).toContain('未发现需要处理的版本差异')
  })
})
