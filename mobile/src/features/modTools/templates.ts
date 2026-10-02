/**
 * 模板系统纯函数（从桌面版 electron/modTools.ts 移植）：
 * 模板 JSON 解析 → TemplateMeta、默认值提取、模板数据 → 单位文件文本。
 * 文件 IO 由桥层负责，这里全部为纯函数（可测试）。
 */
import type { TemplateAction, TemplateMeta } from '../../types/mod'

/** 原始模板 JSON（与桌面版 schema 一致） */
export interface RawTemplate {
  name?: string
  name_en?: string
  language?: string
  data?: string
  action?: Array<{
    name?: string
    key?: string
    section?: string
    tag?: string
    type?: string
  }>
}

/** 从模板 data 文本提取 [section] 节的 key 当前值 */
export function extractDefaults(data: string | undefined, actions: TemplateAction[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!data) return out
  let current = ''
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      current = sectionMatch[1]
      continue
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/)
    if (kv) {
      const key = kv[1].trim()
      const action = actions.find((a) => a.key === key && a.section === current)
      if (action && out[action.tag] === undefined) out[action.tag] = kv[2].trim()
    }
  }
  return out
}

/** 原始模板 → TemplateMeta */
export function toTemplateMeta(key: string, raw: RawTemplate): TemplateMeta {
  const actions: TemplateAction[] = (raw.action ?? []).map((a) => ({
    label: a.name ?? a.key ?? '',
    key: a.key ?? '',
    section: a.section ?? '',
    tag: a.tag ?? '',
    type: a.type ?? 'input',
  }))
  return {
    key,
    name: raw.name ?? key,
    nameEn: raw.name_en ?? '',
    actions,
    defaults: extractDefaults(raw.data, actions),
  }
}

/** 用用户输入替换模板 data 中对应 [section] 节的 key 值（未填的保留默认） */
export function buildFileFromTemplate(raw: RawTemplate, values: Record<string, string>): string {
  const data = raw.data ?? ''
  let current = ''
  return data
    .split(/\r?\n/)
    .map((line) => {
      const sectionMatch = line.match(/^\[(.+)\]$/)
      if (sectionMatch) {
        current = sectionMatch[1]
        return line
      }
      // 跳过注释/节外行；只替换模板声明的字段
      if (line.trim().startsWith('#') || !line.trim()) return line
      const kv = line.match(/^(\s*)([^#:]+?)\s*:\s*(.*)$/)
      if (!kv) return line
      const key = kv[2].trim()
      const action = (raw.action ?? []).find((a) => a.key === key && a.section === current)
      const input = action?.tag ? values[action.tag] : undefined
      if (action && input !== undefined && String(input).trim() !== '') {
        return `${kv[1]}${key}: ${String(input).trim()}`
      }
      return line
    })
    .join('\n')
}
