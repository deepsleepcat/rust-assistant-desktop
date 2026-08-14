/**
 * 事件时序语义（checkEventTimingSemantics）：
 * 动画节（[animation_xxx]）里的时间键（body_0s / body_0.5s 等）：
 * 1) 时间必须能解析为非负数字（body_-1s 会解析失败）；
 * 2) 节内时间应单调不减（乱序的动画时间会让动画跳帧/回退）。
 *
 * 官方动画键格式：body_0s: {frame:0}、body_0.8s: {frame:3}（秒）。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, parseIni, sectionEnName } from './helpers'

const ANIM_TIME_KEY_RE = /^body_([0-9.]+)s$/i

export const checkEventTimingSemantics: SemanticChecker = {
  id: 'checkEventTimingSemantics',
  title: '事件时序语义',
  description: '动画节时间键（body_Ns）必须为非负数且节内单调递增',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections, keyValues } = parseIni(content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      if (!sectionEnName(sec, zhToEn).startsWith('animation')) continue
      let lastTime = -Infinity
      for (const kv of keyValues) {
        if (kv.line < sec.startLine || kv.line >= sec.endLine) continue
        const m = ANIM_TIME_KEY_RE.exec(kv.key)
        if (!m) continue
        const t = Number(m[1])
        if (!Number.isFinite(t) || t < 0) {
          issues.push(
            issue(kv.line, `动画时间键「${kv.key}」不是有效的非负时间`, `用 秒 为单位（如 body_0.5s: {frame:1}）`, 'checkEventTimingSemantics', 'error', kv.key),
          )
          continue
        }
        if (t < lastTime) {
          issues.push(
            issue(
              kv.line,
              `动画时间 ${t}s 小于上一关键帧 ${lastTime}s，动画会跳帧`,
              `按时间顺序排列关键帧（如 0s → 0.5s → 1s）`,
              'checkEventTimingSemantics',
              'warning',
              kv.key,
            ),
          )
        }
        lastTime = t
      }
    }
    return issues
  },
}
