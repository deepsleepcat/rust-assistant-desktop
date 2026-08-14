/**
 * 行级 diff 测试：LCS 正确性 / 上下文裁剪 / omit 折叠 / 输出上限 / 统计。
 */
import { describe, expect, it } from 'vitest'
import { diffLines, diffLinesWithStats, splitLines, summarizeDiff } from '../electron/diff'

describe('splitLines', () => {
  it('兼容 \\n 与 \\r\\n，结尾换行不产生空尾行', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('\n')).toEqual([''])
  })
})

describe('diffLines', () => {
  it('内容完全一致返回空数组', () => {
    expect(diffLines('a\nb\nc\n', 'a\nb\nc\n')).toEqual([])
  })

  it('单行修改：del + add 相邻（LCS 不整段替换）', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nX\nc\n')
    const types = diff.map((l) => l.type)
    expect(types).toEqual(['same', 'del', 'add', 'same'])
  })

  it('纯新增：全部为 add', () => {
    const diff = diffLines('', 'a\nb\n')
    expect(diff.every((l) => l.type === 'add')).toBe(true)
    expect(diff.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('纯删除：全部为 del', () => {
    const diff = diffLines('a\nb\n', '')
    expect(diff.every((l) => l.type === 'del')).toBe(true)
  })

  it('删除整行与新增整行', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nc\n')
    expect(diff.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'del:b', 'same:c'])
    const added = diffLines('a\nc\n', 'a\nb\nc\n')
    expect(added.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'add:b', 'same:c'])
  })

  it('长段未改动内容折叠为 omit 标记（上下文 ±3）', () => {
    const oldText = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const newText = oldText.replace('line25', 'line25-CHANGED')
    const diff = diffLines(oldText, newText)
    const omits = diff.filter((l) => l.type === 'omit')
    expect(omits.length).toBeGreaterThan(0)
    expect(omits[0].text).toMatch(/省略 \d+ 行/)
    // 改动行本身必须在
    expect(diff.some((l) => l.type === 'del' && l.text === 'line25')).toBe(true)
    expect(diff.some((l) => l.type === 'add' && l.text === 'line25-CHANGED')).toBe(true)
    // 距离改动超过 ±3 的未改动行被折叠
    expect(diff.some((l) => l.type === 'same' && l.text === 'line1')).toBe(false)
  })

  it('改动附近保留上下文行（±3 内），超出部分折叠', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const newText = oldText.replace('line10', 'line10-CHANGED')
    const diff = diffLines(oldText, newText)
    const same = diff.filter((l) => l.type === 'same').map((l) => l.text)
    // 距改动 3 行内保留（line7 ~ line13）
    expect(same).toContain('line7')
    expect(same).toContain('line13')
    // 超过 3 行被折叠
    expect(same).not.toContain('line3')
    expect(same).not.toContain('line16')
    expect(diff.some((l) => l.type === 'omit')).toBe(true)
  })

  it('前后公共行不参与 LCS（前缀/后缀裁剪）', () => {
    const diff = diffLines('a\nb\nc\nd\n', 'a\nb\nX\nd\n')
    expect(diff.map((l) => l.type)).toEqual(['same', 'same', 'del', 'add', 'same'])
  })

  it('中部超过 LCS 单元格上限时回退整段替换，结果仍正确', () => {
    // 2000×2000 = 400 万单元格 > 上限：前缀/后缀都无法裁剪（首行与末行都不同）
    const a = Array.from({ length: 2000 }, (_, i) => `line${i}`)
    const b = [...a].reverse()
    const diff = diffLines(a.join('\n'), b.join('\n'))
    const dels = diff.filter((l) => l.type === 'del').length
    const adds = diff.filter((l) => l.type === 'add').length
    expect(dels).toBeGreaterThan(0)
    expect(adds).toBeGreaterThan(0)
    // 输出有 400 行上限：首尾保留、中间折叠
    expect(diff.length).toBeLessThanOrEqual(400)
    expect(diff.some((l) => l.type === 'omit')).toBe(true)
  })

  it('输出行数超上限时中间折叠', () => {
    const oldText = Array.from({ length: 2000 }, (_, i) => `line${i}`).join('\n')
    const newText = oldText.replace('line100', 'CHANGED') + '\nline2000-extra'
    const diff = diffLines(oldText, newText, { maxLines: 40 })
    expect(diff.length).toBeLessThanOrEqual(40)
    expect(diff.some((l) => l.type === 'omit')).toBe(true)
  })

  it('改动行超预算：保留首尾改动 + 明确标注被隐藏的改动数，绝不静默截断', () => {
    const oldText = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n')
    const newText = Array.from({ length: 500 }, (_, i) => `line${i}-v2`).join('\n')
    const diff = diffLines(oldText, newText, { maxLines: 40 })
    expect(diff.length).toBeLessThanOrEqual(40)
    const omit = diff.find((l) => l.type === 'omit')
    expect(omit).toBeDefined()
    expect(omit!.text).toMatch(/另有 \d+ 处改动未显示（全部改动共 1000 行）/)
  })

  it('diffLinesWithStats：统计在截断前计算，数字始终反映全部改动', () => {
    const oldText = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n')
    const newText = Array.from({ length: 500 }, (_, i) => `line${i}-v2`).join('\n')
    const { lines, summary } = diffLinesWithStats(oldText, newText, { maxLines: 40 })
    expect(lines.length).toBeLessThanOrEqual(40)
    // 500 行全部替换 = 500 del + 500 add；输出折叠但统计完整
    expect(summary).toEqual({ added: 500, deleted: 500 })
  })
})

describe('summarizeDiff', () => {
  it('统计新增/删除行数（same/omit 不计）', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nX\nc\nY\n')
    expect(summarizeDiff(diff)).toEqual({ added: 2, deleted: 1 })
  })
})
