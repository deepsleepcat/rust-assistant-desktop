/**
 * 单位表单 ↔ 代码双向同步（M14，任务 4；表单审计第一轮重构）：
 * - parseUnitForm：解析文件各节键值 → 表单状态（含行号定位；重复键记录全部出现，
 *   表单显示游戏实际生效值 = 最后一处）；支持冒号与等号两种分隔符（引擎两者都接受）；
 * - applyUnitFormValue：表单单字段变更 → 更新文件内容（保留缩进/原分隔符/行尾，
 *   更新生效行 = 最后一次出现）；值中的 # 属于值本身（引擎只把整行 # 当注释）；
 * - 三引号（"""）多行字符串块整体跳过（块内内容不是键值对）；
 * - 炮塔节按完整节名（turret_1/turret_2/…）独立成组，避免多炮塔互相串值；
 * - unitResourceRelPath：资源选择统一到项目根坐标再算相对单位目录的路径。
 * 兼容中文显示层（zhToEn/enToZh 词典）与 CRLF/LF 行尾。
 */
import { UNIT_FORM_GROUPS, findUnitGroup, type UnitFieldDef } from './unitFormFields'

/** 表单单字段值 */
export interface UnitFormValue {
  key: string
  /** 生效值（重复键 = 最后一处；不再剥离 # ——引擎视之为值的一部分） */
  value: string
  /** 该键是否已存在于文件中 */
  present: boolean
  /** 生效行号（1 基；重复键 = 最后一处） */
  line?: number
  /** 重复出现的全部行号（仅重复 ≥2 处时提供，含生效行） */
  dupLines?: number[]
}

/** 表单状态：实际节名（小写，如 core / turret_1）→ 字段值 */
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
// 分隔符支持冒号与等号（引擎 ab.java 两种都接受）；捕获分隔符以保留原写法
const KV_RE = /^([^:#=][^:=]*?)\s*([:=])\s*(.*)$/

/** 统一斜杠（Windows 反斜杠 → posix 正斜杠） */
export function normSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 该行是否处于三引号块边界（""" 出现奇数次 = 状态翻转） */
function flipsTripleQuote(line: string): boolean {
  let count = 0
  let idx = line.indexOf('"""')
  while (idx >= 0) {
    count++
    idx = line.indexOf('"""', idx + 3)
  }
  return count % 2 === 1
}

/** 纯函数：逐行解析 INI（跳过整行注释与三引号块），供 parse/apply 共用。
 * 同时产出节行与键值行；zhToEn 只作用于节名/键名（值层由调用方处理）。 */
export type IniLineEntry =
  | { type: 'section'; index: number; name: string }
  | { type: 'kv'; index: number; section: string; key: string; sep: string; rawValue: string; rawKey: string; indent: string }

function* walkLines(lines: string[], zhToEn?: ZhToEn): Generator<IniLineEntry> {
  let section = ''
  let inTriple = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inTriple) {
      if (flipsTripleQuote(line)) inTriple = false
      continue
    }
    if (flipsTripleQuote(line)) {
      // 单行自闭合（偶数次不会进这里）或块开启行
      inTriple = true
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const sec = SECTION_RE.exec(line)
    if (sec) {
      section = toEnKey(sec[1].trim(), zhToEn).toLowerCase()
      yield { type: 'section', index: i, name: section }
      continue
    }
    const kv = KV_RE.exec(line)
    if (!kv || !section) continue
    yield {
      type: 'kv',
      index: i,
      section,
      key: toEnKey(kv[1].trim(), zhToEn),
      sep: kv[2],
      rawValue: kv[3],
      rawKey: kv[1].trim(),
      indent: /^(\s*)/.exec(line)?.[1] ?? '',
    }
  }
}

export interface ParseUnitFormOptions {
  zhToEn?: ZhToEn
}
/**
 * 解析单位文件 → 表单状态（只含 UNIT_FORM_GROUPS 里定义的字段）。
 * state 键 = 文件中的实际节名（core / graphics / turret_1 / turret_2 / …）：
 * 多炮塔各节独立，杜绝「表单合并所有炮塔、编辑串值」。重复键保留全部出现，
 * value 取最后一处（游戏实际生效值），dupLines 记录全部行号。
 */
export function parseUnitForm(content: string, options: ParseUnitFormOptions = {}): UnitFormState {
  const zhToEn = options.zhToEn
  const state: UnitFormState = {}
  const lines = content.split(/\r?\n/)
  for (const entry of walkLines(lines, zhToEn)) {
    if (entry.type === 'section') {
      // 已知组节登记（空节也保留，fillDefaults 补默认值）
      if (findUnitGroup(entry.name)) state[entry.name] = state[entry.name] ?? []
      continue
    }
    const group = findUnitGroup(entry.section)
    if (!group) continue
    const list = state[entry.section] ?? []
    const field = group.fields.find((f) => f.key.toLowerCase() === entry.key.toLowerCase())
    if (!field) continue
    const hit = list.find((v) => v.key.toLowerCase() === field.key.toLowerCase())
    if (hit) {
      // 重复键：游戏使用最后一处；表单显示生效值并保留全部行号供提示
      const prev = hit.dupLines ?? (hit.line !== undefined ? [hit.line] : [])
      hit.value = toEnValue(entry.rawValue.trim(), zhToEn)
      hit.line = entry.index + 1
      hit.dupLines = [...prev, entry.index + 1]
    } else {
      list.push({ key: field.key, value: toEnValue(entry.rawValue.trim(), zhToEn), present: true, line: entry.index + 1 })
    }
  }
  return state
}

function fillOneGroup(group: { fields: UnitFieldDef[] }, existing: UnitFormValue[]): UnitFormValue[] {
  const list: UnitFormValue[] = []
  for (const f of group.fields) {
    const hit = existing.find((v) => v.key.toLowerCase() === f.key.toLowerCase())
    list.push(hit ?? { key: f.key, value: f.defaultValue ?? '', present: false })
  }
  return list
}

/** 缺失的字段补默认值（表单展示用；写回时不落盘——只有用户改动才写入）。
 * 炮塔组按文件中的实际节（turret_1/turret_2/…）逐节实例化；文件没有炮塔节时不生成。 */
export function fillDefaults(state: UnitFormState): UnitFormState {
  const out: UnitFormState = {}
  for (const group of UNIT_FORM_GROUPS) {
    if (group.section === 'turret') {
      for (const secName of Object.keys(state).filter((k) => /^turret(_|$)/.test(k))) {
        out[secName] = fillOneGroup(group, state[secName] ?? [])
      }
      continue
    }
    out[group.section] = fillOneGroup(group, state[group.section] ?? [])
  }
  return out
}

/** 全部组定义（表单按此顺序渲染） */
export function findGroups(): Array<{ section: string; label: string; fields: UnitFieldDef[] }> {
  return UNIT_FORM_GROUPS
}

/** 判断文本是否单位文件（出现 [core]/[核心] 节；表单面板用） */
export function isUnitFile(content: string): boolean {
  return /^\s*\[(?:core|核心)\]\s*(?:#.*)?$/im.test(content)
}

export interface ApplyUnitFormOptions {
  zhToEn?: ZhToEn
  enToZh?: EnToZh
}

/**
 * 表单字段变更 → 新文件内容。
 * sectionName 为完整节名（'core' / 'turret_1'；节不存在则按该名创建）：
 * - 键已存在：更新生效行（最后一处，游戏实际读取的值），保留缩进与原分隔符；
 *   值中的 # 属于值本身，不做行内注释保留（引擎只识别整行 # 注释）；
 * - 键不存在且节存在：追加到节尾；
 * - 键不存在且节不存在：创建节并追加（追加到文件尾）。
 * 中文显示层：追加新键时用 enToZh 反查中文键名（与文件语言一致）。
 */
export function applyUnitFormValue(content: string, sectionName: string, key: string, value: string, options: ApplyUnitFormOptions = {}): string {
  const zhToEn = options.zhToEn
  const enToZh = options.enToZh
  const crlf = content.includes('\r\n')
  const lines = content.split(/\r?\n/)
  const targetSection = sectionName.toLowerCase()

  // 找目标节与键的位置（键取最后一处 = 生效行；三引号块内不匹配）
  let sectionLine = -1
  let sectionEnd = lines.length
  let keyLine = -1
  let keySep = ':'
  let keyRawName = key
  for (const entry of walkLines(lines, zhToEn)) {
    if (entry.type === 'section') {
      if (entry.name === targetSection) {
        if (sectionLine < 0) sectionLine = entry.index
      } else if (sectionLine >= 0) {
        // 已找到目标节：遇到下一个节即结束
        sectionEnd = entry.index
        break
      }
      continue
    }
    if (sectionLine < 0 || entry.section !== targetSection) continue
    if (entry.key.toLowerCase() === key.toLowerCase()) {
      keyLine = entry.index
      keySep = entry.sep
      keyRawName = entry.rawKey
    }
  }

  const isEmpty = value.trim() === ''

  if (keyLine >= 0) {
    if (isEmpty) {
      // 清空非必填字段 → 删除该行（游戏对空值行行为未知，不留空值）
      lines.splice(keyLine, 1)
    } else {
      // 替换生效行：保留缩进、原分隔符风格与文件原键名写法（中文显示层保持中文键）
      const indent = /^(\s*)/.exec(lines[keyLine])?.[1] ?? ''
      const sepText = keySep === '=' ? ' = ' : ': '
      lines[keyLine] = `${indent}${keyRawName}${sepText}${value}`
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
    // 节不存在：追加新节到文件尾（前面补空行分隔）
    const displayKey = enToZh ? enToZh(key) ?? key : key
    const displayValue = enToZh && /^(true|false)$/i.test(value) ? (enToZh(value) ?? value) : value
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length > 0) lines.push('')
    lines.push(`[${sectionName}]`)
    lines.push(`${displayKey}: ${displayValue}`)
  }
  let out = crlf ? lines.join('\r\n') : lines.join('\n')
  // 保留原文件的结尾换行（push/pop 会丢失它）
  if (content.endsWith('\n') && !out.endsWith('\n')) out += crlf ? '\r\n' : '\n'
  return out
}

/** 下一个可用炮塔节名（按已有 [turret_N] 最大编号 +1；无编号节从 1 起） */
export function nextTurretSectionName(content: string): string {
  let max = 0
  for (const m of content.matchAll(/^\s*\[turret[_-](\d+)\]/gim)) {
    max = Math.max(max, Number(m[1]))
  }
  return `turret_${max + 1}`
}

/** 新建炮塔节（带 x/y 默认行，游戏需要坐标才能定位炮塔） */
export function appendTurretSection(content: string, sectionName: string): string {
  const crlf = content.includes('\r\n')
  const lines = content.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > 0) lines.push('')
  lines.push(`[${sectionName}]`)
  lines.push('x: 0')
  lines.push('y: 0')
  let out = crlf ? lines.join('\r\n') : lines.join('\n')
  if (content.endsWith('\n') && !out.endsWith('\n')) out += crlf ? '\r\n' : '\n'
  return out
}

/** 删除整个节（节头到下一节前；找不到原样返回）。用于删除炮塔实例。 */
export function removeUnitSection(content: string, sectionName: string, options: ApplyUnitFormOptions = {}): string {
  const crlf = content.includes('\r\n')
  const lines = content.split(/\r?\n/)
  const target = sectionName.toLowerCase()
  let start = -1
  let end = lines.length
  let inTriple = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inTriple) {
      if (flipsTripleQuote(line)) inTriple = false
      continue
    }
    if (flipsTripleQuote(line)) {
      inTriple = true
      continue
    }
    const sec = SECTION_RE.exec(line)
    if (!sec) continue
    const name = toEnKey(sec[1].trim(), options.zhToEn).toLowerCase()
    if (start < 0 && name === target) {
      start = i
      continue
    }
    if (start >= 0) {
      end = i
      break
    }
  }
  if (start < 0) return content
  // 节尾到文件末尾时，保留结尾换行对应的空串元素
  if (end === lines.length && lines[lines.length - 1] === '') end = lines.length - 1
  // 连同节前的空行一起删（避免残留双空行）
  let from = start
  while (from > 0 && lines[from - 1].trim() === '') from--
  lines.splice(from, end - from)
  return crlf ? lines.join('\r\n') : lines.join('\n')
}

/** 相对路径计算（手工按 / 分段；段比较大小写不敏感，兼容 Windows 大小写差异） */
export function relativePath(fromDir: string, toPath: string): string {
  const from = fromDir.split('/').filter(Boolean)
  const to = toPath.split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < to.length && from[i].toLowerCase() === to[i].toLowerCase()) i++
  const up = from.length - i
  const rest = to.slice(i)
  return [...Array(up).fill('..'), ...rest].join('/')
}

/**
 * 资源选择写回值（表单审计 P1 修复）：
 * 统一到项目根坐标——单位绝对路径（可能含反斜杠）先归一化并剥掉项目根前缀，
 * 再对资源的项目根相对路径（posix）计算相对单位目录的路径。
 * 例：单位 units/tank/tank.ini + 资源 units/tank/body.png → body.png（旧实现可能算出 ../../..）。
 */
export function unitResourceRelPath(unitAbsPath: string, projectRoot: string, resourceRel: string): string {
  const root = normSlashes(projectRoot).replace(/\/+$/, '')
  const unit = normSlashes(unitAbsPath)
  const unitRel =
    unit.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? unit.slice(root.length + 1) : unit
  const unitDir = unitRel.includes('/') ? unitRel.slice(0, unitRel.lastIndexOf('/')) : ''
  return relativePath(unitDir, normSlashes(resourceRel))
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
        // M32（同步桌面端修复）：数字输入中间态放行（-、1.、.5、1e 等）——
        // Number() 对它们返回 NaN 导致报错回退，负数字段（shadowOffsetX 等）
        // 无法键盘输入负号；只有最终完整数字才检查范围
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

/** 数字是否已输入完整（区别于 -、1.、.5、1e 等中间态）：完整才允许写回代码 */
export function isCompleteNumber(value: string): boolean {
  return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())
}
