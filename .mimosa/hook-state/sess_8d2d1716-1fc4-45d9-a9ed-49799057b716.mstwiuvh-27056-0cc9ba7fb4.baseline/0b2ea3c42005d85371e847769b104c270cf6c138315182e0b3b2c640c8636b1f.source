/**
 * 单位合成预览渲染（M22，P3 任务 1）：
 * 按 [graphics] 配方把「主体帧切片 + 阴影 + 炮塔 + 残骸」合成画到 Canvas——
 * 纯本地实现，不内置游戏引擎、不依赖服务器。
 *
 * 图像来源：
 * - 本地引用 → 项目文件（readImageAsDataUrl，相对单位文件目录/项目根）；
 * - CORE:/ROOT:/SHARED:/CUSTOM: 引用 → 需要游戏路径（readGameAssetImage），
 *   未配置游戏路径时显示占位并提示；
 * - 缺图一律占位（灰块 + 名称），不报错不崩溃。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getBridge } from '../../../services/bridge'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'
import {
  computeDrawLayout,
  computeFrames,
  isGameImageRef,
  isLocalImageRef,
  parseGraphicsRecipe,
  parsePreviewTurrets,
  resolveImageCandidates,
} from './recipe'

interface Props {
  file: string
  content: string
  rootPath: string
  /** 配置的游戏安装路径（可为空：CORE: 等官方贴图无法加载，显示占位） */
  gamePath?: string
  onClose: () => void
}

/** 图像加载缓存（同一会话内不重复读盘；上限 200 条防长期会话膨胀） */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>()
const MAX_CACHE = 200

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function cacheSet(key: string, value: Promise<HTMLImageElement | null>): void {
  if (imageCache.size >= MAX_CACHE) {
    // 简单淘汰：清掉最旧的一半（预览场景图片数量有限，够用）
    const keys = [...imageCache.keys()].slice(0, Math.floor(MAX_CACHE / 2))
    for (const k of keys) imageCache.delete(k)
  }
  imageCache.set(key, value)
}

/** 取一张图像（项目内或游戏资产；失败返回 null）。
 * 本地候选拼成项目内绝对路径再走桥（fs 通道要求绝对路径，相对路径会被主进程拒绝）；
 * 缓存键含单位文件路径——同名贴图在不同单位目录（units/a/img.png vs units/b/img.png）
 * 不能串用 */
async function fetchImage(
  image: string | undefined,
  file: string,
  rootPath: string,
  gamePath: string | undefined,
): Promise<{ url: string; img: HTMLImageElement | null } | null> {
  if (!image || (!isLocalImageRef(image) && !isGameImageRef(image))) return null
  const cacheKey = `${rootPath}\u0000${file}\u0000${image}`
  const cached = imageCache.get(cacheKey)
  if (cached) return cached.then((img) => (img ? { url: cacheKey, img } : null))
  const promise = (async (): Promise<HTMLImageElement | null> => {
    try {
      if (isLocalImageRef(image)) {
        for (const rel of resolveImageCandidates(file, image)) {
          try {
            const dataUrl = await getBridge().project.readImageAsDataUrl(rootPath, `${rootPath}/${rel}`)
            const img = await loadImage(dataUrl)
            if (img) return img
          } catch {
            // 候选失败继续下一个
          }
        }
        return null
      }
      // 游戏资产（CORE:/ROOT: 等）
      if (gamePath) {
        const rel = image.replace(/^[A-Za-z]+:/i, '')
        const dataUrl = await getBridge().game.readAssetImage(gamePath, rel)
        return loadImage(dataUrl)
      }
      return null
    } catch {
      return null
    }
  })()
  cacheSet(cacheKey, promise)
  return promise.then((img) => (img ? { url: cacheKey, img } : null))
}

/** 单位合成预览器（模态弹窗） */
export function UnitPreviewModal({ file, content, rootPath, gamePath, onClose }: Props) {
  useEscapeHandler(onClose)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [images, setImages] = useState<Map<string, HTMLImageElement | null>>(new Map())
  const [frame, setFrame] = useState(0)
  const [showWreck, setShowWreck] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [failed, setFailed] = useState<string[]>([])

  const recipe = useMemo(() => parseGraphicsRecipe(content), [content])
  const turrets = useMemo(() => parsePreviewTurrets(content), [content])

  // 帧切片信息：主图加载后才能确定（frameWidth 覆盖 / 默认按图像宽切）
  const mainImg = recipe.image ? images.get(recipe.image) : null
  const mainImgOrNull = mainImg ?? null
  const frameInfo = useMemo(() => {
    if (!recipe.image || !mainImgOrNull) return { count: 1, frameW: 0, frameH: 0 }
    return computeFrames(mainImgOrNull.naturalWidth, mainImgOrNull.naturalHeight, recipe)
  }, [recipe, mainImgOrNull])

  // 帧号钳制：切单位/改帧数后滑块可能越界——渲染期钳制，不触发额外 setState
  const clampedFrame = Math.min(frame, Math.max(0, frameInfo.count - 1))

  // 加载全部引用图像（主体/阴影/炮塔/残骸去重）
  useEffect(() => {
    let alive = true
    const need = new Map<string, string>()
    for (const item of computeDrawLayout(recipe, turrets)) {
      if (item.image) need.set(item.image, item.image)
    }
    void (async () => {
      const map = new Map<string, HTMLImageElement | null>()
      const bad: string[] = []
      for (const image of need.values()) {
        const res = await fetchImage(image, file, rootPath, gamePath)
        if (!alive) return
        if (res) map.set(image, res.img)
        else bad.push(image)
      }
      if (!alive) return
      setImages(map)
      setFailed(bad)
    })()
    return () => {
      alive = false
    }
  }, [file, rootPath, gamePath, recipe, turrets])

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // 棋盘格背景（透明底可见）
    const SIZE = 12
    ctx.fillStyle = 'rgba(128,128,128,0.15)'
    for (let y = 0; y < canvas.height; y += SIZE) {
      for (let x = 0; x < canvas.width; x += SIZE) {
        if (((x / SIZE) + (y / SIZE)) % 2 === 0) ctx.fillRect(x, y, SIZE, SIZE)
      }
    }
    if (!recipe.image || !mainImgOrNull) {
      drawPlaceholder(ctx, canvas.width / 2, canvas.height / 2, '未配置主体图像')
      return
    }
    const fi = frameInfo
    const scale = 2 * zoom // 基础 2 倍放大便于观察
    const cx = canvas.width / 2
    const cy = canvas.height / 2
    const items = computeDrawLayout(recipe, turrets).filter((i) => (i.kind === 'wreck' ? showWreck : true))
    for (const item of items) {
      const img = item.image ? images.get(item.image) : undefined
      if (!img || !item.image) {
        drawPlaceholder(ctx, cx + item.cx * scale, cy + item.cy * scale, item.placeholder, item.kind === 'turret' ? 28 : 34)
        continue
      }
      // 主体与 AUTO 阴影跟随帧滑块；炮塔单帧
      const f = item.kind === 'turret' ? 0 : clampedFrame
      const sx = f * fi.frameW
      const sy = 0
      const dw = fi.frameW * item.scale * scale
      const dh = fi.frameH * item.scale * scale
      ctx.save()
      ctx.globalAlpha = item.alpha
      if (item.kind === 'shadow' && recipe.imageShadow?.toUpperCase() === 'AUTO') {
        // AUTO 阴影：主图剪影（黑色半透明）
        ctx.filter = 'grayscale(1) brightness(0.2)'
      }
      ctx.drawImage(img, sx, sy, fi.frameW, fi.frameH, cx + item.cx * scale - dw / 2, cy + item.cy * scale - dh / 2, dw, dh)
      ctx.restore()
    }
  }, [images, frameInfo, clampedFrame, showWreck, zoom, recipe, turrets, mainImgOrNull])

  const gameMissing = failed.some((f) => isGameImageRef(f))
  const totalFrames = frameInfo.count

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card vdiff-card unitprev-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          单位预览 · {file.split('/').pop()}
          {recipe.image && <code className="tool-path" style={{ marginLeft: 8 }}>{recipe.image}</code>}
        </div>
        <div className="modal-body vdiff-body">
          <div className="unitprev-toolbar">
            <span className="vdiff-hint">按 [graphics] 配方合成（帧切片/炮塔叠加/阴影），纯本地渲染</span>
            <span className="grow" />
            {totalFrames > 1 && (
              <label className="vdiff-select">
                帧 {clampedFrame + 1}/{totalFrames}
                <input
                  type="range"
                  min={0}
                  max={totalFrames - 1}
                  value={clampedFrame}
                  onChange={(e) => setFrame(Number(e.target.value))}
                  style={{ width: 140 }}
                />
              </label>
            )}
            <button className={`btn${showWreck ? ' primary' : ''}`} style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => setShowWreck((v) => !v)}>
              <AppIcon name="image" size={12} /> 残骸
            </button>
            <button className="icon-btn" title="缩小" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
            <span className="vdiff-hint">{Math.round(zoom * 100)}%</span>
            <button className="icon-btn" title="放大" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
          </div>
          <div className="unitprev-canvas-wrap">
            <canvas ref={canvasRef} width={560} height={420} className="unitprev-canvas" />
          </div>
          {gameMissing && (
            <div className="lint-evidence">
              部分贴图是游戏内置引用（CORE:/ROOT: 等）：{failed.filter((f) => isGameImageRef(f)).join('、')}——
              {gamePath ? '读取失败（文件可能不存在）' : '需在 设置 → 游戏 配置铁锈战争安装目录后才能加载'}
            </div>
          )}
          {failed.length === 0 && <div className="lint-suggestion">预览正常：{recipe.image ? `${recipe.image}（${totalFrames} 帧）` : '未配置主体图像'}{turrets.length > 0 ? ` · ${turrets.length} 个炮塔` : ''}</div>}
        </div>
        <div className="modal-footer">
          <span className="vdiff-hint">单位中心为原点；图像相对单位文件目录或项目根</span>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

/** 缺图占位：灰块 + 名称（不崩溃） */
function drawPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, size = 34): void {
  ctx.save()
  ctx.fillStyle = 'rgba(128,128,128,0.25)'
  ctx.strokeStyle = 'rgba(128,128,128,0.6)'
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.rect(x - size / 2, y - size / 2, size, size)
  ctx.fill()
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(128,128,128,0.9)'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  const labelText = label.length > 16 ? `${label.slice(0, 15)}…` : label
  ctx.fillText(labelText, x, y + size / 2 + 12)
  ctx.restore()
}
