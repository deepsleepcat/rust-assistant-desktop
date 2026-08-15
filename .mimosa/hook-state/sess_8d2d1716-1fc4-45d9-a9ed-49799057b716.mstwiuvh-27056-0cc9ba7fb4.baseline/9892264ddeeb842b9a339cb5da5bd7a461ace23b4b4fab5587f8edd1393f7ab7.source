/**
 * 事件时序语义（checkEventTimingSemantics）：
 * 动画节（[animation_xxx] / [effect_xxx] 等）里的时间键（body_0s、arm1_0.8s、
 * leg3_1.5s 等官方格式）：
 * 1) 时间必须能解析为非负数字（body_-1s 解析为负 → 报错）；
 * 2) 节内时间应单调不减（乱序的动画时间会让动画跳帧/回退）。
 *
 * 官方动画键格式：body_0s: {frame:0}、body_0.8s: {frame:3}、arm1_0.5s（秒）。
 * 前缀不限于 body_：官方还有 armN_/legN_/effect_ 等带数字后缀的动画键，
 * 统一按「字母前缀(可带数字)_时间s」匹配。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, getIni, keyValuesInSection, sectionEnName } from './helpers'

/** 动画时间键：前缀（字母/数字/下划线）+ 时间（可负、可小数）+ s；如 body_0.8s / leg3_1s / arm1_0s */
const ANIM_TIME_KEY_RE = /^[a-z][a-z0-9]*_(?:-?\d+(?:\.\d+)?)s$/i

export const checkEventTimingSemantics: SemanticChecker = {
  id: 'checkEventTimingSemantics',
  title: '事件时序语义',
  description: '动画节时间键（body_Ns / armN_Ns 等）必须为非负数且节内单调递增',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (!sectionEnName(sec, zhToEn).startsWith('animation')) continue
      // 官方动画键交错排列（leg1_0.5s、leg2_0.5s、leg1_3s…），
      // 每个前缀（leg1/leg2/body…）是独立时间轴，单调性按前缀分组跟踪
      const lastByPrefix = new Map<string, number>()
      for (const kv of keyValuesInSection(sec)) {
        const m = ANIM_TIME_KEY_RE.exec(kv.key)
        if (!m) continue
        // 前缀 = 键去掉「_时间s」部分（如 leg1_0.5s → leg1）
        const timeText = kv.key.slice(0, -1).replace(/^[a-z][a-z0-9]*_/i, '')
        const prefix = kv.key.slice(0, -(timeText.length + 2))
        const t = Number(timeText)
        if (!Number.isFinite(t) || t < 0) {
          issues.push(
            issue(kv.line, `动画时间键「${kv.key}」不是有效的非负时间`, `用 秒 为单位（如 body_0.5s: {frame:1}）`, 'checkEventTimingSemantics', 'error', kv.key),
          )
          continue
        }
        const lastTime = lastByPrefix.get(prefix) ?? -Infinity
        if (t < lastTime) {
          issues.push(
            issue(
              kv.line,
              `动画时间 ${t}s 小于该轴上一关键帧 ${lastTime}s（${prefix}），动画会跳帧`,
              `按时间顺序排列关键帧（如 0s → 0.5s → 1s）`,
              'checkEventTimingSemantics',
              'warning',
              kv.key,
            ),
          )
        }
        lastByPrefix.set(prefix, t)
      }
    }
    return issues
  },
}
