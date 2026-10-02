/**
 * 语义检查器共享解析工具：
 * - 单趟构建「行 → 节」索引，全部检查器共用（避免每个检查器重复扫描全文）：
 *   runSemanticChecks 解析一次，经 ctx.parsed 注入，检查器用 getIni() 取；
 * - 每节直接携带键值行列表（keyValuesInSection 变 O(1)，避免节数 × 行数的
 *   全量 filter）；
 * - 键值解析（剥离行内注释、中文显示层回译）；
 * - 数字解析与正数判定。
 *
 * 行号约定：对外一律 1 基（与 AI 质检清单一致）；内部索引 0 基。
 */
import type { SemanticCheckContext, SemanticIssue } from './types'
import { getSectionZhToEnDict } from '../../../services/codeData'

/** 已解析的节：name 为节名（原始大小写），startLine/endLine 为 1 基行号（endLine 不含）；
 * kvs 为节内键值行（单趟构建，O(1) 取用） */
export interface ParsedSection {
  name: string
  /** 节名（小写，匹配用） */
  lower: string
  startLine: number
  endLine: number
  /** 本节内的键值行（按行号升序） */
  kvs: ParsedKeyValue[]
}

/** 键值行：key 为原文键名，value 为剥离行内注释后的值（含中文原样） */
export interface ParsedKeyValue {
  key: string
  value: string
  /** 1 基行号 */
  line: number
}

/** 单趟解析结果（runSemanticChecks 注入 ctx.parsed 供全部检查器共享） */
export interface ParsedIni {
  lines: string[]
  sections: ParsedSection[]
  /** 全部键值行（节内 + 节外，按行号升序） */
  keyValues: ParsedKeyValue[]
}

const SECTION_RE = /^\s*\[(.+?)\]\s*(?:#.*)?$/

/** 键值行解析：key: value 或 key = value（引擎两种写法都认；取先出现的分隔符）。
 * 值后允许行内注释；# 颜色值不剥离。键不允许含 :（否则 ROOT:units/x.png 这类
 * 值里的冒号会把键截断）。 */
const KV_RE = /^([^:#][^:]*?)\s*(?::|=)\s*(.*)$/

/** 剥离行内注释（与 rustLint.stripInlineComment 同规则） */
export function stripInlineComment(value: string): string {
  return value.replace(/[ \t]+#.*$/, '').trim()
}

/** 单趟解析全文：行数组（保留原文）、节索引（含节内键值行）、全部键值行 */
export function parseIni(content: string): ParsedIni {
  const lines = content.split(/\r?\n/)
  const sections: ParsedSection[] = []
  const keyValues: ParsedKeyValue[] = []
  let current: ParsedSection | null = null
  // 引擎多行字符串（""" 语法，ae.java:879-901）：串内行是值的一部分，不参与
  // 节/键值解析（否则描述文本里的「key: value」会被语义检查器误报）
  let inString = false
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const trimmed = text.trim()
    if (inString) {
      // 串内：任何行（含 # 注释行——引擎串内照样扫描闭合符）出现 """ 即闭合
      if (trimmed.includes('"""')) inString = false
      continue
    }
    // 非注释行出现 """ 即进入多行字符串（引擎：注释行整行跳过，不触发）。
    // 同一行开闭（key: """text"""）不算进入多行串——第二个 """ 即闭合符
    if (!trimmed.startsWith('#') && trimmed.includes('"""')) {
      const first = trimmed.indexOf('"""')
      if (trimmed.indexOf('"""', first + 3) === -1) inString = true
      continue
    }
    const sec = SECTION_RE.exec(text)
    if (sec) {
      if (current) current.endLine = i + 1 // 前一节结束（不含本行）
      const name = sec[1].trim()
      current = { name, lower: name.toLowerCase(), startLine: i + 1, endLine: lines.length + 1, kvs: [] }
      sections.push(current)
      continue
    }
    const kv = KV_RE.exec(text)
    if (kv) {
      const entry: ParsedKeyValue = { key: kv[1].trim(), value: stripInlineComment(kv[2]), line: i + 1 }
      keyValues.push(entry)
      if (current) current.kvs.push(entry)
    }
    if (current) current.endLine = i + 2 // 已确认仍在本节内
  }
  return { lines, sections, keyValues }
}

/** 取共享解析结果（检查器统一入口）：框架已注入 ctx.parsed 时直接用，否则兜底自解析 */
export function getIni(ctx: SemanticCheckContext | undefined, content: string): ParsedIni {
  return ctx?.parsed ?? parseIni(content)
}

/** 取某节内的键值行（O(1)：节解析时已归集） */
export function keyValuesInSection(section: ParsedSection): ParsedKeyValue[] {
  return section.kvs
}

/** 键名回译（中文显示层 x坐标 → x）：整串回译 + _ 分段回译 */
export function toEnKey(key: string, zhToEn?: (s: string) => string | undefined): string {
  if (!zhToEn) return key
  const direct = zhToEn(key)
  if (direct) return direct
  if (key.includes('_')) {
    return key
      .split('_')
      .map((seg) => zhToEn(seg) ?? seg)
      .join('_')
  }
  return key
}

/** 节名单词回译（[炮塔_1] 的段「炮塔」→ turret）：优先节名表（section.json 译名，
 * 无条件收录），回落注入词典。节名位置必须得到节名——键译名可能被节名覆盖
 * （「价格」曾被虚构节 prices 覆盖成 prices）也可能撞车（炮塔→节 turret vs 键
 * c_turret_t1），不能与 toEnKey 的键位置共用同一词典。 */
export function sectionWordEn(word: string, zhToEn?: (s: string) => string | undefined): string {
  return getSectionZhToEnDict().get(word) ?? zhToEn?.(word) ?? word
}

/** 节名回译（[炮塔_1] → turret_1） */
export function sectionEnName(section: ParsedSection, zhToEn?: (s: string) => string | undefined): string {
  const parts = section.name.split('_')
  const translated = parts.map((seg) => sectionWordEn(seg, zhToEn)).join('_')
  return translated.toLowerCase()
}

/** 数字解析：支持正负小数/整数、科学计数；非数字返回 null */
export function toNumber(value: string): number | null {
  const v = value.trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 时间解析：支持引擎时间后缀「s」（如 0.2s、30s → 秒数，ae.java 的 time 读取
 * 只认数字 + 可选 s 结尾）；纯数字原样返回；非法返回 null。
 * 注意不能直接改 toNumber——maxHp 等纯数值字段引擎用 Float.parseFloat，
 * 带 s 后缀会抛错，必须保持不认。
 */
export function toTimeNumber(value: string): number | null {
  const v = value.trim()
  if (!v) return null
  const m = v.match(/^(-?\d+(?:\.\d+)?)s?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 解析「单位列表」类值（spawnUnits/convertTo 等），按引擎 ci.java 语法：
 * 值 = 段(,段...)，每段 = 「单位名[*数量][(参数=值,...)]」。
 * 括号参数段内的逗号不是分段符（先剥括号段再按逗号分，ci.java:78-81）；
 * 数量 *N 在括号段之后剥（ci.java:55-60：先取括号段，主体再 split("\\*")）。
 * 返回单位名列表（保留 CUSTOM: 前缀与原始大小写——CUSTOM: 是跨模组引用
 * 标记，由调用方判定跳过存在性检查；这里不剥，否则调用方的
 * startsWith('custom:') 分支会失效）。
 */
export function parseUnitListValue(value: string): string[] {
  const out: string[] = []
  // 括号感知分段：括号深度 > 0 时的逗号属于参数段，不算分隔
  const segs: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      segs.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  segs.push(cur)
  for (const raw of segs) {
    let seg = raw.trim()
    if (!seg) continue
    // 括号参数段（ci.java:78-81：以 ) 结尾的 (...) 段）
    const open = seg.indexOf('(')
    if (open > 0 && seg.endsWith(')')) seg = seg.slice(0, open)
    // 数量后缀 *N（ci.java:59 按 * 分割，[0] 是单位名）
    if (/\*\d+$/.test(seg)) seg = seg.slice(0, seg.lastIndexOf('*'))
    if (!seg.trim()) continue
    out.push(seg.trim())
  }
  return out
}

/** 断言数字 > 0：非数字返回 null（由调用方决定提示），数字 ≤ 0 返回提示 */
export function issue(
  line: number,
  message: string,
  suggestion: string,
  ruleId: string,
  severity: SemanticIssue['severity'] = 'error',
  evidence?: string,
): SemanticIssue {
  return { line, message, severity, suggestion, ruleId, evidence }
}

/** 枚举合法性：忽略大小写后必须命中白名单 */
export function isEnumValue(value: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(value.trim().toLowerCase())
}

/**
 * 游戏内置单位名（官方单位 builtFrom/convertTo 引用但不在 assets/units 下，
 * 从官方数据提取一次硬编码）：检查引用完整性时视为存在，避免误报。
 * 统一小写存储，匹配时大小写不敏感。
 */
export const BUILTIN_UNITS: ReadonlySet<string> = new Set([
  'airfactory',
  'seafactory',
  'landfactory',
  'experimentallandfactory',
  'builder',
  'commandcenter',
  'bugnestn',
  'modularspider_nano',
  'robotcrab',
  'tank',
])

/** 构建大小写不敏感的单位名集合（ctx.unitNames 原始大小写 → 小写集合） */
export function lowerUnitNames(unitNames: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (!unitNames) return new Set()
  return new Set([...unitNames].map((n) => n.toLowerCase()))
}
