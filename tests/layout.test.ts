import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_CONSTRAINTS,
  clampRatio,
  clampWidth,
  fitWorkbench,
  layoutMode,
  pxToRatio,
  ratioToPx,
} from '../src/utils/layout'

describe('clampWidth / clampRatio', () => {
  it('NaN 回退最小值', () => {
    expect(clampWidth(Number.NaN, 180, 520)).toBe(180)
    expect(clampRatio(Number.NaN)).toBe(0.15)
  })
  it('夹紧到边界', () => {
    expect(clampWidth(10, 180, 520)).toBe(180)
    expect(clampWidth(9999, 180, 520)).toBe(520)
    expect(clampWidth(300, 180, 520)).toBe(300)
    expect(clampRatio(0)).toBe(0.15)
    expect(clampRatio(1)).toBe(0.8)
    expect(clampRatio(0.5)).toBe(0.5)
  })
})

describe('fitWorkbench', () => {
  const c = WORKBENCH_CONSTRAINTS

  it('空间充足时保留用户宽度', () => {
    expect(fitWorkbench({ left: 300, right: 400 }, 1600, c)).toEqual({ left: 300, right: 400 })
  })
  it('超出约束时夹紧', () => {
    const r = fitWorkbench({ left: 50, right: 2000 }, 1600, c)
    expect(r.left).toBe(c.minLeft)
    expect(r.right).toBe(c.maxRight)
  })
  it('左右 + 最小编辑器超宽时先压缩右栏再压缩左栏', () => {
    // 容器 1000：可用 = 1000 - 340 - 16(分隔条) = 644；右栏让位到 244，左栏保留 400
    const r = fitWorkbench({ left: 400, right: 500 }, 1000, c)
    expect(r.left + r.right + c.minEditor + 16).toBeLessThanOrEqual(1000)
    expect(r.right).toBe(244)
    expect(r.left).toBe(400)
    // 更窄：右栏到最小后仍超，压缩左栏
    const r2 = fitWorkbench({ left: 400, right: 400 }, 800, c)
    expect(r2.left + r2.right + c.minEditor + 16).toBeLessThanOrEqual(800)
    expect(r2.right).toBe(c.minRight)
    expect(r2.left).toBeGreaterThanOrEqual(c.minLeft)
  })
  it('编辑器宽度不再被挤没（最小 340 保证，扣除分隔条后仍成立）', () => {
    const r = fitWorkbench({ left: 520, right: 760 }, 1000, c)
    expect(1000 - r.left - r.right - 16).toBeGreaterThanOrEqual(c.minEditor)
    // 极窄容器：右栏可低于最小，但编辑器空间仍保住
    const r2 = fitWorkbench({ left: 400, right: 400 }, 500, c)
    expect(500 - r2.left - r2.right - 16).toBeGreaterThanOrEqual(c.minEditor)
  })
  it('折叠状态（0）保持不变', () => {
    expect(fitWorkbench({ left: 0, right: 430 }, 1000, c)).toEqual({ left: 0, right: 430 })
    expect(fitWorkbench({ left: 280, right: 0 }, 1000, c)).toEqual({ left: 280, right: 0 })
    expect(fitWorkbench({ left: 0, right: 0 }, 1000, c)).toEqual({ left: 0, right: 0 })
  })
  it('单侧折叠时编辑器最小宽度仍被保证', () => {
    // 左折叠 + 右栏 640 + 容器 950（medium 档）→ 编辑器 ≥ 340
    const r = fitWorkbench({ left: 0, right: 640 }, 950, c)
    expect(r.left).toBe(0)
    expect(950 - r.right - 8).toBeGreaterThanOrEqual(c.minEditor)
    // 右折叠 + 左栏 520 + 容器 900
    const r2 = fitWorkbench({ left: 520, right: 0 }, 900, c)
    expect(r2.right).toBe(0)
    expect(900 - r2.left - 8).toBeGreaterThanOrEqual(c.minEditor)
  })
  it('容器宽度无效时不崩溃（回退夹紧）', () => {
    const r = fitWorkbench({ left: 300, right: 400 }, Number.NaN, c)
    expect(r.left).toBe(300)
    expect(r.right).toBe(400)
  })
})

describe('pxToRatio / ratioToPx', () => {
  it('像素与比例互转', () => {
    expect(pxToRatio(300, 1000)).toBeCloseTo(0.3)
    expect(ratioToPx(0.3, 1000)).toBe(300)
    expect(ratioToPx(0.9, 1000)).toBe(800) // 超界夹紧
  })
  it('容器高度无效回退', () => {
    expect(pxToRatio(300, 0)).toBe(0.3)
    expect(ratioToPx(0.3, 0)).toBe(0)
  })
})

describe('layoutMode', () => {
  it('按宽度分档', () => {
    expect(layoutMode(1600)).toBe('full')
    expect(layoutMode(1200)).toBe('full')
    expect(layoutMode(1199)).toBe('medium')
    expect(layoutMode(900)).toBe('medium')
    expect(layoutMode(899)).toBe('compact')
    expect(layoutMode(Number.NaN)).toBe('medium')
  })
})
