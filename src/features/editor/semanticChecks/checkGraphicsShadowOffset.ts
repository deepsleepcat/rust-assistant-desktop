/**
 * 阴影偏移（checkGraphicsShadowOffset）：
 * [graphics] shadowOffsetX/shadowOffsetY 必须是数字（像素偏移）。
 * 非数字偏移会让阴影渲染异常；两个偏移键通常成对出现，只写一个时提示。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, parseIni, sectionEnName, toEnKey, toNumber } from './helpers'

const SHADOW_OFFSET_KEYS = new Set(['shadowoffsetx', 'shadowoffsety'])

export const checkGraphicsShadowOffset: SemanticChecker = {
  id: 'checkGraphicsShadowOffset',
  title: '阴影偏移',
  description: '[graphics] shadowOffsetX/Y 必须是数字，且两个偏移键成对出现',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections, keyValues } = parseIni(content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (sectionEnName(sec, zhToEn) !== 'graphics') continue
      const kvs = keyValuesInSection(keyValues, sec)
      const hasX = kvs.some((kv) => toEnKey(kv.key, zhToEn).toLowerCase() === 'shadowoffsetx')
      const hasY = kvs.some((kv) => toEnKey(kv.key, zhToEn).toLowerCase() === 'shadowoffsety')
      if (hasX !== hasY) {
        issues.push(
          issue(
            sec.startLine,
            `阴影偏移只写了 ${hasX ? 'shadowOffsetX' : 'shadowOffsetY'}，建议成对补齐`,
            `补齐另一个偏移键（游戏默认按单位中心偏移，单写一个会导致阴影位置不对称）`,
            'checkGraphicsShadowOffset',
            'info',
            hasX ? 'shadowOffsetX' : 'shadowOffsetY',
          ),
        )
      }
      for (const kv of kvs) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (!SHADOW_OFFSET_KEYS.has(key)) continue
        if (toNumber(kv.value) === null) {
          issues.push(
            issue(kv.line, `「${kv.key}」的值「${kv.value}」不是数字`, `改成数字（如 shadowOffsetX: 1）`, 'checkGraphicsShadowOffset', 'error', kv.value),
          )
        }
      }
    }
    return issues
  },
}
