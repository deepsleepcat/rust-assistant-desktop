/**
 * 键名拼写检查（checkKeyTypos）：
 * 键不在代码表时，与代码表键做相似度匹配，疑似拼写错误给出候选。
 * 自定义键（无相似候选）合法不报；宏字段（含 _数字_ 段）跳过，避免误报。
 *
 * 性能：相似度只在粗筛候选（首字符相同 + 长度差 ≤ 2）上计算，
 * 未知键通常是个位数，单文件开销可忽略。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, getIni, toEnKey } from './helpers'

/** 宏字段段（action_1_convertTo / builtFrom_1_name / resourceAmount_2 等）与
 * 动画时间键（body_0s / arm1_0s / leg3_1s）与 mutator 变体（引擎 ae.java:190
 * 按前缀收集全部 mutator* 键，X/Y/Z/XQ 等轴变体无限，代码表补不全）：跳过拼写检查 */
function looksLikeMacroField(key: string): boolean {
  return /_\d+_/.test(key) || /^[a-zA-Z]+_\d+$/.test(key) || /_\d*\.?\d+s$/.test(key) || key.startsWith('mutator')
}

/** 引擎指令/语言后缀键的检查策略：
 * - @ 开头：引擎指令（@define/@global/@memory/@copyFromSection 等），
 *   由引擎按前缀收集，不参与代码表 → 完全跳过；
 * - _en/_zh/_en_us 结尾：官方多语言后缀键（displayText_en 等）→ 剥后缀后按
 *   基础名检查（displayText_en 基础名在代码表 → 合法；displayTex_en 基础名
 *   拼写错误 → 照常报疑似拼写）。返回 null 表示跳过。 */
function engineDirectiveBase(key: string): string | null {
  if (key.startsWith('@')) return null
  const m = /^(.*)_[a-z]{2}(?:_[a-z]{2})?$/i.exec(key)
  if (m && m[1]) return m[1]
  return key
}

/** Levenshtein 距离（≤ 2 视为相似；超过 2 提前返回 3 避免无谓计算） */
function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (!a.length) return b.length
  if (!b.length) return a.length
  const dp = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) dp[j] = j
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** 找相似候选：首字符相同 + 长度差 ≤ 2 + 编辑距离 ≤ 2（返回最相似者） */
export function findSimilarKey(unknown: string, allKeys: readonly string[]): string | undefined {
  const lower = unknown.toLowerCase()
  const first = lower[0]
  let best: { key: string; dist: number } | null = null
  for (const k of allKeys) {
    const kl = k.toLowerCase()
    if (kl === lower) return k
    if (kl[0] !== first) continue
    if (Math.abs(kl.length - lower.length) > 2) continue
    const dist = levenshtein(lower, kl)
    if (dist <= 2 && (!best || dist < best.dist)) best = { key: k, dist }
  }
  return best?.key
}

export const checkKeyTypos: SemanticChecker = {
  id: 'checkKeyTypos',
  title: '键名拼写检查',
  description: '键不在代码表时，与代码表键比对相似度，疑似拼写错误给出候选键名',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { keyValues } = getIni(ctx, content)
    if (!ctx?.findCode || !ctx.codes) return issues
    const allKeys = ctx.codes
    const seen = new Set<string>()
    for (const kv of keyValues) {
      const enKey = toEnKey(kv.key, ctx.keyZhToEn ?? ctx.zhToEn)
      if (seen.has(enKey)) continue
      seen.add(enKey)
      if (ctx.findCode(enKey)) continue // 代码表命中（含中文回译命中）
      // 键原文是词典已知译名（如 mod-info 的自定义中文键「作者」「地图」）→
      // 用户写的是合法中文词，不做英文拼写建议（回译词不在代码表时 findSimilarKey
      // 会撞出 auto/mass 等无关候选）
      if (ctx.zhToEn?.(kv.key)) continue
      if (looksLikeMacroField(enKey)) continue
      const base = engineDirectiveBase(enKey)
      if (base === null) continue // @ 引擎指令
      // 语言后缀键（displayText_en）：基础名在代码表 = 合法；否则基础名照常查拼写
      const checkKey = base !== enKey ? base : enKey
      if (checkKey !== enKey && ctx.findCode(checkKey)) continue
      const similar = findSimilarKey(checkKey, allKeys)
      // 含 # 的候选是占位符（canbuild_#_name 等），不是可写的键名，不做建议
      if (similar && !similar.includes('#')) {
        issues.push(
          issue(
            kv.line,
            `「${kv.key}」不在代码表中，疑似拼写错误`,
            `是否应为「${similar}」？确认后修改键名`,
            'checkKeyTypos',
            'warning',
            kv.key,
          ),
        )
      }
    }
    return issues
  },
}
