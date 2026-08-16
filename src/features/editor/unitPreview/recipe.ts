/**
 * 单位合成预览配方（M22，P3 任务 1）——纯解析与布局计算（无 DOM，可测试）：
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
}

/** 炮塔信息（位置/图像覆盖），来自 [turret_N] 节 */
export interface PreviewTurret {
  index: number
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
  /** 缺图时显示占位 */
  placeholder: string
}

/** 图像引用命名空间（与运行前检查/官方文档一致） */
export type ImageNamespace = 'local' | 'root' | 'custom' | 'core' | 'shared'

export interface ImageRef {
  namespace: ImageNamespace
  /** 清洗后的相对路径（剥前缀/引号/行内注释；CORE/SHARED 为游戏资产相对路径） */
  rel: string
  /** 原始引用值 */
  raw: string
}

const NAMESPACE_RE = /^(ROOT|CUSTOM|CORE|SHARED):/i

/** 图像值清洗：外层引号 + 行内注释（与运行前检查/编辑器 imagePathFromLine 对齐） */
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
 * 命名空间前缀（ROOT:/CORE: 等）先于帧延迟后缀解析——先剥前缀拿到 rel，
 * 再对 rel 剥 :延迟（与运行前检查的顺序一致，否则 ROOT:units/a.png:0.1 会被
 * framePath 按冒号切成碎片）。非法帧（含 * 或 ${ 的模板/随机语法）跳过。 */
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
  }
  const ini = parseIni(content)
  const section = ini.sections.find((s) => sectionEnName(s, zhToEn) === 'graphics')
  if (!section) return recipe
  for (const kv of section.kvs) {
    const key = toEnKey(kv.key, zhToEn).toLowerCase()
    const value = kv.value.trim()
    const num = toNumber(value)
    const setNum = (assign: (n: number) => void) => {
      if (num !== null) assign(num)
    }
    switch (key) {
      case 'image':
        // 多帧引用（a.png;b.png 动画序列）：首帧作为主体 image，完整序列进 imageFrames
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
        setNum((n) => (recipe.imageOffsetX = n))
        break
      case 'imageoffsety':
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
    }
  }
  return recipe
}

/** 从单位文件内容解析炮塔（位置 + 节内图像覆盖；复用 turretUtils 的解析） */
export function parsePreviewTurrets(content: string, zhToEn?: (s: string) => string | undefined): PreviewTurret[] {
  const ini = parseIni(content)
  const turrets: PreviewTurret[] = []
  for (const section of ini.sections) {
    const secLower = sectionEnName(section, zhToEn)
    const m = /^turret_(\d+)$/.exec(secLower)
    if (!m) continue
    const t: PreviewTurret = { index: Number(m[1]), x: 0, y: 0 }
    for (const kv of section.kvs) {
      const key = toEnKey(kv.key, zhToEn).toLowerCase()
      const num = toNumber(kv.value.trim())
      if (key === 'x' && num !== null) t.x = num
      else if (key === 'y' && num !== null) t.y = num
      else if (key === 'image' && kv.value.trim()) t.image = cleanImageValue(kv.value.trim())
    }
    turrets.push(t)
  }
  return turrets.sort((a, b) => a.index - b.index)
}

/** 帧切片：frame_width 优先，否则 total_frames；非法值防御为单帧。
 * 多帧引用（imageFrames）按文件数计帧、整图绘制（不做横向切片）。 */
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

/** 跨模组/官方引用（CORE:/ROOT:/SHARED:/CUSTOM:） */
export function isGameImageRef(image: string | undefined): boolean {
  if (!image) return false
  return /^(?:ROOT|CUSTOM|SHARED|CORE):/i.test(image.trim())
}

/**
 * 本地/项目内图像候选路径：先按单位文件所在目录，再按项目根（官方单位习惯图片放同目录）。
 * file 可为绝对路径（编辑器 tab.path）或相对项目根的路径；
 * rootPath 提供时返回 bridge 要求的项目内绝对路径（fs 通道拒绝相对路径）。
 * ROOT:/CUSTOM: 前缀由调用方在 parseImageRef 阶段剥掉后传入 rel。
 */
export function resolveImageCandidates(file: string, image: string, rootPath?: string): string[] {
  // 正斜杠统一（Windows 路径可能带反斜杠）
  const norm = file.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  const dir = idx >= 0 ? norm.slice(0, idx) : ''
  const isAbsFile = /^[A-Za-z]:\//.test(norm) || norm.startsWith('/')
  const rel = image.trim().replace(/^\/+/, '').replace(/\\/g, '/')
  // 图像引用本身已是盘符绝对路径（非法写法但常见于手写）：直接单候选
  if (/^[A-Za-z]:\//.test(rel)) return [rel]
  const rels = dir ? [`${dir}/${rel}`, rel] : [rel]
  if (!rootPath) return rels
  return rels.map((r, i) => {
    // 候选本身已是绝对路径（盘符）→ 原样；首候选来自绝对单位文件同目录 → 天然绝对；
    // 其余相对候选统一拼项目根
    if (/^[A-Za-z]:\//.test(r)) return r
    if (i === 0 && isAbsFile) return r
    return joinProjectPath(rootPath, r)
  })
}

/** 计算完整绘制布局（纯函数；缺图由渲染层决定占位，这里只出几何） */
export function computeDrawLayout(recipe: GraphicsRecipe, turrets: PreviewTurret[]): DrawItem[] {
  const items: DrawItem[] = []
  const bodyScale = recipe.imageScale

  // 主体（含帧偏移）
  items.push({
    kind: 'body',
    image: recipe.image,
    cx: recipe.imageOffsetX * bodyScale,
    cy: recipe.imageOffsetY * bodyScale,
    scale: bodyScale,
    alpha: 1,
    placeholder: recipe.image && isLocalImageRef(recipe.image) ? recipe.image : '主体图像',
  })

  // 阴影：AUTO = 主图黑色剪影（渲染层画），文件 = 独立图像；NONE 不画
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
      placeholder: '阴影图像',
    })
  }

  // 炮塔：节内 image 覆盖 > 配方 image_turret；位置按 turret x/y（不缩放）。
  // image 为 NONE/AUTO（官方单位常见 image_turret: NONE）表示「无炮塔图」，
  // 不产出绘制项——不是缺图，不画占位
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
      placeholder: image,
    })
  }

  // 残骸（预览可选展示，默认不画——由调用方过滤；CORE:/ROOT: 等前缀引用同样可加载）
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
