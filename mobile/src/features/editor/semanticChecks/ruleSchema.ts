/**
 * 声明式检查规则 schema（M19/M21 共享的纯校验模块）：
 * 无任何依赖（不含 codeData/helpers），因此主进程（AI 工具）与渲染层
 * （编辑器/质检/报告）都能安全引用——electron 构建无法编译 import.meta 等
 * Vite 专属语法，规则校验必须保持零依赖。
 *
 * 安全边界（P2 任务 5）：**只支持声明式规则，不提供任何脚本执行环境**。
 * 规则只能描述「键值匹配 + 数值/枚举/正则校验」，不能执行任意代码。
 */
export type CustomCheckType = 'numeric-range' | 'required-key' | 'forbidden-value' | 'regex-match' | 'enum-value'

export interface CustomRule {
  id: string
  title: string
  description?: string
  /** 匹配节（小写；省略 = 任意节；中文节名经词典回译匹配） */
  section?: string
  /** 匹配键（英文键或中文键） */
  key?: string
  /** error | warning | info（默认 warning：用户规则误报时不至于拦住打包） */
  severity?: 'error' | 'warning' | 'info'
  check: {
    type: CustomCheckType
    min?: number
    max?: number
    values?: string[]
    pattern?: string
  }
}

export interface CustomRuleSet {
  formatVersion: number
  name: string
  rules: CustomRule[]
}

/** 规则 id 规则：字母数字下划线连字符，1-64 字符（防特殊字符混入配置键） */
const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SEVERITIES: ReadonlySet<string> = new Set(['error', 'warning', 'info'])
export const CHECK_TYPES: ReadonlyArray<CustomCheckType> = ['numeric-range', 'required-key', 'forbidden-value', 'regex-match', 'enum-value']

/** 规则集校验：返回人类可读的错误列表（空 = 通过） */
export function validateRuleSet(input: unknown): { ok: true; set: CustomRuleSet } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (raw.formatVersion !== 1) errors.push('formatVersion 必须为 1')
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push('name（规则集名称）不能为空')
  if (!Array.isArray(raw.rules)) {
    errors.push('rules 必须是一个数组')
    return { ok: false, errors }
  }
  const seen = new Set<string>()
  const rules: CustomRule[] = []
  raw.rules.forEach((r, i) => {
    const prefix = `rules[${i}]`
    if (!r || typeof r !== 'object') {
      errors.push(`${prefix} 必须是对象`)
      return
    }
    const rule = r as Record<string, unknown>
    if (typeof rule.id !== 'string' || !RULE_ID_RE.test(rule.id)) {
      errors.push(`${prefix}：id 必须是 1-64 位字母/数字/下划线/连字符`)
      return
    }
    if (seen.has(rule.id)) errors.push(`${prefix}：id「${rule.id}」重复`)
    seen.add(rule.id)
    if (typeof rule.title !== 'string' || !rule.title.trim()) errors.push(`${prefix}：title 不能为空`)
    const severity = rule.severity === undefined ? 'warning' : rule.severity
    if (typeof severity !== 'string' || !SEVERITIES.has(severity)) errors.push(`${prefix}：severity 只能是 error/warning/info`)
    if (rule.section !== undefined && typeof rule.section !== 'string') errors.push(`${prefix}：section 必须是字符串`)
    if (rule.key !== undefined && typeof rule.key !== 'string') errors.push(`${prefix}：key 必须是字符串`)
    const check = rule.check
    if (!check || typeof check !== 'object') {
      errors.push(`${prefix}：缺少 check（检查规则）`)
      return
    }
    const c = check as Record<string, unknown>
    if (typeof c.type !== 'string' || !CHECK_TYPES.includes(c.type as CustomCheckType)) {
      errors.push(`${prefix}：check.type 必须是 ${CHECK_TYPES.join('/')} 之一`)
      return
    }
    // 分类型参数校验
    if (c.type === 'numeric-range') {
      const min = c.min
      const max = c.max
      const minOk = min === undefined || (typeof min === 'number' && Number.isFinite(min))
      const maxOk = max === undefined || (typeof max === 'number' && Number.isFinite(max))
      if (!minOk || !maxOk) errors.push(`${prefix}：numeric-range 的 min/max 必须是数字`)
      if (minOk && maxOk && min !== undefined && max !== undefined && (min as number) > (max as number)) {
        errors.push(`${prefix}：numeric-range 的 min 不能大于 max`)
      }
      if (min === undefined && max === undefined) errors.push(`${prefix}：numeric-range 至少需要 min 或 max`)
    }
    if (c.type === 'required-key') {
      if (typeof rule.key !== 'string' || !rule.key.trim()) errors.push(`${prefix}：required-key 必须指定 key`)
    }
    if (c.type === 'forbidden-value' || c.type === 'enum-value') {
      const values = c.values
      if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) {
        errors.push(`${prefix}：${c.type} 的 values 必须是非空字符串数组`)
      }
    }
    if (c.type === 'regex-match') {
      if (typeof c.pattern !== 'string' || !c.pattern) {
        errors.push(`${prefix}：regex-match 必须指定 pattern`)
      } else {
        try {
          new RegExp(c.pattern)
        } catch {
          errors.push(`${prefix}：regex-match 的 pattern 不是合法正则：${c.pattern}`)
        }
      }
    }
    rules.push({
      id: rule.id,
      title: String(rule.title ?? rule.id),
      description: typeof rule.description === 'string' ? rule.description : undefined,
      section: typeof rule.section === 'string' ? rule.section : undefined,
      key: typeof rule.key === 'string' ? rule.key : undefined,
      severity: (severity as CustomRule['severity']) ?? 'warning',
      check: {
        type: c.type as CustomCheckType,
        min: typeof c.min === 'number' ? c.min : undefined,
        max: typeof c.max === 'number' ? c.max : undefined,
        values: Array.isArray(c.values) ? c.values.filter((v): v is string => typeof v === 'string') : undefined,
        pattern: typeof c.pattern === 'string' ? c.pattern : undefined,
      },
    })
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, set: { formatVersion: 1, name: String(raw.name), rules } }
}
