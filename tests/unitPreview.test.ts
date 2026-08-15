/**
 * 单位合成预览配方（M22，P3 任务 1）测试：
 * - [graphics] 配方解析（官方字段/默认值/中文键回译）
 * - 帧切片（frame_width 覆盖 total_frames、非法值防御）
 * - 绘制布局（主体居中/阴影偏移/AUTO 剪影/炮塔位置与缩放/残骸）
 * - 图像引用分类与候选路径（本地/游戏内置/NONE/AUTO）
 */
import { describe, expect, it } from 'vitest'
import {
  computeDrawLayout,
  computeFrames,
  isGameImageRef,
  isLocalImageRef,
  parseGraphicsRecipe,
  parsePreviewTurrets,
  resolveImageCandidates,
} from '../src/features/editor/unitPreview/recipe'

const OFFICIAL_LIKE = `[core]
name: aaBeamGunship
[graphics]
total_frames: 3
image: base3.png
image_wreak: base3_dead.png
image_turret: NONE
image_shadow: AUTO
shadowOffsetX: 1
shadowOffsetY: 1
imageScale: 0.5
`

describe('parseGraphicsRecipe', () => {
  it('解析官方风格配方（默认值兜底）', () => {
    const r = parseGraphicsRecipe(OFFICIAL_LIKE)
    expect(r.image).toBe('base3.png')
    expect(r.totalFrames).toBe(3)
    expect(r.imageScale).toBe(0.5)
    expect(r.imageWreak).toBe('base3_dead.png')
    expect(r.imageShadow).toBe('AUTO')
    expect(r.shadowOffsetX).toBe(1)
    expect(r.shadowOffsetY).toBe(1)
    expect(r.turretImageScale).toBe(1) // 默认
    expect(r.imageOffsetX).toBe(0)
  })

  it('无 [graphics] 节返回全默认（不抛错）', () => {
    const r = parseGraphicsRecipe('[core]\nname: x\n')
    expect(r.image).toBeUndefined()
    expect(r.imageScale).toBe(1)
    expect(r.totalFrames).toBe(1)
  })

  it('中文键回译（图像/总帧数/图像缩放）', () => {
    const zhToEn = (s: string) => ({ 图像: 'image', 总帧数: 'total_frames', 图像缩放: 'imageScale', 图像组: 'graphics' })[s]
    const r = parseGraphicsRecipe('[图像组]\n图像: a.png\n总帧数: 4\n图像缩放: 2\n', zhToEn)
    expect(r.image).toBe('a.png')
    expect(r.totalFrames).toBe(4)
    expect(r.imageScale).toBe(2)
  })

  it('frame_width 覆盖 total_frames', () => {
    const r = parseGraphicsRecipe('[graphics]\ntotal_frames: 3\nframe_width: 64\nimage: a.png\n')
    expect(r.frameWidth).toBe(64)
  })

  it('非数字值不污染配方（NaN 防御）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimageScale: 快\nshadowOffsetX: xxx\n')
    expect(r.imageScale).toBe(1)
    expect(r.shadowOffsetX).toBe(0)
  })
})

describe('computeFrames（帧切片）', () => {
  const base = parseGraphicsRecipe('[graphics]\nimage: a.png\n')

  it('默认按 total_frames 横向切片', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\ntotal_frames: 4\n')
    const f = computeFrames(256, 32, r)
    expect(f.count).toBe(4)
    expect(f.frameW).toBe(64)
    expect(f.frameH).toBe(32)
  })

  it('frame_width 优先且自动算帧数', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\ntotal_frames: 99\nframe_width: 32\n')
    const f = computeFrames(96, 48, r)
    expect(f.count).toBe(3)
    expect(f.frameW).toBe(32)
    expect(f.frameH).toBe(48)
  })

  it('非法帧数/尺寸防御为单帧', () => {
    expect(computeFrames(0, 0, base).count).toBe(1)
    const bad = parseGraphicsRecipe('[graphics]\ntotal_frames: -5\n')
    const f = computeFrames(100, 50, bad)
    expect(f.count).toBe(1)
    expect(f.frameW).toBe(100)
  })
})

describe('computeDrawLayout（合成布局）', () => {
  it('主体居中 + 缩放 + 偏移', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\nimageScale: 2\nimageOffsetX: 5\n')
    const items = computeDrawLayout(r, [])
    const body = items.find((i) => i.kind === 'body')
    expect(body?.cx).toBe(10) // offset 5 × scale 2
    expect(body?.scale).toBe(2)
    expect(body?.image).toBe('a.png')
  })

  it('阴影：AUTO 复用主图 + 半透明 + 偏移；NONE 不画', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\nimage_shadow: AUTO\nshadowOffsetX: 2\nshadowOffsetY: 3\n')
    const items = computeDrawLayout(r, [])
    const shadow = items.find((i) => i.kind === 'shadow')
    expect(shadow?.image).toBe('a.png')
    expect(shadow?.alpha).toBe(0.5)
    expect(shadow?.cx).toBe(2)
    expect(shadow?.cy).toBe(3)

    const none = computeDrawLayout(parseGraphicsRecipe('[graphics]\nimage_shadow: NONE\n'), [])
    expect(none.some((i) => i.kind === 'shadow')).toBe(false)
  })

  it('炮塔叠加：位置不缩放、精灵按 turretImageScale，节内 image 覆盖', () => {
    const content = `[graphics]\nimage: a.png\nimage_turret: turret.png\nturretImageScale: 1.5\n[turret_1]\nx: 10\ny: -20\n[turret_2]\nx: -8\ny: 6\nimage: turret2.png\n`
    const r = parseGraphicsRecipe(content)
    const turrets = parsePreviewTurrets(content)
    expect(turrets.length).toBe(2)
    expect(turrets[0]).toEqual({ index: 1, x: 10, y: -20, image: undefined })
    expect(turrets[1].image).toBe('turret2.png')
    const items = computeDrawLayout(r, turrets)
    const t1 = items.find((i) => i.kind === 'turret' && i.cx === 10)
    expect(t1?.cy).toBe(-20)
    expect(t1?.scale).toBe(1.5)
    expect(t1?.image).toBe('turret.png')
    const t2 = items.find((i) => i.kind === 'turret' && i.cx === -8)
    expect(t2?.image).toBe('turret2.png')
  })

  it('残骸按配方输出（调用方决定是否展示）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\nimage_wreak: dead.png\n')
    const items = computeDrawLayout(r, [])
    const wreck = items.find((i) => i.kind === 'wreck')
    expect(wreck?.image).toBe('dead.png')
    expect(wreck?.cx).toBe(0)
  })
})

describe('图像引用分类与候选路径', () => {
  it('isLocalImageRef：NONE/AUTO/空/跨模组前缀不是本地', () => {
    expect(isLocalImageRef('a.png')).toBe(true)
    expect(isLocalImageRef('NONE')).toBe(false)
    expect(isLocalImageRef('AUTO')).toBe(false)
    expect(isLocalImageRef('')).toBe(false)
    expect(isLocalImageRef(undefined)).toBe(false)
    expect(isLocalImageRef('ROOT:units/x.png')).toBe(false)
    expect(isLocalImageRef('CUSTOM:y.png')).toBe(false)
  })

  it('isGameImageRef：CORE:/ROOT:/CUSTOM:/SHARED: 前缀', () => {
    expect(isGameImageRef('CORE:units/x.png')).toBe(true)
    expect(isGameImageRef('ROOT:units/x.png')).toBe(true)
    expect(isGameImageRef('SHARED:y.png')).toBe(true)
    expect(isGameImageRef('a.png')).toBe(false)
  })

  it('resolveImageCandidates：单位目录优先，再项目根；根级文件只有单候选', () => {
    expect(resolveImageCandidates('units/tank/tank.ini', 'base3.png')).toEqual(['units/tank/base3.png', 'base3.png'])
    expect(resolveImageCandidates('tank.ini', 'img.png')).toEqual(['img.png'])
    expect(resolveImageCandidates('units/tank/tank.ini', '/abs.png')).toEqual(['units/tank/abs.png', 'abs.png'])
  })
})
