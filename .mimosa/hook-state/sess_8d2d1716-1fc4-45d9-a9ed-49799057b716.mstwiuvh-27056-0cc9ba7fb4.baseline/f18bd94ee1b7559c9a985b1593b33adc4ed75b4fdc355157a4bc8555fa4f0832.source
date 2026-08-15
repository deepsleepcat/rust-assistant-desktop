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

/** 键值行解析：key: value（值后允许行内注释；# 颜色值不剥离） */
const KV_RE = /^([^:#][^:]*?)\s*:\s*(.*)$/

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
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
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

/** 节名回译（[炮塔_1] → turret_1） */
export function sectionEnName(section: ParsedSection, zhToEn?: (s: string) => string | undefined): string {
  if (!zhToEn) return section.lower
  const parts = section.name.split('_')
  const translated = parts.map((seg) => zhToEn(seg) ?? seg).join('_')
  return translated.toLowerCase()
}

/** 数字解析：支持正负小数/整数、科学计数；非数字返回 null */
export function toNumber(value: string): number | null {
  const v = value.trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
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
