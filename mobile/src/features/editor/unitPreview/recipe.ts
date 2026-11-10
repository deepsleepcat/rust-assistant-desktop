/**
 * 单位合成预览配方（从桌面端 src/features/editor/unitPreview/recipe.ts 移植）——
 * 纯解析与布局计算（无 DOM，可测试）：
 * 读取单位文件 [graphics] 配方，计算「主体帧切片 + 阴影 + 炮塔叠加 + 残骸」
 * 的绘制布局，供 Canvas 渲染层使用（渲染层只负责画，逻辑全在这里）。
 *
 * 官方语义（code.json）：
 * - total_frames：把图像横向切成 N 帧（第一帧编号 0），默认 1；
 * - frame_width：显式单帧宽度，自动覆盖总帧数；
 * - imageScale：整体缩放（也影响阴影/腿部），默认 1；
 * - image_turret：炮塔默认图像（[turret_N] 节内可覆盖），turretImageScale 缩放；
 * - image_shadow：NONE / AUTO（自动生成黑色剪影）/ 图像文件；shadowOffsetX/Y 偏移；
 * - image_wreak：死亡残骸图像（预览里可选叠加）。
 *
 * 图像引用命名空间（与运行前检查/官方文档一致）：
 * - 无前缀：项目内文件（单位文件同目录优先，项目根兜底）
 * - ROOT:：模组包根目录（项目根）
 * - CUSTOM:：项目内引用（同 ROOT 解析；真实模组常见 CUSTOM:xxx.png）
 * - CORE:：游戏内置资产（assets/units/ 下，需配置游戏路径）
 * - SHARED:：游戏共享图库（assets/units/shared/ 下，需配置游戏路径）
 * - NONE / AUTO：引擎关键字，不是文件
 */
import { parseIni, sectionEnName, toEnKey, toNumber } from '../semanticChecks/helpers'
import { joinProjectPath } from '../../../utils/projectPath'

export interface GraphicsRecipe {
  /** 主体图像（相对单位文件目录或项目根；NONE/AUTO 无）。多帧引用时为首帧 */
  image?: string
  /** 多帧引用（a.png;b.png 动画序列；无多帧时为空） */
  imageFrames?: string[]
  imageScale: number
  imageOffsetX: number
  imageOffsetY: number
  /** 帧总数（frame_width 提供时被覆盖） */
  totalFrames: number
  /** 显式单帧宽度（可选） */
  frameWidth?: number
  /** 炮塔默认图像 */
  imageTurret?: string
  turretImageScale: number
  /** 死亡残骸图像 */
  imageWreak?: string
  /** 阴影：NONE / AUTO / 图像文件 */
  imageShadow?: string
  shadowOffsetX: number
  shadowOffsetY: number
  /** 队伍着色模式（M34：teamColoringMode；官方 pureGreen/hueAdd/hueShift/disabled） */
  teamColoringMode: TeamColoringMode
  /** 三态动画配置（animation_idle_* / animation_moving_* / animation_attack_*） */
  animations: { idle: AnimationStateConfig; moving: AnimationStateConfig; attack: AnimationStateConfig }
  /** 多向动画（animation_direction_*；无配置时不启用） */
  direction?: DirectionConfig
  /** 战争迷雾视野地块数；缺省 15，动态/非法值为 null（不绘制） */
  fogOfWarSightRange: number | null
}

/** 队伍着色模式（官方 teamColoringMode：pureGreen=纯绿、hueAdd=色相叠加、hueShift=色相偏移） */
export type TeamColoringMode = 'pureGreen' | 'hueAdd' | 'hueShift' | 'disabled'

/** 动画状态配置（graphics 节 animation_状态_* 字段；缺省时按整帧序列循环） */
export interface AnimationStateConfig {
  /** 起始帧（缺省 0） */
  start?: number
  /** 结束帧（缺省最后一帧） */
  end?: number
  /** 播放速度（帧/秒，缺省 1） */
  speed: number
  /** 往返播放（到结束帧反向播回） */
  pingPong: boolean
  /** 淡入帧数（1.13+；预览暂不模拟，仅解析） */
  blendIn?: number
}

/** 多向动画配置 */
export interface DirectionConfig {
  /** 每方向角度（45=8 方向；0/缺省=未启用） */
  units: number
  /** 方向块 X 跨度（像素） */
  strideX: number
  /** 方向块 Y 跨度（像素） */
  strideY: number
  /** 起始方向角度（缺省 0） */
  starting: number
}

/** 炮塔信息（位置/图像覆盖），来自 [turret_N]/[turret_NAME] 节 */
export interface PreviewTurret {
  /** 数字节的数值后缀；命名节为 -1，避免 NaN 参与排序 */
  index: number
  /** 稳定诊断/未来 copyFrom 与 anchor 支持用的节标识 */
  id: string
  /** 命名节的名称（数字节为空） */
  name?: string
  /** 原文出现顺序，仅用于命名节稳定排序 */
  sourceOrder: number
  x: number
  y: number
  /** 节内 image 覆盖（可选） */
  image?: string
}

/** 帧切片结果（multiFile=true 表示 a.png;b.png 动画序列：每帧一张整图，不做横向切片） */
export interface FrameInfo {
  count: number
  frameW: number
  frameH: number
  multiFile?: boolean
}

/** 绘制项（canvas 坐标：单位中心为原点，y 向下） */
export interface DrawItem {
  kind: 'body' | 'shadow' | 'turret' | 'wreck'
  /** 图像引用（原始配方值；NONE/AUTO 时无） */
  image?: string
  /** 绘制中心点（相对单位中心，已含缩放） */
  cx: number
  cy: number
  /** 精灵缩放 */
  scale: number
  /** 透明度（阴影 AUTO 用） */
  alpha: number
  /** 源矩形策略：主体/自动阴影切帧，其余默认按各自整图绘制 */
  sourceMode?: 'bodyFrames' | 'full'
  /** 缺图时显示占位 */
  placeholder: string
}

export interface DrawGeometry {
  source: { sx: number; sy: number; sw: number; sh: number }
  destination: { dx: number; dy: number; dw: number; dh: number }
}

export interface SightGeometry {
  cx: number
  cy: number
  /** 已按画布上限钳制的半径（Canvas 像素） */
  radius: number
  /** 原始半径是否超出安全绘制上限/画布可视范围 */
  clipped: boolean
  tileCount: number
}

const SIGHT_TILE_PIXELS = 20
const PREVIEW_BASE_SCALE = 2

/** 图像引用命名空间 */
export type ImageNamespace = 'local' | 'root' | 'custom' | 'core' | 'shared'

export interface ImageRef {
  namespace: ImageNamespace
  /** 清洗后的相对路径（剥前缀/引号/行内注释；CORE/SHARED 为游戏资产相对路径） */
  rel: string
  /** 原始引用值 */
  raw: string
}

const NAMESPACE_RE = /^(ROOT|CUSTOM|CORE|SHARED):/i

/** 图像值清洗 */
export function cleanImageValue(value: string): string {
  return value.trim().replace(/[ \t]+#.*$/, '').replace(/^["']|["']$/g, '').trim()
}

/** 单帧路径：剥帧延迟后缀（frame.png:0.1 → frame.png） */
export function framePath(frame: string): string {
  return frame.split(':')[0].trim()
}

/** 解析单个图像引用（NONE/AUTO/空 → null） */
export function parseImageRef(value: string | undefined): ImageRef | null {
  const raw = cleanImageValue(value ?? '')
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (upper === 'NONE' || upper === 'AUTO' || upper === 'AUTO_ANIMATED') return null
  const ns = raw.match(NAMESPACE_RE)
  const strip = (s: string) => s.replace(/^\/+/, '').replace(/\\/g, '/')
  if (ns) {
    const namespace = ns[1].toLowerCase() as ImageNamespace
    return { namespace, rel: strip(raw.slice(ns[0].length)), raw }
  }
  return { namespace: 'local', rel: strip(raw), raw }
}

/** 多帧引用拆分（a.png;b.png → 逐帧；帧语法 frame.png:延迟 剥后缀）。
 * 命名空间前缀先于帧延迟后缀解析。 */
export function parseImageRefs(value: string | undefined): ImageRef[] {
  const raw = cleanImageValue(value ?? '')
  if (!raw) return []
  const out: ImageRef[] = []
  for (const frame of raw.split(';')) {
    const f = frame.trim()
    if (!f || f.includes('*') || f.includes('${')) continue
    const ref = parseImageRef(f)
    if (!ref) continue
    ref.rel = framePath(ref.rel)
    if (!ref.rel) continue
    out.push(ref)
  }
  return out
}

/** 引用是否可加载（非 NONE/AUTO/空） */
export function isLoadableImageRef(image: string | undefined): boolean {
  return parseImageRef(image) !== null
}

/** 队伍着色模式规范名映射 */
const TEAM_COLOR_MAP: Record<string, TeamColoringMode> = {
  puregreen: 'pureGreen',
  hueadd: 'hueAdd',
  hueshift: 'hueShift',
  disabled: 'disabled',
}

/** 从单位文件内容解析 [graphics] 配方（无该节返回默认值） */
export function parseGraphicsRecipe(content: string, zhToEn?: (s: string) => string | undefined): GraphicsRecipe {
  const recipe: GraphicsRecipe = {
    imageScale: 1,
    imageOffsetX: 0,
    imageOffsetY: 0,
    totalFrames: 1,
    turretImageScale: 1,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    teamColoringMode: 'disabled',
    fogOfWarSightRange: 15,
    animations: {
      idle: { speed: 1, pingPong: false },
      moving: { speed: 1, pingPong: false },
      attack: { speed: 1, pingPong: false },
    },
  }
  const ini = parseIni(content)
  // 视野属于 [core]，不能因为 graphics 节缺失而静默丢失
  const core = ini.sections.find((s) => sectionEnName(s, zhToEn) === 'core')
  if (core) {
    const sight = core.kvs.find((kv) => toEnKey(kv.key, zhToEn).toLowerCase() === 'fogofwarsightrange')
    if (sight) {
      const parsed = toNumber(sight.value.trim())
      recipe.fogOfWarSightRange = parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null
    }
  }
  const section = ini.sections.find((s) => sectionEnName(s, zhToEn) === 'graphics')
  if (!section) return recipe
  // 动画状态解析 helper
  const animStateOf = (key: string): 'idle' | 'moving' | 'attack' | null => {
    const m = /^animation_(idle|moving|attack)_/.exec(key)
    return m ? (m[1] as 'idle' | 'moving' | 'attack') : null
  }
  for (const kv of section.kvs) {
    const key = toEnKey(kv.key, zhToEn).toLowerCase()
    const value = kv.value.trim()
    const num = toNumber(value)
    const setNum = (assign: (n: number) => void) => {
      if (num !== null) assign(num)
    }
    switch (key) {
      case 'image':
        if (value) {
          const frames = parseImageRefs(value)
          recipe.image = frames[0]?.raw
          if (frames.length > 1) {
            recipe.imageFrames = frames.map((f) => f.raw)
          }
        }
        break
      case 'imagescale':
        setNum((n) => (recipe.imageScale = n))
        break
      case 'imageoffsetx':
      case 'image_offsetx':
        setNum((n) => (recipe.imageOffsetX = n))
        break
      case 'imageoffsety':
      case 'image_offsety':
        setNum((n) => (recipe.imageOffsetY = n))
        break
      case 'total_frames':
        setNum((n) => (recipe.totalFrames = n))
        break
      case 'frame_width':
        setNum((n) => (recipe.frameWidth = n))
        break
      case 'image_turret':
        if (value) recipe.imageTurret = cleanImageValue(value)
        break
      case 'turretimagescale':
        setNum((n) => (recipe.turretImageScale = n))
        break
      case 'image_wreak':
        if (value) recipe.imageWreak = cleanImageValue(value)
        break
      case 'image_shadow':
        if (value) recipe.imageShadow = cleanImageValue(value)
        break
      case 'shadowoffsetx':
        setNum((n) => (recipe.shadowOffsetX = n))
        break
      case 'shadowoffsety':
        setNum((n) => (recipe.shadowOffsetY = n))
        break
      case 'teamcoloringmode': {
        const mapped = TEAM_COLOR_MAP[value.toLowerCase()]
        if (mapped) recipe.teamColoringMode = mapped
        break
      }
      // 多向动画
      case 'animation_direction_units':
        setNum((n) => {
          recipe.direction = recipe.direction ?? { units: 0, strideX: 0, strideY: 0, starting: 0 }
          recipe.direction.units = n
        })
        break
      case 'animation_direction_stridex':
        setNum((n) => {
          recipe.direction = recipe.direction ?? { units: 0, strideX: 0, strideY: 0, starting: 0 }
          recipe.direction.strideX = n
        })
        break
      case 'animation_direction_stridey':
        setNum((n) => {
          recipe.direction = recipe.direction ?? { units: 0, strideX: 0, strideY: 0, starting: 0 }
          recipe.direction.strideY = n
        })
        break
      case 'animation_direction_starting':
        setNum((n) => {
          recipe.direction = recipe.direction ?? { units: 0, strideX: 0, strideY: 0, starting: 0 }
          recipe.direction.starting = n
        })
        break
    }
    // 三态动画字段
    const state = animStateOf(key)
    if (state) {
      const field = key.slice(`animation_${state}_`.length)
      const anim = recipe.animations[state]
      if (field === 'start') setNum((n) => (anim.start = n))
      else if (field === 'end') setNum((n) => (anim.end = n))
      else if (field === 'speed') setNum((n) => (anim.speed = n > 0 ? n : 1))
      else if (field === 'pingpong' || field === 'pingPong') anim.pingPong = value.toLowerCase() === 'true' || value === '1'
      else if (field === 'blendin') setNum((n) => (anim.blendIn = n))
    }
  }
  return recipe
}

/** 从单位文件内容解析炮塔（位置 + 节内图像覆盖） */
export function parsePreviewTurrets(content: string, zhToEn?: (s: string) => string | undefined): PreviewTurret[] {
  const ini = parseIni(content)
  const turrets: PreviewTurret[] = []
  for (const [sourceOrder, section] of ini.sections.entries()) {
    const secLower = sectionEnName(section, zhToEn)
    const match = /^turret_(.+)$/.exec(secLower)
    if (!match) continue
    const suffix = match[1]
    if (!suffix) continue
    const numeric = /^\d+$/.test(suffix)
    const t: PreviewTurret = {
      index: numeric ? Number(suffix) : -1,
      id: `turret_${suffix}`,
      ...(numeric ? {} : { name: suffix }),
      sourceOrder,
      x: 0,
      y: 0,
    }
    for (const kv of section.kvs) {
      const key = toEnKey(kv.key, zhToEn).toLowerCase()
      const num = toNumber(kv.value.trim())
      if (key === 'x' && num !== null) t.x = num
      else if (key === 'y' && num !== null) t.y = num
      else if (key === 'image' && kv.value.trim()) t.image = cleanImageValue(kv.value.trim())
    }
    turrets.push(t)
  }
  return turrets.sort((a, b) => {
    if (a.index >= 0 && b.index >= 0) return a.index - b.index
    if (a.index >= 0) return -1
    if (b.index >= 0) return 1
    return a.sourceOrder - b.sourceOrder
  })
}

/** 帧切片：frame_width 优先，否则 total_frames；多帧引用按文件数计帧 */
export function computeFrames(imageW: number, imageH: number, recipe: GraphicsRecipe): FrameInfo {
  const w = imageW > 0 ? imageW : 1
  const h = imageH > 0 ? imageH : 1
  if (recipe.imageFrames && recipe.imageFrames.length > 1) {
    return { count: recipe.imageFrames.length, frameW: w, frameH: h, multiFile: true }
  }
  if (recipe.frameWidth !== undefined && Number.isFinite(recipe.frameWidth) && recipe.frameWidth > 0) {
    const count = Math.max(1, Math.floor(w / recipe.frameWidth))
    return { count, frameW: recipe.frameWidth, frameH: h }
  }
  const total = Number.isFinite(recipe.totalFrames) && recipe.totalFrames > 0 ? Math.floor(recipe.totalFrames) : 1
  return { count: total, frameW: w / total, frameH: h }
}

/** 图像引用是否指向本地项目文件（NONE/AUTO/跨模组前缀都不是） */
export function isLocalImageRef(image: string | undefined): boolean {
  if (!image) return false
  const v = image.trim()
  if (!v || v.toUpperCase() === 'NONE' || v.toUpperCase() === 'AUTO') return false
  return !/^(?:ROOT|CUSTOM|SHARED|CORE):/i.test(v)
}

/** 跨模组/官方引用 */
export function isGameImageRef(image: string | undefined): boolean {
  if (!image) return false
  return /^(?:ROOT|CUSTOM|SHARED|CORE):/i.test(image.trim())
}

/**
 * 本地/项目内图像候选路径。
 * ROOT:/CUSTOM: 前缀由调用方在 parseImageRef 阶段剥掉后传入 rel。
 */
export function resolveImageCandidates(file: string, image: string, rootPath?: string): string[] {
  const norm = file.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  const dir = idx >= 0 ? norm.slice(0, idx) : ''
  const isAbsFile = /^[A-Za-z]:\//.test(norm) || norm.startsWith('/')
  const rel = image.trim().replace(/^\/+/, '').replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(rel)) return [rel]
  const rels = dir ? [`${dir}/${rel}`, rel] : [rel]
  if (!rootPath) return rels
  return rels.map((r, i) => {
    if (/^[A-Za-z]:\//.test(r)) return r
    if (i === 0 && isAbsFile) return r
    return joinProjectPath(rootPath, r)
  })
}

/** 方向数（360/units；非法防御为 1） */
export function directionCount(dir: DirectionConfig | undefined): number {
  if (!dir || !(dir.units > 0) || !(dir.strideX > 0) || !(dir.strideY > 0)) return 1
  return Math.max(1, Math.round(360 / dir.units))
}

/** 方向块源矩形 */
export function directionSourceRect(
  dir: DirectionConfig,
  directionIndex: number,
  imageW: number,
  imageH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.max(0, Math.min(directionIndex * dir.strideX, Math.max(0, imageW - dir.strideX)))
  const sw = Math.min(dir.strideX, Math.max(0, imageW - sx))
  const sy = 0
  const sh = Math.min(dir.strideY, Math.max(0, imageH - sy))
  return { sx, sy, sw, sh }
}

/**
 * 播放帧号计算（纯函数）：
 * - 无配置：整帧序列按 speed=1 循环；
 * - 有配置：start..end 区间内按 speed 推进；
 * - pingPong：到 end 反向播回 start。
 */
export function animationFrameNumber(anim: AnimationStateConfig | undefined, elapsedMs: number, frameCount: number): number {
  if (frameCount <= 1) return 0
  if (!anim) {
    return Math.floor(elapsedMs / 1000) % frameCount
  }
  const start = Math.max(0, Math.min(anim.start ?? 0, frameCount - 1))
  const end = Math.max(start, Math.min(anim.end ?? frameCount - 1, frameCount - 1))
  const span = end - start
  const speed = anim.speed > 0 ? anim.speed : 1
  const t = Math.floor((elapsedMs / 1000) * speed)
  if (span <= 0) return start
  if (anim.pingPong) {
    const period = span * 2
    const m = t % period
    return start + (m <= span ? m : period - m)
  }
  return start + (t % (span + 1))
}

/** 计算完整绘制布局（纯函数；阴影排最前） */
export function computeDrawLayout(recipe: GraphicsRecipe, turrets: PreviewTurret[]): DrawItem[] {
  const items: DrawItem[] = []
  const bodyScale = recipe.imageScale

  // 阴影：AUTO = 主图黑色剪影；NONE 不画
  const shadow = recipe.imageShadow
  if (shadow && cleanImageValue(shadow).toUpperCase() !== 'NONE') {
    const isAuto = /^AUTO/.test(cleanImageValue(shadow).toUpperCase())
    items.push({
      kind: 'shadow',
      image: isAuto ? recipe.image : shadow,
      cx: recipe.shadowOffsetX * bodyScale,
      cy: recipe.shadowOffsetY * bodyScale,
      scale: bodyScale,
      alpha: 0.5,
      sourceMode: isAuto ? 'bodyFrames' : 'full',
      placeholder: '阴影图像',
    })
  }

  // 主体
  items.push({
    kind: 'body',
    image: recipe.image,
    cx: recipe.imageOffsetX * bodyScale,
    cy: recipe.imageOffsetY * bodyScale,
    scale: bodyScale,
    alpha: 1,
    sourceMode: 'bodyFrames',
    placeholder: recipe.image && isLocalImageRef(recipe.image) ? recipe.image : '主体图像',
  })

  // 炮塔：节内 image 覆盖 > 配方 image_turret；image 为 NONE/AUTO 不产出绘制项
  for (const t of turrets) {
    const image = t.image || recipe.imageTurret
    if (!image || !isLoadableImageRef(image)) continue
    items.push({
      kind: 'turret',
      image,
      cx: t.x,
      cy: t.y,
      scale: recipe.turretImageScale,
      alpha: 1,
      sourceMode: 'full',
      placeholder: image,
    })
  }

  // 残骸（预览可选展示）
  if (recipe.imageWreak && isLoadableImageRef(recipe.imageWreak)) {
    items.push({
      kind: 'wreck',
      image: recipe.imageWreak,
      cx: 0,
      cy: 0,
      scale: bodyScale,
      alpha: 1,
      placeholder: recipe.imageWreak,
    })
  }

  return items
}

/** 计算单个绘制项的源矩形与目标矩形 */
export function computeDrawGeometry(
  item: DrawItem,
  imageW: number,
  imageH: number,
  frameInfo: FrameInfo,
  frameIndex: number,
  globalScale: number,
  sourceRect?: { sx: number; sy: number; sw: number; sh: number },
): DrawGeometry {
  const safeW = imageW > 0 && Number.isFinite(imageW) ? imageW : 1
  const safeH = imageH > 0 && Number.isFinite(imageH) ? imageH : 1
  const source = sourceRect ?? (() => {
    if (item.sourceMode !== 'bodyFrames') return { sx: 0, sy: 0, sw: safeW, sh: safeH }
    if (frameInfo.multiFile) return { sx: 0, sy: 0, sw: safeW, sh: safeH }
    const sw = frameInfo.frameW > 0 && Number.isFinite(frameInfo.frameW) ? frameInfo.frameW : safeW
    const sh = frameInfo.frameH > 0 && Number.isFinite(frameInfo.frameH) ? frameInfo.frameH : safeH
    const count = Math.max(1, frameInfo.count)
    const f = Math.max(0, Math.min(Math.floor(frameIndex), count - 1))
    return { sx: f * sw, sy: 0, sw, sh }
  })()
  const sx = Math.max(0, Math.min(source.sx, safeW))
  const sy = Math.max(0, Math.min(source.sy, safeH))
  const sw = Math.max(0, Math.min(source.sw, safeW - sx))
  const sh = Math.max(0, Math.min(source.sh, safeH - sy))
  const multiplier = Number.isFinite(globalScale) && globalScale > 0 ? globalScale : 1
  const dw = sw * item.scale * multiplier
  const dh = sh * item.scale * multiplier
  return {
    source: { sx, sy, sw, sh },
    destination: {
      dx: item.cx * multiplier - dw / 2,
      dy: item.cy * multiplier - dh / 2,
      dw,
      dh,
    },
  }
}

/** 视野圆几何 */
export function computeSightGeometry(
  recipe: GraphicsRecipe,
  canvasW: number,
  canvasH: number,
  zoom: number,
): SightGeometry | null {
  const tiles = recipe.fogOfWarSightRange
  if (tiles === null || !Number.isFinite(tiles) || tiles < 0) return null
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const scale = PREVIEW_BASE_SCALE * safeZoom
  const rawRadius = tiles * SIGHT_TILE_PIXELS * scale
  const maxRadius = Math.hypot(Math.max(0, canvasW), Math.max(0, canvasH))
  const radius = Math.min(rawRadius, maxRadius)
  return {
    cx: canvasW / 2,
    cy: canvasH / 2,
    radius,
    clipped: radius !== rawRadius,
    tileCount: tiles,
  }
}
