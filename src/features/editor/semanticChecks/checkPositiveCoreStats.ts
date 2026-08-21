/**
 * core 数值为正（checkPositiveCoreStats）：
 * [core] 节的 maxHp/mass/radius：0 是合法值（引擎不限制，事件判定/模板单位
 * 广泛使用 0），降级 warning；负值单位会立即死亡/不可选中，报 error。
 * price：支持引擎资源价格语法（逗号/竖线分段，段 = 纯数字或 资源名[=:]数字，
 * 如 20,矿=500；单段资源形式 price: 矿=500 也合法），负数价格被游戏拒绝，报 error。
 * 非数字值（maxHp: 2500s）也报错——单位属性不接受单位后缀。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { splitTopLevelConfigValue } from '../../../services/configSyntax'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey, toNumber } from './helpers'

/** 必须 ≥ 0 的 core 键（0 合法但提示；负数报错） */
const MUST_POSITIVE = new Set(['maxhp', 'mass', 'radius'])
/** 必须 ≥ 0 的 core 键 */
const MUST_NON_NEGATIVE = new Set(['price'])

/** price 多资源段是否合法（纯数字 或 资源名[=:]数字；引擎 resource 语法同时认 = 和 :） */
function isPriceSegment(seg: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(seg) || /^[^=:,]+[=:]-?\d+(?:\.\d+)?$/.test(seg)
}

/** 价格段的数值部分是否为负（纯数字段「-5」或 资源名=数字 段「矿=-5」） */
function priceSegmentNegative(seg: string): boolean {
  const m = /-?\d+(?:\.\d+)?$/.exec(seg.trim())
  return m ? Number(m[0]) < 0 : false
}

export const checkPositiveCoreStats: SemanticChecker = {
  id: 'checkPositiveCoreStats',
  title: 'core 数值为正',
  description: 'maxHp/mass/radius 必须为正数，price 必须 ≥ 0（免费单位允许 0）',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (sectionEnName(sec, zhToEn) !== 'core') continue
      for (const kv of keyValuesInSection(sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (MUST_POSITIVE.has(key)) {
          const n = toNumber(kv.value)
          if (n === null) {
            issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 maxHp: 500）`, 'checkPositiveCoreStats', 'error', kv.value))
          } else if (n < 0) {
            issues.push(issue(kv.line, `「${kv.key}」不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值`, 'checkPositiveCoreStats', 'error', kv.value))
          } else if (n === 0) {
            issues.push(
              issue(kv.line, `「${kv.key}」为 0（单位会立即死亡/不可选中）`, `改成大于 0 的数值；判定/模板单位可保持 0`, 'checkPositiveCoreStats', 'warning', kv.value),
            )
          }
        } else if (MUST_NON_NEGATIVE.has(key)) {
          // 价格：引擎资源解析器 d.b.a 按逗号或竖线分段（str.split(",|\\|")），
          // 段 = 纯数字 或 资源名[=:]数字（同时认 = 和 :，如 price: 20,矿=500）。
          // 单段资源形式（price: 矿=500）引擎同样接受。负数段游戏拒绝，报 error。
          const segments = splitTopLevelConfigValue(kv.value).flatMap((s) => s.split('|')).map((s) => s.trim()).filter(Boolean)
          if (/[,|，]/.test(kv.value)) {
            if (segments.length === 0 || !segments.every(isPriceSegment)) {
              issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是合法价格`, `用数字（如 price: 500）或资源价格（如 price: 20,矿=500）`, 'checkPositiveCoreStats', 'error', kv.value))
            } else if (segments.some(priceSegmentNegative)) {
              issues.push(issue(kv.line, `「${kv.key}」包含负价格，游戏会拒绝`, `改成 ≥ 0 的数值（免费单位用 0）`, 'checkPositiveCoreStats', 'error', kv.value))
            }
            continue
          }
          if (isPriceSegment(kv.value)) {
            // 单段资源价格（price: 矿=500）：格式合法，只查负数
            if (priceSegmentNegative(kv.value)) {
              issues.push(issue(kv.line, `「${kv.key}」不能为负数`, `改成 ≥ 0 的数值（免费单位用 0）`, 'checkPositiveCoreStats', 'error', kv.value))
            }
            continue
          }
          const n = toNumber(kv.value)
          if (n === null) {
            issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 price: 500）或资源价格（如 price: 20,矿=500）`, 'checkPositiveCoreStats', 'error', kv.value))
          } else if (n < 0) {
            issues.push(issue(kv.line, `「${kv.key}」不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值（免费单位用 0）`, 'checkPositiveCoreStats', 'error', kv.value))
          }
        }
      }
    }
    return issues
  },
}
