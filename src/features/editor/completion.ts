/**
 * 自动补全：移植手机版三种处理器 + 旧版模糊搜索。
 * - 行以 [ 开头未闭合 → 补全节名
 * - 无冒号行 → 补全键（当前节内优先）
 * - 有冒号行 → 按值类型补全值
 * - 中文输入也能联想（code / translate 双语匹配）
 *
 * 数据源可注入（CompletionDataSource），便于单元测试；
 * 默认使用 codeData 的真实数据。
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import {
  findCodeByCode,
  findCodesByQuery,
  findCodesBySection,
  findSectionsByQuery,
  findValueType,
  parseValueList,
} from '../../services/codeData'
import { findSectionOfLine, isUnclosedSection, keyOfLine } from './rustLanguage'

/** 补全数据源接口（可注入） */
export interface CompletionDataSource {
  findSectionsByQuery(query: string, limit?: number): Array<{ code: string; translate: string }>
  findCodesBySection(section: string, query: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string; section?: string }>
  findCodeByCode(code: string): { code: string; translate: string; description: string; type: string } | undefined
  findValueType(type: string): { external?: string; list?: string } | undefined
  findCodesByQuery(query: string, limit?: number): Array<{ code: string; translate: string; description: string; type: string }>
}

/** 默认数据源：真实 codeData */
export const realDataSource: CompletionDataSource = {
  findSectionsByQuery: (q, l) => findSectionsByQuery(q, l),
  findCodesBySection: (s, q, l) => findCodesBySection(s, q, l),
  findCodeByCode: (c) => findCodeByCode(c),
  findValueType: (t) => findValueType(t),
  findCodesByQuery: (q, l) => findCodesByQuery(q, l),
}

function toCompletion(c: { code: string; translate: string; description: string; type: string }, suffix = ''): Completion {
  return {
    label: c.translate ? `${c.code} · ${c.translate}` : c.code,
    detail: c.description || undefined,
    type: 'property',
    apply: `${c.code}${suffix}`,
  }
}
function toSectionCompletion(s: { code: string; translate: string }): Completion {
  return {
    label: s.translate ? `${s.code} · ${s.translate}` : s.code,
    type: 'keyword',
    apply: `[${s.code}]`,
  }
}

/** 值补全：key 查类型 → 类型 list → 候选 */
function valueCompletions(key: string, query: string, data: CompletionDataSource): Completion[] {
  const info = data.findCodeByCode(key)
  if (!info) return []
  const vt = data.findValueType(info.type)
  if (!vt) return []
  const items = parseValueList(vt.list)
  const q = query.trim().toLowerCase()
  return items
    .filter((v) => !q || v.toLowerCase().includes(q))
    .map((v) => ({ label: v, type: 'value', apply: v }))
}

/** 键补全：当前节内优先 */
function keyCompletions(section: string, query: string, data: CompletionDataSource): Completion[] {
  return data.findCodesBySection(section, query).map((c) => {
    const vt = data.findValueType(c.type)
    return toCompletion(c, vt?.external ?? '')
  })
}

/** 纯函数补全逻辑（供测试）：根据行上下文选择处理器 */
export function computeRustCompletions(
  line: string,
  section: string,
  word: string,
  _query: string,
  _lineIndex: number,
  _lines: string[],
  data: CompletionDataSource = realDataSource,
): Completion[] {
  // 1. 节补全：行以 [ 开头且未闭合
  if (isUnclosedSection(line)) {
    const inner = line.trimStart().slice(1)
    return data.findSectionsByQuery(inner).map(toSectionCompletion)
  }

  // 2. 值补全：行内有冒号
  const key = keyOfLine(line)
  if (key !== null) {
    const valueComps = valueCompletions(key, word, data)
    if (valueComps.length > 0) return valueComps
    return keyCompletions(section, word, data)
  }

  // 3. 键补全：无冒号行
  return keyCompletions(section, word, data).length > 0
    ? keyCompletions(section, word, data)
    : data.findCodesByQuery(word).map((c) => toCompletion(c))
}

/** CodeMirror 补全 source：根据光标上下文选择处理器 */
export function rustCompletionSource(context: CompletionContext): CompletionResult | null {
  const doc = context.state.doc
  const lineInfo = doc.lineAt(context.pos)
  const line = lineInfo.text
  const before = line.slice(0, context.pos - lineInfo.from)
  const lines = doc.toString().split('\n')
  const lineIndex = lineInfo.number - 1
  const section = findSectionOfLine(lines, lineIndex)
  const word = before.split(/[\s:;,()=]+/).pop() ?? ''

  const completions = computeRustCompletions(line, section, word, before, lineIndex, lines)

  if (completions.length === 0) return null
  const from = context.pos - word.length
  return { from, options: completions, validFor: /^[\w\u4e00-\u9fff]*$/ }
}
