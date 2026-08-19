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
type ZhToEnValue = (s: string, field?: UnitFieldDef) => string | undefined
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

/** 节名回译独立于键名回译，避免「炮塔」等同名词条互相覆盖。 */
function toEnSection(section: string, zhToEn?: ZhToEn, zhToEnSection?: ZhToEn): string {
  return toEnKey(section, zhToEnSection ?? zhToEn)
}

/** 值回译：只处理表单自身声明的 enum/boolean 选项，text/resource 等自由值原样保留。 */
function toEnValue(value: string, field: UnitFieldDef, zhToEn?: (value: string, field: UnitFieldDef) => string | undefined): string {
  if (!value || (field.type !== 'enum' && field.type !== 'boolean')) return value
  const raw = value.trim()
  const options = Object.entries(field.options ?? {})
  const option = options.find(([key, label]) => key.toLowerCase() === raw.toLowerCase() || label === raw)
  if (option) return option[0]
  const translated = zhToEn?.(raw, field)
  return translated && translated !== raw ? translated : value
}

const SECTION_RE = /^\s*\[(.+?)\]\s*(?:#.*)?$/
const KV_RE = /^([^:#][^:]*?)\s*:\s*(.*)$/

export interface ParseUnitFormOptions {
  zhToEn?: ZhToEn
  zhToEnSection?: ZhToEn
  zhToEnValue?: ZhToEnValue
}

/**
 * 解析单位文件 → 表单状态（只含 UNIT_FORM_GROUPS 里定义的字段）。
 * 返回值：groups 为表单状态；sections 为文件里出现的组节（缺失的组标记为未创建，
 * 写回时按需插入）。
 */
export function parseUnitForm(content: string, options: ParseUnitFormOptions = {}): UnitFormState {
  const zhToEn = options.zhToEn
  const zhToEnSection = options.zhToEnSection
  const zhToEnValue = options.zhToEnValue ?? zhToEn
  const state: UnitFormState = {}
  const lines = content.split(/\r?\n/)
  let section = ''
  for (const line of lines) {
    const sec = SECTION_RE.exec(line)
    if (sec) {
      section = toEnSection(sec[1].trim(), zhToEn, zhToEnSection).toLowerCase()
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
      list.push({ key: field.key, value: toEnValue(kv[2].replace(/[ \t]+#.*$/, '').trim(), field, zhToEnValue), present: true })
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
  zhToEnSection?: ZhToEn
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
  const zhToEnSection = options.zhToEnSection
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
      const name = toEnSection(sec[1].trim(), zhToEn, zhToEnSection).toLowerCase()
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

  const isEmpty = value.trim() === ''

  if (keyLine >= 0) {
    if (isEmpty) {
      // 清空非必填字段 → 删除该行（游戏对空值行行为未知，不留空值）
      lines.splice(keyLine, 1)
    } else {
      // 替换整行，保留缩进与行内注释；键名用文件原始写法（中文显示层保持中文键）
      const indent = /^(\s*)/.exec(lines[keyLine])?.[1] ?? ''
      const comment = /[ \t]+(#.*)$/.exec(lines[keyLine])?.[1]
      const rawKey = KV_RE.exec(lines[keyLine])?.[1].trim() ?? key
      lines[keyLine] = `${indent}${rawKey}: ${value}${comment ? ` ${comment}` : ''}`
    }
  } else if (isEmpty) {
    // 键不存在且清空：无操作（不创建空值行）
    return content
  } else if (sectionLine >= 0) {
    // 节存在：插入到节内最后一个非空行之后（保留节间空行分隔）；中文模式用中文键
    let insertAt = sectionEnd
    while (insertAt > sectionLine + 1 && lines[insertAt - 1].trim() === '') insertAt--
    const displayKey = enToZh ? enToZh(key) ?? key : key
    lines.splice(insertAt, 0, `${displayKey}: ${value}`)
  } else {
    // 节不存在：追加新节到文件尾（前面补空行分隔）；中文模式用中文键
    const displayKey = enToZh ? enToZh(key) ?? key : key
    // M38：新建节时布尔值保持英文原值，不翻译为真/假——
    // 新建的中文键/值未登记 tracker，保存后真/假无法还原，游戏不识别。
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
    // 炮塔组新建节用官方编号节名 [turret_1]（裸 [turret] 游戏不识别）
    const newSection = isTurretGroup ? 'turret_1' : groupSection
    lines.push(`[${newSection}]`)
    lines.push(`${displayKey}: ${value}`)
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
      const full = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
      if (!full.test(v)) {
        // M32：数字输入中间态放行（-、1.、.5、1e 等）——Number() 对它们返回 NaN
        // 导致报错回退，负数字段（shadowOffsetX 等）无法键盘输入负号；
        // 只有最终完整数字才检查范围
        if (/^-?\d*\.?\d*(?:e[+-]?\d*)?$/i.test(v)) return null
        return '必须是数字'
      }
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
    case 'text': {
      if (field.pattern && !field.pattern.test(v)) return field.patternMessage ?? '格式不正确'
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
