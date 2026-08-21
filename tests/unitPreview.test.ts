/**
 * 单位合成预览配方（M22，P3 任务 1）测试：
 * - [graphics] 配方解析（官方字段/默认值/中文键回译/等号语法/引号/多帧引用）
 * - 帧切片（frame_width 覆盖 total_frames、非法值防御、多帧整图模式）
 * - 绘制布局（主体居中/阴影偏移/AUTO 剪影/炮塔位置与缩放/残骸）
 * - 图像引用分类与候选路径（本地/ROOT/CUSTOM/CORE/SHARED/NONE/AUTO）
 */
import { describe, expect, it } from 'vitest'
import {
  animationFrameNumber,
  cleanImageValue,
  computeDrawGeometry,
  computeDrawLayout,
  computeFrames,
  computeSightGeometry,
  directionCount,
  directionSourceRect,
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

  it('解析官方 image_offsetX/image_offsetY，并保留 camelCase 兼容', () => {
    const official = parseGraphicsRecipe('[core]\nfogOfWarSightRange: 15\n[graphics]\nimage_offsetX: 7\nimage_offsetY: -3\n')
    expect(official.imageOffsetX).toBe(7)
    expect(official.imageOffsetY).toBe(-3)
    const compatible = parseGraphicsRecipe('[graphics]\nimageOffsetX: 4\nimageOffsetY: 5\n')
    expect(compatible.imageOffsetX).toBe(4)
    expect(compatible.imageOffsetY).toBe(5)
  })

  it('解析视野字段：缺省使用 15，中文键可识别，非法/小数值返回不可绘制', () => {
    expect(parseGraphicsRecipe('[core]\n[graphics]\n').fogOfWarSightRange).toBe(15)
    expect(parseGraphicsRecipe('[core]\nfogOfWarSightRange: 22\n[graphics]\n').fogOfWarSightRange).toBe(22)
    const zhToEn = (key: string) => ({ 视野: 'fogOfWarSightRange', 核心: 'core', 图像组: 'graphics' })[key]
    expect(parseGraphicsRecipe('[核心]\n视野: 18\n[图像组]\n', zhToEn).fogOfWarSightRange).toBe(18)
    // 非法文本
    expect(parseGraphicsRecipe('[core]\nfogOfWarSightRange: dynamic\n[graphics]\n').fogOfWarSightRange).toBeNull()
    // 小数：游戏按整数读取，预览不绘制
    expect(parseGraphicsRecipe('[core]\nfogOfWarSightRange: 15.5\n[graphics]\n').fogOfWarSightRange).toBeNull()
    // 科学计数且结果为整数则允许（如 1.5e2=150）
    expect(parseGraphicsRecipe('[core]\nfogOfWarSightRange: 1.5e2\n[graphics]\n').fogOfWarSightRange).toBe(150)
    // 负数
    expect(parseGraphicsRecipe('[core]\nfogOfWarSightRange: -5\n[graphics]\n').fogOfWarSightRange).toBeNull()
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
    expect(turrets[0]).toMatchObject({ index: 1, id: 'turret_1', sourceOrder: 1, x: 10, y: -20 })
    expect(turrets[1].image).toBe('turret2.png')
    const items = computeDrawLayout(r, turrets)
    const t1 = items.find((i) => i.kind === 'turret' && i.cx === 10)
    expect(t1?.cy).toBe(-20)
    expect(t1?.scale).toBe(1.5)
    expect(t1?.image).toBe('turret.png')
    const t2 = items.find((i) => i.kind === 'turret' && i.cx === -8)
    expect(t2?.image).toBe('turret2.png')
  })

  it('命名与数字炮塔混合解析：数字按数值，命名按源顺序且保留 id', () => {
    const content = '[graphics]\nimage: body.png\nimage_turret: turret.png\n' +
      '[turret_cannon1]\nx: 2\ny: 3\n' +
      '[turret_10]\nx: 10\ny: 0\n' +
      '[turret_2]\nx: 2\ny: 0\n' +
      '[turret_nanoTurret]\nx: -4\ny: 5\n'
    const turrets = parsePreviewTurrets(content)
    expect(turrets.map((t) => t.id)).toEqual(['turret_2', 'turret_10', 'turret_cannon1', 'turret_nanoturret'])
    expect(turrets.find((t) => t.id === 'turret_cannon1')).toMatchObject({ index: -1, name: 'cannon1', x: 2, y: 3 })
  })

  it('中文/连字符等合法命名炮塔不被过滤', () => {
    const content = '[graphics]\nimage: body.png\nimage_turret: turret.png\n' +
      '[turret_小激光炮]\nx: 5\ny: -3\n' +
      '[turret_3-2]\nx: -5\ny: 3\n' +
      '[turret_main_turret]\nx: 0\ny: 0\n'
    const turrets = parsePreviewTurrets(content)
    expect(turrets.length).toBe(3)
    expect(turrets.map((t) => t.id)).toEqual(['turret_小激光炮', 'turret_3-2', 'turret_main_turret'])
    expect(turrets.find((t) => t.id === 'turret_小激光炮')).toMatchObject({ x: 5, y: -3 })
    expect(turrets.find((t) => t.id === 'turret_3-2')).toMatchObject({ x: -5, y: 3 })
  })

  it('残骸按配方输出（调用方决定是否展示）', () => {
    const r = parseGraphicsRecipe('[graphics]\nimage: a.png\nimage_wreak: dead.png\n')
    const items = computeDrawLayout(r, [])
    const wreck = items.find((i) => i.kind === 'wreck')
    expect(wreck?.image).toBe('dead.png')
    expect(wreck?.cx).toBe(0)
  })
})

describe('DrawGeometry 与视野几何', () => {
  it('炮塔使用自身整图源矩形，不复用主体多帧尺寸', () => {
    const recipe = parseGraphicsRecipe('[graphics]\nimage: body.png\ntotal_frames: 3\nimage_turret: turret.png\n')
    const body = computeDrawLayout(recipe, [parsePreviewTurrets('[turret_1]\nx: 5\ny: -2\n')[0]])
    const turret = body.find((item) => item.kind === 'turret')!
    const geometry = computeDrawGeometry(turret, 64, 48, { count: 3, frameW: 64, frameH: 48 }, 2, 2)
    expect(geometry.source).toEqual({ sx: 0, sy: 0, sw: 64, sh: 48 })
    const bodyGeometry = computeDrawGeometry({ ...turret, kind: 'body', sourceMode: 'bodyFrames', cx: 0, cy: 0 }, 192, 64, { count: 3, frameW: 64, frameH: 64 }, 2, 2)
    expect(bodyGeometry.source).toEqual({ sx: 128, sy: 0, sw: 64, sh: 64 })
  })

  it('炮塔目标尺寸按自身自然尺寸、turretImageScale 和 zoom', () => {
    const recipe = parseGraphicsRecipe('[graphics]\nimage: body.png\nimage_turret: turret.png\nturretImageScale: 1.5\n')
    const turret = computeDrawLayout(recipe, [{ index: 1, id: 'turret_1', sourceOrder: 0, x: 10, y: -20 }]).find((item) => item.kind === 'turret')!
    const geometry = computeDrawGeometry(turret, 32, 48, { count: 1, frameW: 32, frameH: 48 }, 0, 2)
    expect(geometry.destination.dw).toBe(96)
    expect(geometry.destination.dh).toBe(144)
    expect(geometry.destination.dx).toBe(-28)
    expect(geometry.destination.dy).toBe(-112)
  })

  it('视野半径按地块 × 20 × 预览缩放，圆心始终在 Canvas 单位原点（不随精灵偏移）', () => {
    const recipe = parseGraphicsRecipe('[core]\nfogOfWarSightRange: 15\n[graphics]\nimageScale: .5\nimage_offsetX: 4\nimage_offsetY: -2\n')
    const sight = computeSightGeometry(recipe, 560, 420, 1)!
    expect(sight.radius).toBe(600)
    expect(sight.cx).toBe(280)
    expect(sight.cy).toBe(210)
    expect(sight.tileCount).toBe(15)
  })

  it('视野非法值不绘制，超大值安全钳制且不产生 NaN', () => {
    const invalid = parseGraphicsRecipe('[core]\nfogOfWarSightRange: self.foo()\n[graphics]\n')
    expect(computeSightGeometry(invalid, 560, 420, 1)).toBeNull()
    const huge = parseGraphicsRecipe('[core]\nfogOfWarSightRange: 999999\n[graphics]\n')
    const sight = computeSightGeometry(huge, 560, 420, 1)!
    expect(Number.isFinite(sight.radius)).toBe(true)
    expect(sight.clipped).toBe(true)
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

// ===== M34：队伍着色 / 动画配置 / 播放帧计算 / 多向布局 / 阴影顺序 =====

describe('M34 parseGraphicsRecipe：队伍着色与动画配置', () => {
  it('解析 teamColoringMode（大小写不敏感，非法值回落 disabled）', () => {
    expect(parseGraphicsRecipe('[graphics]\nteamColoringMode: pureGreen\n').teamColoringMode).toBe('pureGreen')
    expect(parseGraphicsRecipe('[graphics]\nteamColoringMode: HueAdd\n').teamColoringMode).toBe('hueAdd')
    expect(parseGraphicsRecipe('[graphics]\nteamColoringMode: hueShift\n').teamColoringMode).toBe('hueShift')
    expect(parseGraphicsRecipe('[graphics]\nteamColoringMode: rainbow\n').teamColoringMode).toBe('disabled')
    expect(parseGraphicsRecipe('[graphics]\nimage: a.png\n').teamColoringMode).toBe('disabled')
  })

  it('解析三态动画字段（idle/moving/attack 的 start/end/speed/pingPong/blendIn）', () => {
    const r = parseGraphicsRecipe(
      '[graphics]\n' +
        'animation_idle_start: 0\nanimation_idle_end: 3\nanimation_idle_speed: 2\nanimation_idle_pingPong: true\n' +
        'animation_moving_start: 4\nanimation_moving_end: 7\nanimation_attack_speed: 0\n',
    )
    expect(r.animations.idle).toEqual({ start: 0, end: 3, speed: 2, pingPong: true })
    expect(r.animations.moving.start).toBe(4)
    expect(r.animations.moving.end).toBe(7)
    expect(r.animations.attack.speed).toBe(1) // speed 0/非法 → 1
    expect(r.animations.attack.pingPong).toBe(false)
  })

  it('解析多向动画配置（animation_direction_*）', () => {
    const r = parseGraphicsRecipe(
      '[graphics]\nanimation_direction_units: 45\nanimation_direction_strideX: 20\nanimation_direction_strideY: 50\nanimation_direction_starting: 90\n',
    )
    expect(r.direction).toEqual({ units: 45, strideX: 20, strideY: 50, starting: 90 })
    expect(parseGraphicsRecipe('[graphics]\nimage: a.png\n').direction).toBeUndefined()
  })
})

describe('M34 animationFrameNumber（播放帧计算）', () => {
  it('无配置：整序列按 1 帧/秒循环', () => {
    expect(animationFrameNumber(undefined, 0, 4)).toBe(0)
    expect(animationFrameNumber(undefined, 1000, 4)).toBe(1)
    expect(animationFrameNumber(undefined, 3999, 4)).toBe(3)
    expect(animationFrameNumber(undefined, 4000, 4)).toBe(0)
  })

  it('start..end 区间循环（speed 帧/秒）', () => {
    const anim = { start: 2, end: 5, speed: 2, pingPong: false }
    expect(animationFrameNumber(anim, 0, 8)).toBe(2)
    expect(animationFrameNumber(anim, 500, 8)).toBe(3)
    expect(animationFrameNumber(anim, 1000, 8)).toBe(4)
    expect(animationFrameNumber(anim, 1500, 8)).toBe(5)
    expect(animationFrameNumber(anim, 2000, 8)).toBe(2)
  })

  it('pingPong：到 end 反向播回 start', () => {
    const anim = { start: 0, end: 3, speed: 1, pingPong: true }
    expect(animationFrameNumber(anim, 0, 8)).toBe(0)
    expect(animationFrameNumber(anim, 3000, 8)).toBe(3)
    expect(animationFrameNumber(anim, 4000, 8)).toBe(2)
    expect(animationFrameNumber(anim, 6000, 8)).toBe(0)
    expect(animationFrameNumber(anim, 7000, 8)).toBe(1)
  })

  it('单帧防御恒 0；区间越界钳制到帧数内', () => {
    expect(animationFrameNumber(undefined, 5000, 1)).toBe(0)
    expect(animationFrameNumber({ start: 0, end: 99, speed: 1, pingPong: false }, 1000, 4)).toBe(1)
  })
})

describe('M34 多向动画布局', () => {
  it('directionCount：360/units（45 → 8 方向）；非法配置为 1', () => {
    const dir = { units: 45, strideX: 20, strideY: 50, starting: 0 }
    expect(directionCount(dir)).toBe(8)
    expect(directionCount({ ...dir, units: 90 })).toBe(4)
    expect(directionCount(undefined)).toBe(1)
    expect(directionCount({ ...dir, units: 0 })).toBe(1)
  })

  it('方向块源矩形：横排 strideX×strideY，越界钳制', () => {
    const dir = { units: 45, strideX: 20, strideY: 50, starting: 0 }
    expect(directionSourceRect(dir, 0, 200, 100)).toEqual({ sx: 0, sy: 0, sw: 20, sh: 50 })
    expect(directionSourceRect(dir, 3, 200, 100).sx).toBe(60)
    const clipped = directionSourceRect(dir, 5, 120, 100)
    expect(clipped.sx).toBe(100)
    expect(clipped.sw).toBe(20)
  })
})

describe('M34 computeDrawLayout：阴影绘制顺序', () => {
  it('阴影项排在最前（投影在主体底层，不再盖压主体）', () => {
    const recipe = parseGraphicsRecipe('[graphics]\nimage: body.png\nimage_shadow: AUTO\nshadowOffsetX: 0\nshadowOffsetY: 8\n')
    const items = computeDrawLayout(recipe, [])
    expect(items.map((i) => i.kind)).toEqual(['shadow', 'body'])
  })

  it('无阴影主体在最前；NONE 阴影不产出绘制项', () => {
    expect(computeDrawLayout(parseGraphicsRecipe('[graphics]\nimage: body.png\n'), []).map((i) => i.kind)).toEqual(['body'])
    expect(computeDrawLayout(parseGraphicsRecipe('[graphics]\nimage: body.png\nimage_shadow: NONE\n'), []).map((i) => i.kind)).toEqual(['body'])
  })
})
