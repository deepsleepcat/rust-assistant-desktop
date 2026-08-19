/**
 * dialect 逻辑语法词库测试（M26-2，第二线：知识资产快赢）。
 * - dialect.json 数据完整性：88 个缺失 token、word 唯一、命名合法、说明非空、
 *   zh 互不重复且为纯汉字（翻译层 ZH_RUN_RE 只匹配纯汉字，含 ASCII 会在保存时写盘损坏）
 * - 全部 token 确实是本地数据缺失的（事实层校验：不在 code/translations/vocabulary/section/logicboolean）
 * - 知识包更新白名单包含 dialect.json（独立文件，防整文件覆盖）
 * - codeData 并入：词库搜索命中、带 zh 的进翻译词典（可译可回译）、
 *   通用单字母/数学函数/高碰撞普通词 token 不进词典（防污染显示层）、
 *   双侧守卫不覆盖既有翻译
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_FILE_NAMES } from '../electron/knowledgePack'
import { getEnToZhDict, getKeyZhToEnDict, getZhToEnDict, loadCodeData, reloadCodeData, searchVocabulary } from '../src/services/codeData'
import { enToZh, makeDict, zhToEn } from '../src/services/translation'

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

const dialectData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dialect.json'), 'utf8')) as {
  words: Array<{ word: string; zh?: string; explanation: string }>
}

beforeEach(() => {
  reloadCodeData()
  stubFetchFromDisk()
})

afterEach(() => {
  vi.unstubAllGlobals()
  reloadCodeData()
})

describe('dialect.json 数据完整性', () => {
  it('88 个缺失 token：word 唯一、命名合法、说明非空、zh 互不重复', () => {
    const words = dialectData.words
    expect(words.length).toBe(88)
    const seen = new Set<string>()
    const seenZh = new Set<string>()
    for (const w of words) {
      expect(w.word).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
      expect(w.explanation.length).toBeGreaterThan(0)
      expect(seen.has(w.word)).toBe(false)
      seen.add(w.word)
      // zh 互不重复：同文档混显（flying/isFlying 同译名）会让 tracker 放弃翻译显示英文
      if (w.zh) {
        expect(seenZh.has(w.zh)).toBe(false)
        seenZh.add(w.zh)
        // 纯汉字：翻译层 ZH_RUN_RE 只匹配纯汉字串，含 ASCII（如 队伍ID）保存时会写盘损坏
        expect(w.zh).toMatch(/^[\u4e00-\u9fff0-9_]+$/)
      }
    }
    expect(seenZh.size).toBeGreaterThan(50)
  })

  it('全部 token 确实是本地数据缺失的（不在 code/translations/vocabulary/section/logicboolean 中）', () => {
    const known = new Set<string>()
    for (const f of ['code.json', 'translations.json', 'vocabulary.json', 'section.json']) {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))
      const arr = d.data ?? d.words ?? []
      for (const it of arr) {
        const key = it.code ?? it.en ?? it.word ?? it.name ?? ''
        if (key) known.add(String(key).toLowerCase())
      }
    }
    const logic = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logicboolean.json'), 'utf8'))
    for (const it of logic.data ?? []) known.add(String(it.name ?? '').toLowerCase().replace(/^self\./, ''))
    for (const w of dialectData.words) {
      expect(known.has(w.word.toLowerCase())).toBe(false)
    }
  })

  it('知识包更新白名单包含 dialect.json（独立文件不会被整文件覆盖）', () => {
    expect(DATA_FILE_NAMES).toContain('dialect.json')
  })
})

describe('dialect 并入 codeData', () => {
  it('词库搜索命中 dialect token（带说明）', async () => {
    await loadCodeData()
    const hit = searchVocabulary('breadUnitMemory').find((h) => h.word === 'breadUnitMemory')
    expect(hit).toBeTruthy()
    expect(hit!.explanation).toContain('记忆')
    // 模糊搜索也可命中（index 位置评分）
    const fuzzy = searchVocabulary('unitmemory')
    expect(fuzzy.some((h) => h.word === 'breadUnitMemory')).toBe(true)
  })

  it('带 zh 的 token 进翻译词典：enToZh 可译、zhToEn 可回译（追踪表精确还原）', async () => {
    await loadCodeData()
    const dict = makeDict(getEnToZhDict(), getZhToEnDict())
    const tracker = new Map<string, string>()
    const display = enToZh('breadUnitMemory hasGlobalTeamTags', dict, tracker)
    expect(display).toBe('读取单位记忆 有全局队伍标签')
    // 回译（追踪模式）精确还原原文大小写
    const back = zhToEn(display, dict, tracker)
    expect(back).toBe('breadUnitMemory hasGlobalTeamTags')
  })

  it('通用单字母/数学函数/高碰撞普通词 token 不进翻译词典（防污染显示层）', async () => {
    await loadCodeData()
    const dict = getEnToZhDict()
    expect(dict.get('z')).toBeUndefined()
    expect(dict.get('cos')).toBeUndefined()
    expect(dict.get('sin')).toBeUndefined()
    expect(dict.get('rnd')).toBeUndefined()
    // 高碰撞普通词（tag 值/变量名常见）也不进词典
    expect(dict.get('ground')).toBeUndefined()
    expect(dict.get('kills')).toBeUndefined()
    expect(dict.get('completed')).toBeUndefined()
    // 但它们仍可被词库搜索到（认知层面不缺失）
    expect(searchVocabulary('cos').some((h) => h.word === 'cos')).toBe(true)
    expect(searchVocabulary('ground').some((h) => h.word === 'ground')).toBe(true)
  })

  it('zhToEn 侧守卫：dialect 不覆盖既有翻译（曾覆盖 withTag/self.timeAlive）', async () => {
    await loadCodeData()
    const enDict = getEnToZhDict()
    const zhDict = getZhToEnDict()
    // 「有标签」属于 withTag（code.json 既有）——不得被 dialect 的 hasTags 改写
    expect(zhDict.get('有标签')).toBe('withTag')
    expect(enDict.get('withtag')).toBe('有标签')
    // 「存活时间」属于 self.timeAlive（code.json 覆盖 translations 的带括号写法）——不得被 timeAlive 改写
    expect(zhDict.get('存活时间')).toBe('self.timeAlive')
    expect(enDict.get('self.timealive')).toBeTruthy() // code.json 的 self.timeAlive 键仍在
    expect(enDict.get('timealive')).toBeUndefined() // dialect 的 timeAlive 被 zhToEn 守卫挡住
    // dialect 侧 hasTags 因「有标签」已被 withTag 占用而被双侧守卫挡住
    expect(enDict.get('hastags')).toBeUndefined()
    expect(zhDict.get('有标签')).not.toBe('hastags')
  })

  it('resource 与 section.json 撞词：dialect.json 不收录（缺失口径含 section.json）', () => {
    const words = dialectData.words.map((w) => w.word)
    expect(words).not.toContain('resource')
    // section.json 中 resource → 资源 的映射保持
  })

  it('dialect 条目不覆盖既有翻译（maxHp 等已有词不受影响）', async () => {
    await loadCodeData()
    const dict = getEnToZhDict()
    // maxHp 在 code.json 中已有翻译（dialect.json 不含它——缺失清单校验过）
    expect(dict.get('maxhp')).toBeTruthy()
    // 中文回译仍指向原英文键
    expect(getZhToEnDict().get(dict.get('maxhp')!)).toBe('maxHp')
  })

  it('「价格」回译得到 price：虚构节 prices 不覆盖键译名（键名回译表兜底）', async () => {
    await loadCodeData()
    // 内置数据已删除虚构节 prices（引擎无 [prices] 节），通用词典「价格」→ price
    expect(getZhToEnDict().get('价格')).toBe('price')
    expect(getZhToEnDict().get('价格')).not.toBe('prices')
    // 键名回译表（键位置优先）：即使知识包旧数据带回 prices，键位置仍得到 price
    expect(getKeyZhToEnDict().get('价格')).toBe('price')
    // 真实节译名不受影响（核心 → core）
    expect(getZhToEnDict().get('核心')).toBe('core')
  })

  it('中文键「价格」回译 price 命中代码表：checkKeyTypos 端到端不误报', async () => {
    await loadCodeData()
    const { runSemanticChecks } = await import('../src/features/editor/semanticChecks')
    const { findCodeByCode, getAllCodes } = await import('../src/services/codeData')
    const zhToEnDict = getZhToEnDict()
    const keyZhToEnDict = getKeyZhToEnDict()
    // 与 rustLintExtension 同款注入：键位置先查键名表，回落通用词典
    const issues = runSemanticChecks('[core]\n价格: 5000\n', {
      ruleIds: new Set(['checkKeyTypos']),
      ctx: {
        findCode: (k) => findCodeByCode(k),
        findType: () => undefined,
        zhToEn: (k) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
        codes: getAllCodes().map((c) => c.code),
      },
    })
    expect(issues).toEqual([])
  })

  it('词典已知译名的自定义键不做拼写建议（mod-info 中文键「作者」不误报）', async () => {
    await loadCodeData()
    const { runSemanticChecks } = await import('../src/features/editor/semanticChecks')
    const { findCodeByCode, getAllCodes } = await import('../src/services/codeData')
    const zhToEnDict = getZhToEnDict()
    const keyZhToEnDict = getKeyZhToEnDict()
    const issues = runSemanticChecks('[mod-info]\n作者: mao\n', {
      ruleIds: new Set(['checkKeyTypos']),
      ctx: {
        findCode: (k) => findCodeByCode(k),
        findType: () => undefined,
        zhToEn: (k) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
        codes: getAllCodes().map((c) => c.code),
      },
    })
    // 回译 author 不在代码表，但「作者」是词典已知译名 → 不做英文拼写建议（曾误报「是否应为 auto」）
    expect(issues).toEqual([])
  })

  it('中文节 [炮塔_1] 回译 turret_1：节名回译不被键译名污染（checkAttachmentPosition 正常报错）', async () => {
    await loadCodeData()
    const { runSemanticChecks } = await import('../src/features/editor/semanticChecks')
    const { findCodeByCode, getAllCodes } = await import('../src/services/codeData')
    const zhToEnDict = getZhToEnDict()
    const keyZhToEnDict = getKeyZhToEnDict()
    // 模拟真实注入：ctx.zhToEn 是键位置词典（键表优先）；sectionEnName 内部走节名表，
    // [炮塔_1] 必须回译成 turret_1，checkAttachmentPosition 才能检查到 x 非数字
    const issues = runSemanticChecks('[炮塔_1]\nx: abc\n', {
      ruleIds: new Set(['checkAttachmentPosition']),
      ctx: {
        findCode: (k) => findCodeByCode(k),
        findType: () => undefined,
        zhToEn: (k) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
        codes: getAllCodes().map((c) => c.code),
        unitNames: new Set(),
      },
    })
    expect(issues.some((i) => i.message.includes('不是数字'))).toBe(true)
  })
})
