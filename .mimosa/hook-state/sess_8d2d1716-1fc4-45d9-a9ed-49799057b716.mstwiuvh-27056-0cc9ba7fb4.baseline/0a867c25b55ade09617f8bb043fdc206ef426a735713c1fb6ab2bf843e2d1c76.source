/**
 * 声明式自定义检查规则（M19 AI 生成用例 + M21 插件接口，P2 任务 3/5）：
 * 高级用户可在项目 rules/*.json 里放检查规则文件，被语义检查器框架加载生效；
 * AI 可生成同格式的检查用例（generateCheckCases 工具），试运行后可保存为项目规则。
 *
 * 安全边界（P2 任务 5 明确要求）：**只支持声明式规则，不提供任何脚本执行环境**。
 * 规则只能描述「键值匹配 + 数值/枚举/正则/引用校验」，不能执行任意代码——
 * 恶意规则文件最多产生误报，无法读写文件或执行命令。
 *
 * 规则文件 schema（formatVersion 1）：
 * {
 *   "formatVersion": 1,
 *   "name": "我的规则集",            // 必填，展示用
 *   "rules": [
 *     {
 *       "id": "maxHp-range",          // 必填，^[A-Za-z0-9_-]{1,64}$，集内唯一
 *       "title": "血量范围",           // 必填
 *       "description": "maxHp 必须在 1~10000",  // 可选
 *       "section": "core",            // 可选；省略 = 任意节（支持中文节名）
 *       "key": "maxHp",               // 必填（required-key 外）；英文或中文键
 *       "severity": "warning",        // 可选；error|warning|info，默认 warning
 *       "check": { "type": "numeric-range", "min": 1, "max": 10000 }
 *     }
 *   ]
 * }
 *
 * check.type 一览：
 * - numeric-range  数值区间 { min?, max? }（至少一侧）；值不是数字时跳过（基础 lint 管）
 * - required-key   节内必须存在该键 { }（需要 section）
 * - forbidden-value 值不得等于列表任一 { values: string[] }（大小写不敏感）
 * - enum-value     值必须是列表之一 { values: string[] }（大小写不敏感）
 * - regex-match    值必须匹配正则 { pattern: string }（完整匹配）
 */
import type { SemanticCheckContext, SemanticIssue } from './types'
import { getIni, sectionEnName, toEnKey, toNumber } from './helpers'
import { validateRuleSet, type CustomRule, type CustomRuleSet } from './ruleSchema'
import { joinProjectPath } from '../../../utils/projectPath'

export type { CustomCheckType, CustomRule, CustomRuleSet } from './ruleSchema'
export { validateRuleSet, CHECK_TYPES } from './ruleSchema'

/** 键匹配（双向回译）：规则 key 与文件键都可能用中文（中文显示层）；
 * 四个方向任一命中即匹配——原文相等 / 文件键回译 / 规则键回译 / 双方回译 */
function keyMatches(kvKey: string, ruleKey: string, ctx: SemanticCheckContext | undefined): boolean {
  const kvLower = kvKey.toLowerCase()
  const ruleLower = ruleKey.toLowerCase()
  if (kvLower === ruleLower) return true
  const kvEn = toEnKey(kvKey, ctx?.zhToEn).toLowerCase()
  if (kvEn === ruleLower) return true
  const ruleEn = toEnKey(ruleKey, ctx?.zhToEn).toLowerCase()
  return kvLower === ruleEn || kvEn === ruleEn
}

/** 执行一组自定义规则（config 为设置配置：custom: 前缀键显式 false 时跳过；
 * 缺省/未配置 = 全部执行——AI 保存的规则默认生效，开关在设置里显式关闭） */
export function runCustomRules(content: string, rules: CustomRule[], ctx: SemanticCheckContext | undefined, config?: Record<string, boolean>): SemanticIssue[] {
  const issues: SemanticIssue[] = []
  const ini = getIni(ctx, content)
  if (ini.sections.length === 0) return issues
  for (const rule of rules) {
    const ruleKey = `custom:${rule.id}`
    if (config && config[ruleKey] === false) continue
    const severity = rule.severity ?? 'warning'
    // 节过滤：规则 section 支持中文，双向回译后比对（[核心] ↔ core）
    const sectionFilter = rule.section?.toLowerCase()
    const sectionFilterEn = rule.section ? toEnKey(rule.section, ctx?.zhToEn).toLowerCase() : undefined
    for (const section of ini.sections) {
      const secLower = sectionEnName(section, ctx?.zhToEn)
      if (sectionFilter && secLower !== sectionFilter && section.name.toLowerCase() !== sectionFilter && secLower !== sectionFilterEn) continue
      if (rule.check.type === 'required-key') {
        // 节内必须存在该键（键匹配：原文或回译）
        if (rule.key && !section.kvs.some((kv) => keyMatches(kv.key, rule.key!, ctx))) {
          issues.push({
            line: section.startLine,
            message: `规则「${rule.title}」：节 [${section.name}] 缺少必需键「${rule.key}」`,
            severity,
            suggestion: `在节 [${section.name}] 内添加 ${rule.key}: ...`,
            ruleId: ruleKey,
          })
        }
        continue
      }
      for (const kv of section.kvs) {
        if (rule.key && !keyMatches(kv.key, rule.key, ctx)) continue
        const value = kv.value.trim()
        const c = rule.check
        let message: string | null = null
        let suggestion = ''
        if (c.type === 'numeric-range') {
          const n = toNumber(value)
          if (n !== null) {
            if (c.min !== undefined && n < c.min) {
              message = `规则「${rule.title}」：${kv.key} = ${value} 小于下限 ${c.min}`
              suggestion = `把值改到 ≥ ${c.min}`
            } else if (c.max !== undefined && n > c.max) {
              message = `规则「${rule.title}」：${kv.key} = ${value} 大于上限 ${c.max}`
              suggestion = `把值改到 ≤ ${c.max}`
            }
          }
        } else if (c.type === 'forbidden-value') {
          const lower = value.toLowerCase()
          const hit = (c.values ?? []).find((v) => v.toLowerCase() === lower)
          if (hit) {
            message = `规则「${rule.title}」：${kv.key} 的值「${value}」在禁用列表中`
            suggestion = `换成允许的值（如 ${(c.values ?? []).filter((v) => v.toLowerCase() !== lower).slice(0, 3).join('、') || '其他值'}）`
          }
        } else if (c.type === 'enum-value') {
          const allowed = (c.values ?? []).map((v) => v.toLowerCase())
          if (!allowed.includes(value.toLowerCase())) {
            message = `规则「${rule.title}」：${kv.key} 的值「${value}」不在允许列表中`
            suggestion = `必须是：${(c.values ?? []).join('、')}`
          }
        } else if (c.type === 'regex-match') {
          if (c.pattern) {
            let re: RegExp
            try {
              re = new RegExp(`^(?:${c.pattern})$`)
            } catch {
              continue // 校验已拦，防御性跳过
            }
            if (!re.test(value)) {
              message = `规则「${rule.title}」：${kv.key} 的值「${value}」不匹配 ${c.pattern}`
              suggestion = '按规则要求修正该值'
            }
          }
        }
        if (message) {
          issues.push({ line: kv.line, message, severity, suggestion, ruleId: ruleKey, evidence: value })
        }
      }
    }
  }
  return issues
}

/** 在单段文本上试运行规则集（AI 用例「试运行」用；不依赖任何项目数据） */
export function runCustomRulesOnText(content: string, set: CustomRuleSet): SemanticIssue[] {
  return runCustomRules(content, set.rules, undefined)
}

/** 项目规则文件（含来源与校验错误） */
export interface ProjectRuleSet {
  file: string
  name: string
  rules: CustomRule[]
}

export interface ProjectRuleLoadResult {
  sets: ProjectRuleSet[]
  /** 校验失败的文件与错误（界面展示，提示用户修正） */
  errors: Array<{ file: string; errors: string[] }>
}

/**
 * 加载项目 rules/ 目录下的全部 .json 规则文件（M21）：
 * 单个文件损坏只影响该文件（收集错误，不中断其它文件）；
 * 跨文件重复规则 id 会互相干扰开关/去重，作为错误提示用户改名。
 * 路径统一拼成项目内绝对路径再走桥（bridge fs 通道要求绝对路径）。
 */
export async function loadProjectRuleSets(
  rootPath: string,
  bridgeOverride?: { project: { readDir(root: string, dir: string, showHidden?: boolean): Promise<Array<{ name: string; isDirectory: boolean }>>; readFile(root: string, file: string): Promise<{ content: string }> } },
): Promise<ProjectRuleLoadResult> {
  const result: ProjectRuleLoadResult = { sets: [], errors: [] }
  const bridge = bridgeOverride ?? (await import('../../../services/bridge')).getBridge()
  let entries: Array<{ name: string; isDirectory: boolean }>
  try {
    entries = await bridge.project.readDir(rootPath, joinProjectPath(rootPath, 'rules'))
  } catch {
    return result // 没有 rules/ 目录：正常情况
  }
  const files = entries.filter((e) => !e.isDirectory && /\.json$/i.test(e.name))
  const seenIds = new Map<string, string>() // id → 首个出现的文件
  for (const f of files) {
    const rel = `rules/${f.name}`
    try {
      const { content } = await bridge.project.readFile(rootPath, joinProjectPath(rootPath, rel))
      const parsed = JSON.parse(content) as unknown
      const v = validateRuleSet(parsed)
      if (v.ok) {
        // 跨文件重复 id：开关会互相干扰，报错提示改名（本集仍然加载）
        const dup = v.set.rules.map((r) => r.id).filter((id) => seenIds.has(id))
        for (const id of dup) {
          result.errors.push({
            file: rel,
            errors: [`规则 id「${id}」与 ${seenIds.get(id)} 重复，开关会互相干扰，请改名`],
          })
        }
        for (const r of v.set.rules) if (!seenIds.has(r.id)) seenIds.set(r.id, rel)
        result.sets.push({ file: rel, name: v.set.name, rules: v.set.rules })
      } else {
        result.errors.push({ file: rel, errors: v.errors })
      }
    } catch (err) {
      result.errors.push({ file: rel, errors: [err instanceof Error ? `读取/解析失败：${err.message}` : '读取/解析失败'] })
    }
  }
  return result
}
