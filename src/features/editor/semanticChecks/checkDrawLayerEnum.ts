/**
 * 绘制层枚举合法性（checkDrawLayerEnum）：
 * [graphics] drawLayer 必须是游戏支持的绘制层枚举
 * （wreaks/underwater/bottom/ground/ground2/experimentals/air/top）。
 * 非法值会被游戏忽略，单位可能显示在错误的层。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { isEnumValue, issue, keyValuesInSection, getIni, sectionEnName, toEnKey } from './helpers'

/** 官方 1.15 绘制层枚举（value_type.json drawLayer.list） */
export const DRAW_LAYERS = new Set(['wreaks', 'underwater', 'bottom', 'ground', 'ground2', 'experimentals', 'air', 'top'])

export const checkDrawLayerEnum: SemanticChecker = {
  id: 'checkDrawLayerEnum',
  title: '绘制层枚举合法性',
  description: '[graphics] drawLayer 必须是合法绘制层（ground/air/water…）',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (sectionEnName(sec, zhToEn) !== 'graphics') continue
      for (const kv of keyValuesInSection(sec)) {
        const key = toEnKey(kv.key, zhToEn).toLowerCase()
        if (key !== 'drawlayer') continue
        if (!isEnumValue(kv.value, DRAW_LAYERS)) {
          issues.push(
            issue(
              kv.line,
              `drawLayer 值「${kv.value}」不是合法绘制层`,
              `使用其中之一：${[...DRAW_LAYERS].join(' / ')}`,
              'checkDrawLayerEnum',
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
