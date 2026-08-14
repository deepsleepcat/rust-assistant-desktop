/**
 * 转向速度为正（checkPositiveRotateTurnSpeed）：
 * [movement] maxTurnSpeed 与 [attack] turretTurnSpeed 必须 ≥ 0。
 * 0 是官方合法语义（固定炮塔/不转向形态），只有负数才报错。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey, toNumber } from './helpers'

export const checkPositiveRotateTurnSpeed: SemanticChecker = {
  id: 'checkPositiveRotateTurnSpeed',
  title: '转向速度为正',
  description: '[movement] maxTurnSpeed 与 [attack] turretTurnSpeed 必须 ≥ 0',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (lower !== 'movement' && lower !== 'attack') continue
      const keyName = lower === 'movement' ? 'maxturnspeed' : 'turretturnspeed'
      for (const kv of keyValuesInSection(sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (key !== keyName) continue
        const n = toNumber(kv.value)
        if (n === null) {
          issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 maxTurnSpeed: 1.0）`, 'checkPositiveRotateTurnSpeed', 'error', kv.value))
        } else if (n < 0) {
          issues.push(issue(kv.line, `「${kv.key}」不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值`, 'checkPositiveRotateTurnSpeed', 'error', kv.value))
        }
      }
    }
    return issues
  },
}
