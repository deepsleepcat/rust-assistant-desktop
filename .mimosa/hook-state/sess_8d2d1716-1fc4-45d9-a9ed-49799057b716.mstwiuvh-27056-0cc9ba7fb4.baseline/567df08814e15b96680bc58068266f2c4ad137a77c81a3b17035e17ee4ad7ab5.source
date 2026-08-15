/**
 * 移动速度为正（checkPositiveMovementSpeed）：
 * [movement] 节 moveSpeed 必须 > 0（0 或负的单位无法移动）；
 * moveAccelerationSpeed / moveDecelerationSpeed 必须 ≥ 0（加速/减速为负没有意义）。
 * 注意：moveSpeed: 0 是官方合法语义（过渡/水下形态表示「该形态不可移动」），
 * 只有负数才报错。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey, toNumber } from './helpers'

const SPEED_KEYS = new Set(['movespeed', 'moveaccelerationspeed', 'movedecelerationspeed'])

export const checkPositiveMovementSpeed: SemanticChecker = {
  id: 'checkPositiveMovementSpeed',
  title: '移动速度为正',
  description: '[movement] 节 moveSpeed 必须 > 0，加/减速度必须 ≥ 0',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (sectionEnName(sec, zhToEn) !== 'movement') continue
      for (const kv of keyValuesInSection(sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (!SPEED_KEYS.has(key)) continue
        const n = toNumber(kv.value)
        if (n === null) {
          issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 moveSpeed: 1.0）`, 'checkPositiveMovementSpeed', 'error', kv.value))
        } else if (n < 0) {
          issues.push(issue(kv.line, `「${kv.key}」不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值`, 'checkPositiveMovementSpeed', 'error', kv.value))
        }
      }
    }
    return issues
  },
}
