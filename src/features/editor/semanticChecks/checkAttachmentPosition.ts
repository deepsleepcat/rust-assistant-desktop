/**
 * 挂载点位置（checkAttachmentPosition）：
 * [attachment_xxx]（单位挂载点）与 [turret_N]（炮塔）的 x/y 必须是数字
 * （像素坐标）。非数字坐标会导致挂载点失效或炮塔位置错乱。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, parseIni, sectionEnName, toEnKey, toNumber } from './helpers'

const POSITION_KEYS = new Set(['x', 'y'])

export const checkAttachmentPosition: SemanticChecker = {
  id: 'checkAttachmentPosition',
  title: '挂载点位置',
  description: '[attachment_xxx] 与 [turret_N] 的 x/y 坐标必须是数字',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections, keyValues } = parseIni(content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (!lower.startsWith('attachment') && !lower.startsWith('turret_')) continue
      for (const kv of keyValuesInSection(keyValues, sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (!POSITION_KEYS.has(key)) continue
        if (toNumber(kv.value) === null) {
          issues.push(
            issue(
              kv.line,
              `「${kv.key}」的值「${kv.value}」不是数字（坐标为像素数值）`,
              `改成数字（如 ${key}: 0 或 ${key}: -12.5）`,
              'checkAttachmentPosition',
              'error',
              kv.value,
            ),
          )
        }
      }
    }
    return issues
  },
}
