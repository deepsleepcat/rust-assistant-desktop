/**
 * 单位表单 ↔ 代码双向同步（M14，任务 4）：
 * - parseUnitForm：解析文件各节键值 → 表单状态（含原始行号，写回定位用）；
 * - applyUnitFormValue：表单单字段变更 → 更新文件内容（保留注释/顺序/行尾）。
 * 兼容中文显示层（zhToEn/enToZh 词典）与 CRLF/LF 行尾。
 */
import { UNIT_FORM_GROUPS, findUnitGroup, type UnitFieldDef } from './unitFormFields'

/** 表单单字段值 */
export interface UnitFormValue {
  key: string
  value: string
  /** 该键是否已存在于文件中 */
  present: boolean
}

/** 表单状态：组 → 字段值 */
export type UnitFormState = Record<string, UnitFormValue[]>

type ZhToEn = (s: string) => string | undefined
type EnToZh = (s: string) => string | undefined

/** 键名回译（中文显示层 x坐标 → x） */
function toEnKey(key: string, zhToEn?: ZhToEn): string {
  if (!zhToEn) return key
  const direct = zhToEn(key)
  if (direct) return direct
  if (key.includes('_')) {
    return key.split('_').map((seg) => zhToEn(seg) ?? seg).join('_')
  }
  return key
}

/** 值回译（中文显示层 是/真 → true） */
function toEnValue(value: string, zhToEn?: ZhToEn): string {
  if (!zhToEn || !value) return value
  const en = zhToEn(value.trim())
  return en && en !== value.trim() ? en : value
}

const SECTION_RE = /^\s*\[(.+?)\]\s*(?:#.*)?$/
const KV_RE = /^([^:#][^:]*?)\s*:\s*(.*)$/

export interface ParseUnitFormOptions {
  zhToEn?: ZhToEn
}

/**
 * 解析单位文件 → 表单状态（只含 UNIT_FORM_GROUPS 里定义的字段）。
 * 返回值：groups 为表单状态；sections 为文件里出现的组节（缺失的组标记为未创建，
 * 写回时按需插入）。
 */
export function parseUnitForm(content: string, options: ParseUnitFormOptions = {}): UnitFormState {
  const zhToEn = options.zhToEn
  const state: UnitFormState = {}
  const lines = content.split(/\r?\n/)
  let section = ''
  for (const line of lines) {
    const sec = SECTION_RE.exec(line)
    if (sec) {
      section = toEnKey(sec[1].trim(), zhToEn).toLowerCase()
      continue
    }
    const kv = KV_RE.exec(line)
    if (!kv || !section) continue
    const key = toEnKey(kv[1].trim(), zhToEn)
    const group = findUnitGroup(section)
    if (!group) continue
    const field = group.fields.find((f) => f.key.toLowerCase() === key.toLowerCase())
    if (!field) continue
    const list = state[group.section] ?? []
    // 同键重复（多炮塔节 [turret_1]/[turret_2]）：只取第一个（表单管理主炮塔）
    if (!list.some((v) => v.key.toLowerCase() === field.key.toLowerCase())) {
      list.push({ key: field.key, value: toEnValue(kv[2].trim(), zhToEn), present: true })
    }
    state[group.section] = list
  }
  return state
}

/** 缺失的字段补默认值（表单展示用；写回时不落盘——只有用户改动才写入） */
export function fillDefaults(state: UnitFormState): UnitFormState {
  const out: UnitFormState = {}
  for (const group of findGroups()) {
    const existing = state[group.section] ?? []
    const list: UnitFormValue[] = []
    for (const f of group.fields) {
      const hit = existing.find((v) => v.key.toLowerCase() === f.key.toLowerCase())
      list.push(hit ?? { key: f.key, value: f.defaultValue ?? '', present: false })
    }
    out[group.section] = list
  }
  return out
}

/** 全部组定义（表单按此顺序渲染） */
export function findGroups(): Array<{ section: string; label: string; fields: UnitFieldDef[] }> {
  return UNIT_FORM_GROUPS
}

export interface ApplyUnitFormOptions {
  zhToEn?: ZhToEn
  enToZh?: EnToZh
}

/**
 * 表单字段变更 → 新文件内容：
 * - 键已存在：整行替换（保留缩进/行内注释/行尾 CRLF/LF）；
 * - 键不存在且组节存在：追加到节尾；
 * - 键不存在且组节不存在：创建 [节] 并追加（追加到文件尾）。
 * 中文显示层：追加新键时用 enToZh 反查中文键名（与文件语言一致）。
 */
export function applyUnitFormValue(content: string, groupSection: string, key: string, value: string, options: ApplyUnitFormOptions = {}): string {
  const zhToEn = options.zhToEn
  const enToZh = options.enToZh
  const crlf = content.includes('\r\n')
  const lines = content.split(/\r?\n/)
  const targetSection = groupSection.toLowerCase()
  // 炮塔组：目标节按前缀匹配（[turret_1]/[turret_2]/[turret_body] 等）
  const isTurretGroup = targetSection === 'turret'
  const matchSection = (name: string) => (isTurretGroup ? name.startsWith('turret') : name === targetSection)

  // 找目标节与键的位置
  let sectionLine = -1
  let sectionEnd = lines.length
  let keyLine = -1
  for (let i = 0; i < lines.length; i++) {
    const sec = SECTION_RE.exec(lines[i])
    if (sec) {
      const name = toEnKey(sec[1].trim(), zhToEn).toLowerCase()
      if (sectionLine >= 0) {
        // 已找到目标节：遇到下一个节即结束
        sectionEnd = i
        break
      }
      if (matchSection(name)) sectionLine = i
    } else if (sectionLine >= 0 && keyLine < 0) {
      const kv = KV_RE.exec(lines[i])
      if (kv && toEnKey(kv[1].trim(), zhToEn).toLowerCase() === key.toLowerCase()) {
        keyLine = i
      }
    }
  }

  const newLine = `${key}: ${value}`
  const isEmpty = value.trim() === ''

  if (keyLine >= 0) {
    if (isEmpty) {
      // 清空非必填字段 → 删除该行（游戏对空值行行为未知，不留空值）
      lines.splice(keyLine, 1)
    } else {
      // 替换整行，保留缩进与行内注释
      const indent = /^(\s*)/.exec(lines[keyLine])?.[1] ?? ''
      const comment = /[ \t]+(#.*)$/.exec(lines[keyLine])?.[1]
      lines[keyLine] = `${indent}${newLine}${comment ? ` ${comment}` : ''}`
    }
  } else if (isEmpty) {
    // 键不存在且清空：无操作（不创建空值行）
    return content
  } else if (sectionLine >= 0) {
    // 节存在：插入到节内最后一个非空行之后（保留节间空行分隔）
    let insertAt = sectionEnd
    while (insertAt > sectionLine + 1 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, newLine)
  } else {
    // 节不存在：追加新节到文件尾（前面补空行分隔）
    const displayKey = enToZh ? enToZh(key) ?? key : key
    const displayValue = enToZh && /^(true|false)$/i.test(value) ? (enToZh(value) ?? value) : value
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
    lines.push(`[${groupSection}]`)
    lines.push(`${displayKey}: ${displayValue}`)
  }
  return crlf ? lines.join('\r\n') : lines.join('\n')
}

/** 表单值合法性校验（纯函数）：返回错误信息（null = 合法） */
export function validateFormValue(field: UnitFieldDef, value: string): string | null {
  const v = value.trim()
  if (field.required && !v) return '必填字段不能为空'
  if (!v) return null
  switch (field.type) {
    case 'number': {
      const n = Number(v)
      if (!Number.isFinite(n)) return '必须是数字'
      if (field.min !== undefined && n < field.min) return `不能小于 ${field.min}`
      if (field.max !== undefined && n > field.max) return `不能大于 ${field.max}`
      return null
    }
    case 'boolean':
    case 'enum': {
      if (field.options && !(v in field.options) && !Object.keys(field.options).some((k) => k.toLowerCase() === v.toLowerCase())) {
        return `必须是：${Object.keys(field.options).join(' / ')}`
      }
      return null
    }
    case 'resource': {
      if (field.resourceExts && v !== 'NONE' && v !== 'AUTO' && !v.startsWith('SHARED:')) {
        const ext = v.includes('.') ? v.slice(v.lastIndexOf('.') + 1).toLowerCase() : ''
        if (!field.resourceExts.includes(ext)) return `文件扩展名必须是 ${field.resourceExts.join(' / ')}`
      }
      return null
    }
    default:
      return null
  }
}
