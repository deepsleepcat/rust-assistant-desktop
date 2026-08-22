/**
 * 离线知识包（M16，任务 6）测试：数据版本信息与一致性校验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { enToZh, makeDict, zhToEn } from '../src/services/translation'
import {
  findCodeByCode,
  findCodesByQuery,
  findCodesBySection,
  findSectionsByQuery,
  findValueTypes,
  getAliasDict,
  getDataVersionInfo,
  getKeyZhToEnDict,
  getLogicIdentifierZhToEnDict,
  getValueZhToEnDict,
  isPreserveValueKey,
  loadCodeData,
  normalizeValueForEngine,
  normalizeSectionName,
  resolveValueZhToEn,
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

describe('loadCodeData 代次竞态', () => {
  it('旧请求晚完成时不能覆盖 reload 后的新词典', async () => {
    let codeRequests = 0
    let releaseOldCode!: () => void
    const oldCode = new Promise<void>((resolve) => { releaseOldCode = resolve })
    const realCode = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code.json'), 'utf8')) as { data: Array<Record<string, unknown>> }
    const newCode = {
      data: [...realCode.data, {
        code: 'generationMarker', translate: '新代次标记', description: '测试', type: 'string', section: 'core', demo: '', addVersion: 0, removeVersion: -1,
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const rel = String(url).replace(/^\.?\//, '')
      if (rel === 'data/code.json' && codeRequests++ === 0) {
        await oldCode
        return { ok: true, status: 200, json: async () => realCode } as unknown as Response
      }
      const file = path.resolve(DATA_DIR, rel.replace(/^data\//, ''))
      const content = rel === 'data/code.json' ? newCode : JSON.parse(fs.readFileSync(file, 'utf8'))
      return { ok: true, status: 200, json: async () => content } as unknown as Response
    }))
    const oldLoad = loadCodeData()
    reloadCodeData()
    await loadCodeData()
    expect((await import('../src/services/codeData')).getAllCodes().some((c) => c.code === 'generationMarker')).toBe(true)
    releaseOldCode()
    await oldLoad
    expect((await import('../src/services/codeData')).getAllCodes().some((c) => c.code === 'generationMarker')).toBe(true)
  })
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

  it('真实单位路径点字段完整显示中文且回译无损', async () => {
    await loadCodeData()
    const dict = makeDict(
      (await import('../src/services/codeData')).getEnToZhDict(),
      (await import('../src/services/codeData')).getZhToEnDict(),
      (await import('../src/services/codeData')).getKeyZhToEnDict(),
      (await import('../src/services/codeData')).getSectionZhToEnDict(),
    )
    const original = [
      '[hiddenAction_治疗友军]',
      'autoTrigger:true',
      'addWaypoint_type:repair',
      'addWaypoint_target_nearestUnit_tagged:伤员',
      'addWaypoint_target_nearestUnit_team:own',
      'addWaypoint_target_nearestUnit_maxRange:200',
      'allowMultipleInQueue:false',
    ].join('\n')
    const tracker = new Map<string, string>()
    const view = enToZh(original, dict, tracker)
    expect(view).toContain('[隐藏行动_治疗友军]')
    expect(view).toContain('自动触发:真')
    expect(view).toContain('添加路径点动作类型:repair')
    expect(view).toContain('添加路径点检索标签:伤员')
    expect(view).toContain('添加路径点靠近队伍:己方')
    expect(view).toContain('添加路径点检索范围:200')
    expect(view).toContain('允许多个队列:假')
    expect(zhToEn(view, dict, tracker)).toBe(original)
  })

  it('M38：真实标签字段保留规范驼峰，self 标识符和中文枚举别名可安全回译', async () => {
    await loadCodeData()
    expect(getKeyZhToEnDict().get('临时标签添加')).toBe('temporarilyAddTags')
    expect(getKeyZhToEnDict().get('临时标签删除')).toBe('temporarilyRemoveTags')
    expect(getKeyZhToEnDict().get('添加全局标签')).toBe('addGlobalTeamTags')
    expect(getKeyZhToEnDict().get('移除全局标签')).toBe('removeGlobalTeamTags')
    expect(getLogicIdentifierZhToEnDict().get('血量')).toBe('hp')
    expect(getLogicIdentifierZhToEnDict().get('生命值')).toBe('maxHp')
    expect(getValueZhToEnDict().get('己方')).toBe('own')
    expect(getValueZhToEnDict().get('任何')).toBe('any')
    expect(resolveValueZhToEn('任何', 'own,neutral,allyNotOwn,ally,enemy,any,notOwn')).toBe('any')
    expect(resolveValueZhToEn('任意', 'X')).toBe('X')
    expect(normalizeValueForEngine('isBuilder', '是')).toBe('true')
    expect(normalizeValueForEngine('addWaypoint_target_nearestUnit_team', '任何')).toBe('any')
    expect(normalizeValueForEngine('movementType', '空中')).toBe('AIR')
    expect(normalizeValueForEngine('movementType', '空中，陆地')).toBe('AIR,LAND')
    expect(isPreserveValueKey('builtFrom_1_name')).toBe(true)
    expect(isPreserveValueKey('displayText_zh')).toBe(true)

    const dict = makeDict(
      (await import('../src/services/codeData')).getEnToZhDict(),
      (await import('../src/services/codeData')).getZhToEnDict(),
      getKeyZhToEnDict(),
      (await import('../src/services/codeData')).getSectionZhToEnDict(),
      getLogicIdentifierZhToEnDict(),
      (await import('../src/services/codeData')).getLogicIdentifierEnToZhDict(),
      (await import('../src/services/codeData')).getPreserveValueKeys(),
      (await import('../src/services/codeData')).getLogicValueKeys(),
    )
    const tracker = new Map<string, string>()
    const source = '[action]\ntemporarilyAddTags:攻击\nautoTrigger:if self.maxHp(lessThan=120)'
    const view = enToZh(source, dict, tracker)
    expect(view).toContain('临时标签添加:攻击')
    expect(view).toContain('self.生命值')
    expect(zhToEn(view, dict, tracker)).toBe(source)
  })

  it('self.xxx 大小写不敏感翻译：self.HP / self.hp 都能显示中文', async () => {
    await loadCodeData()
    const dict = makeDict(
      (await import('../src/services/codeData')).getEnToZhDict(),
      (await import('../src/services/codeData')).getZhToEnDict(),
      getKeyZhToEnDict(),
      (await import('../src/services/codeData')).getSectionZhToEnDict(),
      getLogicIdentifierZhToEnDict(),
      (await import('../src/services/codeData')).getLogicIdentifierEnToZhDict(),
      (await import('../src/services/codeData')).getPreserveValueKeys(),
      (await import('../src/services/codeData')).getLogicValueKeys(),
    )
    const tracker = new Map<string, string>()
    // self.hp（小写）应翻译为 self.血量
    const src1 = '[core]\nisVisible:if self.hp(greaterThan=0)'
    const view1 = enToZh(src1, dict, tracker)
    expect(view1).toContain('self.血量')
    expect(zhToEn(view1, dict, tracker)).toBe(src1)

    // self.HP（大写）也应翻译为 self.血量
    const tracker2 = new Map<string, string>()
    const src2 = '[core]\nisVisible:if self.HP(greaterThan=0)'
    const view2 = enToZh(src2, dict, tracker2)
    expect(view2).toContain('self.血量')
    expect(zhToEn(view2, dict, tracker2)).toBe(src2)
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

  it('混合大小写节 canBuild 仍能命中「排序」字段', async () => {
    await loadCodeData()
    const list = findCodesBySection('canBuild_1', '排序')
    expect(list.some((c) => c.code === 'pos' && c.type === 'float')).toBe(true)
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

describe('M35 字段别名（aliases.json：旧名也能搜到/悬停）', () => {
  beforeEach(() => {
    stubFetchFromDisk()
  })

  it('按旧名 turretlimitingAngle 模糊搜索命中现行字段 limitingAngle', async () => {
    await loadCodeData()
    const hits = findCodesByQuery('turretlimitingAngle')
    expect(hits.some((c) => c.code === 'limitingAngle')).toBe(true)
  })

  it('别名搜索大小写不敏感（TurretLimitingAngle 同样命中）', async () => {
    await loadCodeData()
    const hits = findCodesByQuery('TurretLimitingAngle')
    expect(hits.some((c) => c.code === 'limitingAngle')).toBe(true)
  })

  it('findCodesBySection 内别名同样命中（炮塔节过滤不丢）', async () => {
    await loadCodeData()
    const hits = findCodesBySection('turret', 'turretlimiting')
    expect(hits.some((c) => c.code === 'limitingAngle')).toBe(true)
  })

  it('findCodeByCode 精确查不到时解析旧名别名（悬停/lint 用）', async () => {
    await loadCodeData()
    expect(findCodeByCode('turretlimitingAngle')?.code).toBe('limitingAngle')
    expect(findCodeByCode('limitingAngle')?.code).toBe('limitingAngle')
  })

  it('别名表可查询：getAliasDict 键为小写别名，值为现行 code', async () => {
    await loadCodeData()
    const dict = getAliasDict()
    expect(dict.get('turretlimitingangle')).toBe('limitingAngle')
  })

  it('无别名时行为不变（不存在的旧名仍搜不到）', async () => {
    await loadCodeData()
    const hits = findCodesByQuery('noSuchAlias_xyz')
    expect(hits).toEqual([])
    expect(findCodeByCode('noSuchAlias_xyz')).toBeUndefined()
  })
})
