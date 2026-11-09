/**
 * AI 写后自动质检（移植桌面端任务 3）纯函数测试：行起始表、偏移量→行号、
 * 诊断→可操作清单、建议映射、条目上限折叠、语义检查器合并（注入数据绕过
 * 数据层 fetch）与自纠反馈格式化（WebView 无 Buffer，字节预算用 TextEncoder）。
 */
import { describe, expect, it } from 'vitest'
import { lineNumberAt, lineStarts, lintItemsToFeedback, qualityCheckContent, suggestionFor, toLintItems, type QualityCheckData } from '../src/features/ai/aiQualityCheck'
import type { ValueTypeInfo } from '../src/services/codeData'

/** 测试用 lint 数据（node 环境没有内置数据资源，注入绕过 loadCodeData） */
const DATA: QualityCheckData = {
  findCode: (k) => {
    const lower = k.toLowerCase()
    if (lower === 'maxhp' || lower === 'mass' || lower === 'radius') return { type: 'int' }
    if (lower === 'price') return { type: 'resource' }
    if (lower === 'name') return { type: 'string' }
    return undefined
  },
  findType: (t) => {
    const vt: Record<string, ValueTypeInfo> = {
      int: { name: 'int', type: 'int', describe: '整数' },
      resource: { name: 'resource', type: 'resource', describe: '资源' },
      string: { name: 'string', type: 'string', describe: '字符串' },
    }
    return vt[t]
  },
  zhToEn: (k) => (k === '生命值' ? 'maxHp' : k === '名称' ? 'name' : undefined),
}

describe('lineStarts / lineNumberAt', () => {
  it('构建每行起始偏移表，行号从 1 起', () => {
    const content = 'a\nb\nc'
    const starts = lineStarts(content)
    expect(starts).toEqual([0, 2, 4])
    expect(lineNumberAt(starts, 0)).toBe(1)
    expect(lineNumberAt(starts, 2)).toBe(2)
    expect(lineNumberAt(starts, 4)).toBe(3)
  })

  it('超过内容的偏移量不越界', () => {
    expect(lineNumberAt(lineStarts('ab'), 999)).toBe(1)
  })

  it('兼容 \\r\\n（\\r 不计行）', () => {
    const starts = lineStarts('a\r\nb')
    expect(starts).toEqual([0, 3])
    expect(lineNumberAt(starts, 3)).toBe(2)
  })
})

describe('suggestionFor', () => {
  it('值类型错误给出对照代码表的建议', () => {
    expect(suggestionFor('「name」的值「x」不符合类型 int')).toContain('代码表')
  })
  it('节外代码给出移入节内的建议', () => {
    expect(suggestionFor('此键值行不在任何 [节] 内，游戏会忽略它')).toContain('[节]')
  })
  it('其他问题给出通用建议', () => {
    expect(suggestionFor('未知问题')).toContain('格式')
  })
})

describe('toLintItems', () => {
  it('诊断 → 文件行号 + 原因 + 修复建议', () => {
    const content = '[core]\nname: x\nmaxHp: -1\n'
    const items = toLintItems(content, [
      { from: 7, to: 14, message: '「name」的值「x」不符合类型 int（期望：整数）', severity: 'error' },
      { from: 15, to: 21, message: '「maxHp」的值「-1」不符合类型 int', severity: 'error' },
    ])
    expect(items).toEqual([
      { line: 2, message: '「name」的值「x」不符合类型 int（期望：整数）', severity: 'error', suggestion: expect.stringContaining('代码表') },
      { line: 3, message: '「maxHp」的值「-1」不符合类型 int', severity: 'error', suggestion: expect.stringContaining('代码表') },
    ])
  })

  it('空诊断 → 空清单', () => {
    expect(toLintItems('a\nb', [])).toEqual([])
  })

  it('超过 200 条时折叠为汇总条目（line=0，无建议）', () => {
    const diagnostics = Array.from({ length: 205 }, (_, i) => ({
      from: 0,
      to: 1,
      message: `问题 ${i}`,
      severity: 'warning' as const,
    }))
    const items = toLintItems('a', diagnostics)
    expect(items.length).toBe(201)
    expect(items[200].line).toBe(0)
    expect(items[200].message).toContain('其余 5 条问题未列出')
    expect(items[200].suggestion).toBe('')
  })
})

describe('qualityCheckContent（语义检查器合并，注入数据）', () => {
  it('语义问题带 ruleId/evidence 并入清单', async () => {
    const items = await qualityCheckContent('[core]\nmaxHp: -5\nname: myUnit\n', { data: DATA })
    const semantic = items.find((i) => i.ruleId === 'checkPositiveCoreStats')
    expect(semantic).toBeDefined()
    expect(semantic?.line).toBe(2)
    expect(semantic?.severity).toBe('error')
    expect(semantic?.evidence).toBe('-5')
  })

  it('中文显示层键也能检出（zhToEn 回译）', async () => {
    const items = await qualityCheckContent('[core]\n生命值: -5\n', { data: DATA })
    expect(items.some((i) => i.ruleId === 'checkPositiveCoreStats')).toBe(true)
  })

  it('检查器可单独关闭（配置过滤）', async () => {
    const items = await qualityCheckContent('[core]\nmaxHp: -5\n', { data: DATA, semanticCheckers: { checkPositiveCoreStats: false } })
    expect(items.some((i) => i.ruleId === 'checkPositiveCoreStats')).toBe(false)
  })

  it('unitNames 传入时引用检查生效', async () => {
    const items = await qualityCheckContent('[core]\nbuiltFrom_1_name: ghostFactory\nname: x\n', {
      data: DATA,
      unitNames: new Set(['landFactory']),
    })
    expect(items.some((i) => i.ruleId === 'checkRiskyUnitReferenceSemantics' && i.message.includes('ghostFactory'))).toBe(true)
  })

  it('dont_load 文件跳过语义检查', async () => {
    const items = await qualityCheckContent('[core]\ndont_load: true\nmaxHp: -5\n', { data: DATA })
    expect(items.some((i) => i.ruleId === 'checkPositiveCoreStats')).toBe(false)
  })

  it('超大文件返回空（不检查）', async () => {
    const items = await qualityCheckContent('x'.repeat(5 * 1024 * 1024 + 1), { data: DATA })
    expect(items).toEqual([])
  })
})

describe('合并截断（第二轮审查回归）', () => {
  it('基础诊断超限时汇总计数准确（不二次折叠）', async () => {
    // 300 行每行一个节外键值行 → 基础诊断 300 条（节外警告）
    const lines: string[] = []
    for (let i = 0; i < 300; i++) lines.push(`key${i}: value${i}`)
    const content = lines.join('\n')
    const items = await qualityCheckContent(content, { data: DATA })
    const fold = items.find((i) => i.line === 0 && i.message.startsWith('…其余'))
    // 300 基础 - 200 上限 = 100 条折叠（非「1 条」）
    expect(fold?.message).toContain('其余 100 条问题未列出')
  })
})

describe('lintItemsToFeedback（自纠反馈格式化）', () => {
  it('生成含行号/问题/建议/写回指令的修正消息', () => {
    const msg = lintItemsToFeedback([
      { line: 3, message: '血量超出推荐范围', severity: 'warning', suggestion: '调低 maxHp' },
      { line: 8, message: '缺少 name', severity: 'error', suggestion: '' },
    ])
    expect(msg).toContain('自动质检反馈')
    expect(msg).toContain('第3行：血量超出推荐范围（建议：调低 maxHp）')
    expect(msg).toContain('第8行：缺少 name')
    expect(msg).toContain('writeFile')
    expect(msg).toContain('applyDiff')
  })

  it('超过 30 条时截断并标注剩余数量', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ line: i + 1, message: `问题${i}`, severity: 'warning' as const, suggestion: '' }))
    const msg = lintItemsToFeedback(items)
    expect(msg).toContain('其余 10 条未列出')
    expect(msg.match(/第\d+行/g)?.length).toBe(30)
  })

  it('空清单：只有头尾指令（不报错）', () => {
    const msg = lintItemsToFeedback([])
    expect(msg).toContain('自动质检反馈')
    expect(msg).toContain('writeFile')
  })

  it('超长建议按字节预算截断（TextEncoder 与 WebView 同口径）', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      line: i + 1,
      message: `问题${i}`,
      severity: 'warning' as const,
      suggestion: '建议'.repeat(2000),
    }))
    const msg = lintItemsToFeedback(items)
    expect(new TextEncoder().encode(msg).length).toBeLessThanOrEqual(8 * 1024)
  })
})
