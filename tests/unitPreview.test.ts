/**
 * 单位合成预览配方（M22，P3 任务 1）测试：
 * - [graphics] 配方解析（官方字段/默认值/中文键回译/等号语法/引号/多帧引用）
 * - 帧切片（frame_width 覆盖 total_frames、非法值防御、多帧整图模式）
 * - 绘制布局（主体居中/阴影偏移/AUTO 剪影/炮塔位置与缩放/残骸）
 * - 图像引用分类与候选路径（本地/ROOT/CUSTOM/CORE/SHARED/NONE/AUTO）
 */
import { describe, expect, it } from 'vitest'
import {
  cleanImageValue,
  computeDrawLayout,
  computeFrames,
  framePath,
  isGameImageRef,
  isLoadableImageRef,
  isLocalImageRef,
  parseGraphicsRecipe,
  parseImageRef,
  parseImageRefs,
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

  it('isLocalImageRef：CORE: 也是游戏内置引用（非本地）', () => {
    expect(isLocalImageRef('CORE:units/x.png')).toBe(false)
    expect(isGameImageRef('CORE:units/x.png')).toBe(true)
  })

  it('炮塔 image 为 NONE（官方 image_turret: NONE）不产出绘制项', () => {
    const content = '[graphics]\nimage: a.png\nimage_turret: NONE\n[turret_1]\nx: 1\ny: 2\n'
    const r = parseGraphicsRecipe(content)
    const turrets = parsePreviewTurrets(content)
    const items = computeDrawLayout(r, turrets)
    expect(items.some((i) => i.kind === 'turret')).toBe(false)
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

describe('图像引用解析（命名空间/清洗/多帧）', () => {
  it('cleanImageValue：剥行内注释与外层引号', () => {
    expect(cleanImageValue('"real.png"')).toBe('real.png')
    expect(cleanImageValue("'a.png' # 注释")).toBe('a.png')
    expect(cleanImageValue('  a.png  ')).toBe('a.png')
  })

  it('framePath：剥帧延迟后缀', () => {
    expect(framePath('frame.png:0.1')).toBe('frame.png')
    expect(framePath('a.png')).toBe('a.png')
  })

  it('parseImageRef：无前缀 = local；ROOT/CUSTOM/CORE/SHARED 分类', () => {
    expect(parseImageRef('a.png')).toEqual({ namespace: 'local', rel: 'a.png', raw: 'a.png' })
    expect(parseImageRef('ROOT:/tanks/tank.png')?.namespace).toBe('root')
    expect(parseImageRef('ROOT:/tanks/tank.png')?.rel).toBe('tanks/tank.png')
    expect(parseImageRef('CUSTOM:y.png')?.namespace).toBe('custom')
    expect(parseImageRef('CORE:tanks/tank.png')?.namespace).toBe('core')
    expect(parseImageRef('SHARED:beam3.png')?.namespace).toBe('shared')
  })

  it('parseImageRef：NONE/AUTO/AUTO_ANIMATED/空 → null', () => {
    expect(parseImageRef('NONE')).toBeNull()
    expect(parseImageRef('AUTO')).toBeNull()
    expect(parseImageRef('AUTO_ANIMATED')).toBeNull()
    expect(parseImageRef('')).toBeNull()
    expect(parseImageRef(undefined)).toBeNull()
    expect(parseImageRef('"NONE"')).toBeNull() // 引号包着的关键字同样是关键字
  })

  it('parseImageRef：大小写不敏感（core:/root:）', () => {
    expect(parseImageRef('core:tanks/tank.png')?.namespace).toBe('core')
    expect(parseImageRef('root:x.png')?.namespace).toBe('root')
  })

  it('parseImageRefs：多帧拆分 + 帧延迟后缀 + 非法帧跳过', () => {
    const refs = parseImageRefs('a.png;b.png:0.1;c.png')
    // raw 保留原文（含延迟后缀，供取图层重新解析）；rel 已剥延迟
    expect(refs.map((r) => r.raw)).toEqual(['a.png', 'b.png:0.1', 'c.png'])
    expect(refs.map((r) => r.rel)).toEqual(['a.png', 'b.png', 'c.png'])
    // 模板/随机语法（* / ${）与空帧跳过
    expect(parseImageRefs('a.png;*;${x};')).toEqual([{ namespace: 'local', rel: 'a.png', raw: 'a.png' }])
    expect(parseImageRefs('NONE')).toEqual([])
  })

  it('parseImageRefs：命名空间前缀 + 帧延迟后缀（ROOT:units/a.png:0.1）顺序正确', () => {
    const refs = parseImageRefs('ROOT:units/a.png:0.1;ROOT:units/b.png')
    expect(refs.map((r) => r.namespace)).toEqual(['root', 'root'])
    expect(refs.map((r) => r.rel)).toEqual(['units/a.png', 'units/b.png'])
    // 纯 CORE 多帧
    const core = parseImageRefs('CORE:tanks/tank.png;SHARED:beam3.png:0.2')
    expect(core.map((r) => r.namespace)).toEqual(['core', 'shared'])
    expect(core.map((r) => r.rel)).toEqual(['tanks/tank.png', 'beam3.png'])
  })

  it('isLoadableImageRef：NONE/AUTO/空 false，前缀引用 true', () => {
    expect(isLoadableImageRef('a.png')).toBe(true)
    expect(isLoadableImageRef('CORE:tanks/tank.png')).toBe(true)
    expect(isLoadableImageRef('NONE')).toBe(false)
    expect(isLoadableImageRef('AUTO')).toBe(false)
    expect(isLoadableImageRef('')).toBe(false)
  })

  it('resolveImageCandidates：绝对单位文件 + rootPath → 项目内绝对路径（不再重复拼接）', () => {
    expect(resolveImageCandidates('C:/mod/units/tank/tank.ini', 'tank.png', 'C:/mod')).toEqual([
      'C:/mod/units/tank/tank.png',
      'C:/mod/tank.png',
    ])
    expect(resolveImageCandidates('C:\\mod\\units\\tank\\tank.ini', 'tank.png', 'C:/mod')).toEqual([
      'C:/mod/units/tank/tank.png',
      'C:/mod/tank.png',
    ])
  })

  it('resolveImageCandidates：相对单位文件 + rootPath 同样绝对化', () => {
    expect(resolveImageCandidates('units/tank/tank.ini', 'tank.png', 'C:/mod')).toEqual([
      'C:/mod/units/tank/tank.png',
      'C:/mod/tank.png',
    ])
    // 图像引用本身是盘符绝对路径：单候选原样
    expect(resolveImageCandidates('units/a.ini', 'C:/x/y.png', 'C:/mod')).toEqual(['C:/x/y.png'])
  })
})

describe('配方解析（等号/引号/多帧）', () => {
  it('= 分隔符与引号值（真实模组写法）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage = "tank.png"\nimageScale = 2\n')
    expect(r.image).toBe('tank.png')
    expect(r.imageScale).toBe(2)
  })

  it('多帧引用：首帧为主体 image，完整序列进 imageFrames（raw 保留延迟后缀）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png;b.png:0.1;c.png\n')
    expect(r.image).toBe('a.png')
    expect(r.imageFrames).toEqual(['a.png', 'b.png:0.1', 'c.png'])
  })

  it('computeFrames：多帧引用按文件数计帧、整图绘制（multiFile）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png;b.png;c.png\ntotal_frames: 99\n')
    const f = computeFrames(64, 32, r)
    expect(f.count).toBe(3)
    expect(f.frameW).toBe(64)
    expect(f.frameH).toBe(32)
    expect(f.multiFile).toBe(true)
  })

  it('中文键 + 等号：中文回译同样生效', () => {
    const zhToEn = (s: string) => ({ 图像: 'image', 总帧数: 'total_frames', 图像组: 'graphics' })[s]
    const r = parseGraphicsRecipe('[图像组]\n图像 = a.png\n总帧数 = 2\n', zhToEn)
    expect(r.image).toBe('a.png')
    expect(r.totalFrames).toBe(2)
  })

  it('残骸/炮塔支持 CORE: 前缀引用（不再是「只认本地」）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\nimage_wreak: CORE:tanks/tank_dead.png\nimage_turret: SHARED:beam3.png\n[turret_1]\nx: 1\ny: 2\n')
    const turrets = parsePreviewTurrets('[graphics]\nimage: a.png\nimage_turret: SHARED:beam3.png\n[turret_1]\nx: 1\ny: 2\n')
    const items = computeDrawLayout(r, turrets)
    const wreck = items.find((i) => i.kind === 'wreck')
    expect(wreck?.image).toBe('CORE:tanks/tank_dead.png')
    const turret = items.find((i) => i.kind === 'turret')
    expect(turret?.image).toBe('SHARED:beam3.png')
  })
})
