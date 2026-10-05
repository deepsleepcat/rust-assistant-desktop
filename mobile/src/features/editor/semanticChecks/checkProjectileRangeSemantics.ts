/**
 * 弹体射程语义（checkProjectileRangeSemantics）：
 * 1) 弹体 speed 必须 ≥ 0（speed: 0 是官方合法语义——爆炸/特效弹体不移动；
 *    负数弹体会反向飞行）；
 * 2) directDamage 必须 ≥ 0（负伤害会给目标回血）；
 * 3) range 键（若存在）必须 ≥ 0——射程由攻击距离或弹体 speed×life 决定，
 *    显式 range 为负时弹体没有有效射程。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey, toNumber } from './helpers'

export const checkProjectileRangeSemantics: SemanticChecker = {
  id: 'checkProjectileRangeSemantics',
  title: '弹体射程语义',
  description: '弹体 speed 必须 > 0，directDamage ≥ 0，range > 0',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (!sectionEnName(sec, zhToEn).startsWith('projectile_')) continue
      for (const kv of keyValuesInSection(sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        const n = toNumber(kv.value)
        if (key === 'speed' || key === 'range') {
          if (n === null) {
            issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 ${key}: 3.0）`, 'checkProjectileRangeSemantics', 'error', kv.value))
          } else if (n < 0) {
            issues.push(
              issue(
                kv.line,
                `弹体「${key}」不能为负数，当前为 ${n}`,
                key === 'speed' ? '速度为负的弹体会反向飞行，改成 ≥ 0' : '射程为负的弹体打不到目标，改成 ≥ 0',
                'checkProjectileRangeSemantics',
                'error',
                kv.value,
              ),
            )
          }
        } else if (key === 'directdamage') {
          if (n !== null && n < 0) {
            issues.push(issue(kv.line, `弹体 directDamage 不能为负数，当前为 ${n}`, `改成 ≥ 0 的数值（负伤害会给目标回血）`, 'checkProjectileRangeSemantics', 'error', kv.value))
          } else if (n === null) {
            issues.push(issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 directDamage: 20）`, 'checkProjectileRangeSemantics', 'error', kv.value))
          }
        }
      }
    }
    return issues
  },
}
