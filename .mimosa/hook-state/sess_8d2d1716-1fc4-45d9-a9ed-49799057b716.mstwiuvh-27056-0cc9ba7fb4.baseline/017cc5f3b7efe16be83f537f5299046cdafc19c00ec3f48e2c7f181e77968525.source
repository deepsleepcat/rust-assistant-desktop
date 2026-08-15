/**
 * core 数值为正（checkPositiveCoreStats）：
 * [core] 节的 maxHp/mass/radius 必须 > 0（≤ 0 单位会立即死亡或不可选中）；
 * price 必须 ≥ 0（免费单位允许 0，负数价格会被游戏拒绝）。
 * 非数字值（maxHp: 2500s）也报错——单位属性不接受单位后缀。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey, toNumber } from './helpers'

/** 必须 > 0 的 core 键 */
const MUST_POSITIVE = new Set(['maxhp', 'mass', 'radius'])
/** 必须 ≥ 0 的 core 键 */
const MUST_NON_NEGATIVE = new Set(['price'])

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
          } else if (n <= 0) {
            issues.push(issue(kv.line, `「${kv.key}」必须为正数，当前为 ${n}`, `改成大于 0 的数值（如 ${Math.max(1, Math.round(Math.abs(n)))}）`, 'checkPositiveCoreStats', 'error', kv.value))
          }
        } else if (MUST_NON_NEGATIVE.has(key)) {
          const n = toNumber(kv.value)
          if (n === null) {
            issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 price: 500）`, 'checkPositiveCoreStats', 'error', kv.value))
          } else if (n < 0) {
            issues.push(issue(kv.line, `「${kv.key}」不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值（免费单位用 0）`, 'checkPositiveCoreStats', 'error', kv.value))
          }
        }
      }
    }
    return issues
  },
}
