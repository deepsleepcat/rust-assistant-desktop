/**
 * 编辑器错误检查（lint）：
 * - 值合法性：按代码表值类型的 rule 正则校验 key: value 的值部分，
 *   不合法时在值下方标波浪线（红色错误标记）；
 * - 节外代码：key 值行不在任何 [节] 内时给出警告；
 * - 兼容处理：行内注释剥离、中文模式值回译（是/真 → true）、
 *   NONE/AUTO/SHARED 常量放行、变量引用 ${...} 放行。
 *
 * 数据来源：value_type.json 的 rule 字段（与自动补全共用 codeData）。
 */
import { linter } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { ValueTypeInfo } from '../../services/codeData'
import { findCodeByCode, findValueType, getZhToEnDict, loadCodeData, zhToEnKeySegments } from '../../services/codeData'
import { classifyLine } from './rustLanguage'

/** 规则描述「整行/键」而非「值」的类型：值校验时跳过，避免误报 */
const LINE_LEVEL_TYPES = new Set(['key', 'section', 'value', 'notes', 'define', 'prefixKey', 'code'])

/** 游戏内特殊常量：对这些常量一律放行（image/audio/path 等字段常见） */
const SPECIAL_CONSTANTS = new Set(['NONE', 'AUTO', 'SHARED'])

/** 去掉行内注释（值后面以空格开头 # 的注释部分），颜色值 #000000 不受影响 */
export function stripInlineComment(value: string): string {
  return value.replace(/[ \t]+#.*$/, '').trim()
}

/** 检查单个 key:value 值是否合法（纯函数，供测试）。返回 null 表示合法或无需检查。 */
export function validateValue(
  key: string,
  value: string,
  data: {
    findCode: (k: string) => { type: string } | undefined
    findType: (t: string) => ValueTypeInfo | undefined
    zhToEn?: (k: string) => string | undefined
  },
): string | null {
  const trimmed = stripInlineComment(value)
  if (!trimmed) return null

  // 变量引用/表达式：值内任意位置出现 ${...} 即放行
  // （如 alpha: 0.3+cos( ${timer_2s} * 360) * 0.2 这类表达式）
  if (trimmed.includes('${')) return null
  // 游戏特殊常量放行
  if (SPECIAL_CONSTANTS.has(trimmed)) return null

  // 中文模式：键可能是中文译名或分段翻译的宏字段（如「名称」「建造自_1_名称」），
  // 整串回译失败时按 _ 分段回译再查表
  let code = data.findCode(key)
  if (!code && data.zhToEn) {
    const en = data.zhToEn(key) ?? (key.includes('_') ? zhToEnKeySegments(key) : undefined)
    if (en) code = data.findCode(en)
  }
  if (!code) return null // 键不在代码表 → 用户自定义字段，不检查

  // 多值 type（'float,logicBoolean' 等）：各段类型是 OR 语义——任一类型的规则命中即放行。
  // （第 6 轮修复：此前逗号分段匹配只取第一个段，导致 float 规则误报动态逻辑字段）
  const types = code.type.split(',').map((t) => t.trim()).filter(Boolean)
  const vts = types.map((t) => data.findType(t)).filter((v): v is ValueTypeInfo => v !== undefined)
  if (vts.length === 0) return null
  // 规则描述整行/键（如 key: '^[^#:]+:'），不是值格式 → 跳过
  if (types.some((t) => LINE_LEVEL_TYPES.has(t))) return null

  // 布尔/逻辑字段允许表达式形态：if/如果 开头、self. 引用、CUSTOM: 自定义、
  // 括号表达式、中文逻辑词（和/或者/非）开头——中文显示层 if→如果（词典逐词翻译），
  // 注意 JS \b 对中文不成立，必须用 (?:\s|$) 判定词界
  if (
    types.some((t) => t === 'boolean' || t === 'logicBoolean') &&
    (trimmed.includes('self.') ||
      trimmed.includes('CUSTOM:') ||
      /^(?:if\b|如果(?:\s|$))/i.test(trimmed) ||
      /^(?:和|或者|非)(?:\s|$)/.test(trimmed) ||
      /[()]/.test(trimmed))
  ) return null

  // 任一类型规则命中即合法
  for (const vt of vts) {
    if (!vt?.rule) continue
    const rule = vt.rule.trim()
    // 无实际约束的规则（匹配任意内容）跳过
    if (rule === '.' || rule === '.+' || rule === '.*') return null

    let re: RegExp
    let reCI: RegExp | null = null
    try {
      // 完整匹配语义：整体包一层非捕获组
      re = new RegExp(`^(?:${rule})$`)
      // 大小写不敏感回退（如 displayType: Upgrade 匹配规则里的 upgrade）
      reCI = new RegExp(`^(?:${rule})$`, 'i')
    } catch {
      continue // 规则本身无法编译 → 尝试下一个类型
    }

    // 候选值：原文 + 中文回译（是/真 → true，非/假 → false）
    const candidates = [trimmed]
    if (data.zhToEn) {
      const en = data.zhToEn(trimmed)
      if (en && en !== trimmed) candidates.push(en.trim())
    }
    if (candidates.some((c) => re.test(c) || (reCI?.test(c) ?? false))) return null

    // 逗号分隔的多值列表（如 explodeEffect: a, CUSTOM:b）：任一元素合法即放行
    if (trimmed.includes(',')) {
      const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
      if (parts.length > 1 && parts.some((p) => re.test(p) || (reCI?.test(p) ?? false))) return null
    }
  }

  const vt = vts[0]
  const expect = vt?.describe ? `（期望：${vt.describe}）` : ''
  return `「${key}」的值「${trimmed}」不符合类型 ${code.type}${expect}`
}

/** 计算整篇文档的诊断（纯函数，供测试） */
export function lintIniText(
  content: string,
  data: {
    findCode: (k: string) => { type: string } | undefined
    findType: (t: string) => ValueTypeInfo | undefined
    zhToEn?: (k: string) => string | undefined
  },
): Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }> {
  const diagnostics: Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }> = []
  const lines = content.split('\n')
  let lineStart = 0
  // 单趟遍历维护「当前节」：每行向上重扫是 O(n²)，万行级文件会明显卡顿
  let section = ''
  const sectionRe = /^\s*\[(.+?)\]\s*(?:#.*)?$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const classified = classifyLine(line)
    const sectionMatch = sectionRe.exec(line)
    if (sectionMatch) section = sectionMatch[1]
    const currentSection = section

    if (classified.kind === 'keyvalue' && classified.key && classified.value !== undefined) {
      // 节外代码：不在任何节内的键值行 → 警告
      if (!currentSection) {
        diagnostics.push({
          from: lineStart,
          to: lineStart + line.length,
          message: '此键值行不在任何 [节] 内，游戏会忽略它',
          severity: 'warning',
        })
      }
      // 值合法性
      const err = validateValue(classified.key, classified.value, data)
      if (err) {
        const colon = line.indexOf(':')
        const from = lineStart + colon + 1
        diagnostics.push({ from, to: lineStart + line.length, message: err, severity: 'error' })
      }
    }
    lineStart += line.length + 1
  }
  return diagnostics
}

/** CodeMirror lint 扩展（异步加载代码表数据后逐行检查） */
export function rustLintExtension() {
  return linter(
    async (view: EditorView) => {
      await loadCodeData()
      const zhToEnDict = getZhToEnDict()
      return lintIniText(view.state.doc.toString(), {
        findCode: (k) => findCodeByCode(k),
        findType: (t) => findValueType(t),
        zhToEn: (k) => zhToEnDict.get(k),
      })
    },
    { delay: 400 },
  )
}
