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
 */
import { parseIni, sectionEnName, toEnKey, toNumber } from '../semanticChecks/helpers'

export interface GraphicsRecipe {
  /** 主体图像（相对单位文件目录或项目根；NONE/AUTO 无） */
  image?: string
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

/** 帧切片结果 */
export interface FrameInfo {
  count: number
  frameW: number
  frameH: number
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
        if (value) recipe.image = value
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
        if (value) recipe.imageTurret = value
        break
      case 'turretimagescale':
        setNum((n) => (recipe.turretImageScale = n))
        break
      case 'image_wreak':
        if (value) recipe.imageWreak = value
        break
      case 'image_shadow':
        if (value) recipe.imageShadow = value
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
      else if (key === 'image' && kv.value.trim()) t.image = kv.value.trim()
    }
    turrets.push(t)
  }
  return turrets.sort((a, b) => a.index - b.index)
}

/** 帧切片：frame_width 优先，否则 total_frames；非法值防御为单帧 */
export function computeFrames(imageW: number, imageH: number, recipe: GraphicsRecipe): FrameInfo {
  const w = imageW > 0 ? imageW : 1
  const h = imageH > 0 ? imageH : 1
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
  return !/^(?:ROOT|CUSTOM|SHARED):/i.test(v)
}

/** 跨模组/官方引用（CORE:/ROOT:/SHARED:/CUSTOM:）——需要游戏路径才能取图 */
export function isGameImageRef(image: string | undefined): boolean {
  if (!image) return false
  return /^(?:ROOT|CUSTOM|SHARED|CORE):/i.test(image.trim())
}

/** 本地图像候选路径：先按单位文件所在目录，再按项目根（官方单位习惯图片放同目录） */
export function resolveImageCandidates(file: string, image: string): string[] {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const rel = image.trim().replace(/^\/+/, '')
  return dir ? [`${dir}/${rel}`, rel] : [rel]
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
  if (shadow && shadow.toUpperCase() !== 'NONE') {
    items.push({
      kind: 'shadow',
      image: shadow.toUpperCase() === 'AUTO' ? recipe.image : shadow,
      cx: recipe.shadowOffsetX * bodyScale,
      cy: recipe.shadowOffsetY * bodyScale,
      scale: bodyScale,
      alpha: 0.5,
      placeholder: '阴影图像',
    })
  }

  // 炮塔：节内 image 覆盖 > 配方 image_turret；位置按 turret x/y（不缩放）
  for (const t of turrets) {
    const image = t.image || recipe.imageTurret
    items.push({
      kind: 'turret',
      image,
      cx: t.x,
      cy: t.y,
      scale: recipe.turretImageScale,
      alpha: 1,
      placeholder: image && isLocalImageRef(image) ? image : `炮塔 ${t.index}`,
    })
  }

  // 残骸（预览可选展示，默认不画——由调用方过滤）
  if (recipe.imageWreak && isLocalImageRef(recipe.imageWreak)) {
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
