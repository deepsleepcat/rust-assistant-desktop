/**
 * 单位合成预览渲染（M22，P3 任务 1）：
 * 按 [graphics] 配方把「主体帧切片 + 阴影 + 炮塔 + 残骸」合成画到 Canvas——
 * 纯本地实现，不内置游戏引擎、不依赖服务器。
 *
 * 图像来源（命名空间语义与运行前检查/官方文档一致）：
 * - 无前缀 / ROOT: / CUSTOM: → 项目内文件（readImageAsDataUrl，绝对路径）
 * - CORE: → 游戏 assets/units/ 下资源（readGameAssetImage）
 * - SHARED: → 游戏共享图库 assets/units/shared/ 下资源（readGameAssetImage）
 * - 缺图一律占位（灰块 + 名称），不报错不崩溃；加载失败原因分类提示。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getBridge } from '../../../services/bridge'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'
import {
  animationFrameNumber,
  computeDrawGeometry,
  computeDrawLayout,
  computeFrames,
  computeSightGeometry,
  directionCount,
  directionSourceRect,
  framePath,
  parseGraphicsRecipe,
  parseImageRef,
  parsePreviewTurrets,
  resolveImageCandidates,
  type TeamColoringMode,
} from './recipe'

interface Props {
  file: string
  content: string
  rootPath: string
  /** 配置的游戏安装路径（可为空：CORE:/SHARED: 官方贴图无法加载，显示占位） */
  gamePath?: string
  /** 中文显示层回译（[图像组]/主体图像 → graphics/image）；英文模式可不传 */
  zhToEn?: (s: string) => string | undefined
  onClose: () => void
}

/** 加载失败原因（提示文案区分：本地缺图 / 游戏内置读取失败 / 未配置游戏路径） */
type FailReason = 'local-missing' | 'game-missing' | 'no-game-path'

/** 图像加载缓存（同一会话内不重复读盘；只缓存成功，失败不污染后续重试；
 * 上限 200 条防长期会话膨胀）。缓存键含 gamePath——换游戏目录不串图。 */
const imageCache = new Map<string, Promise<HTMLImageElement>>()
/** 在途加载去重（成功落地进 imageCache，失败/成功都立即移除） */
const imageInflight = new Map<string, Promise<HTMLImageElement | null>>()
const MAX_CACHE = 200

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function cacheSuccess(key: string, value: Promise<HTMLImageElement>): void {
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
  image: string,
  file: string,
  rootPath: string,
  gamePath: string | undefined,
): Promise<{ url: string; img: HTMLImageElement } | null> {
  const ref = parseImageRef(image)
  if (!ref) return null
  // 帧延迟后缀（a.png:0.1）不参与文件路径（命名空间前缀已在 parseImageRef 剥掉）
  ref.rel = framePath(ref.rel)
  if (!ref.rel) return null
  const cacheKey = `${gamePath ?? ''}\u0000${rootPath}\u0000${file}\u0000${image}`
  const cached = imageCache.get(cacheKey)
  if (cached) return cached.then((img) => ({ url: cacheKey, img }))
  const inflight = imageInflight.get(cacheKey)
  if (inflight) return inflight.then((img) => (img ? { url: cacheKey, img } : null))
  const promise = (async (): Promise<HTMLImageElement | null> => {
    try {
      if (ref.namespace === 'core' || ref.namespace === 'shared') {
        if (!gamePath) return null
        // CORE = 游戏 assets/units/ 下资源；SHARED = 共享图库 assets/units/shared/（已实测游戏目录结构）
        const assetRel =
          ref.namespace === 'core' ? `assets/units/${ref.rel}` : `assets/units/shared/${ref.rel}`
        const dataUrl = await getBridge().game.readAssetImage(gamePath, assetRel)
        return loadImage(dataUrl)
      }
      // 项目内引用（无前缀/ROOT:/CUSTOM:）：绝对路径候选逐个尝试
      for (const abs of resolveImageCandidates(file, ref.rel, rootPath)) {
        try {
          const dataUrl = await getBridge().project.readImageAsDataUrl(rootPath, abs)
          const img = await loadImage(dataUrl)
          if (img) return img
        } catch {
          // 候选失败继续下一个
        }
      }
      return null
    } catch {
      return null
    }
  })()
  imageInflight.set(cacheKey, promise)
  return promise.then((img) => {
    imageInflight.delete(cacheKey)
    if (img) cacheSuccess(cacheKey, Promise.resolve(img))
    return img ? { url: cacheKey, img } : null
  })
}

/** 队伍着色模式渲染（M34：Canvas 近似官方 GLSL shader 效果）。
 * - pureGreen：灰阶 → 棕 → 色相转到绿（官方 pureGreenTeamColor.frag 的近似）
 * - hueShift：整体色相偏移到默认队伍绿 120°（官方 hueShiftTeamColor.frag 的近似；
 *   预览无队伍概念，固定用「我方」绿色）
 * - hueAdd：绘制后以 'color' 混合模式叠加绿色（保留原图亮度，官方 hueAddTeamColor.frag 近似）
 */
function applyTeamColor(ctx: CanvasRenderingContext2D, mode: TeamColoringMode): void {
  if (mode === 'pureGreen') {
    ctx.filter = 'grayscale(1) sepia(1) hue-rotate(75deg) saturate(5)'
  } else if (mode === 'hueShift') {
    ctx.filter = 'hue-rotate(120deg)'
  }
  // hueAdd 由调用方在 drawImage 后叠加（需要图像区域矩形）
}

/** 单位合成预览器（模态弹窗） */
export function UnitPreviewModal({ file, content, rootPath, gamePath, zhToEn, onClose }: Props) {
  useEscapeHandler(onClose)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [images, setImages] = useState<Map<string, HTMLImageElement | null>>(new Map())
  const [frame, setFrame] = useState(0)
  const [showWreck, setShowWreck] = useState(false)
  const [showSight, setShowSight] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [failed, setFailed] = useState<Array<{ image: string; reason: FailReason }>>([])
  // M34 动画播放：播放中 / 当前动画状态（待机/移动/攻击）/ 多向动画朝向
  const [playing, setPlaying] = useState(true)
  const [animState, setAnimState] = useState<'idle' | 'moving' | 'attack'>('idle')
  const [directionIdx, setDirectionIdx] = useState(0)
  const elapsedRef = useRef(0)
  const lastTsRef = useRef<number | null>(null)

  // 中文显示层：传回译函数才能解析 [图像组]/主体图像 等中文节键（与单位表单一致）
  const recipe = useMemo(() => parseGraphicsRecipe(content, zhToEn), [content, zhToEn])
  const turrets = useMemo(() => parsePreviewTurrets(content, zhToEn), [content, zhToEn])

  // 帧切片信息：主图加载后才能确定（frameWidth 覆盖 / 默认按图像宽切）
  const mainImg = recipe.image ? images.get(recipe.image) : null
  const mainImgOrNull = mainImg ?? null
  const frameInfo = useMemo(() => {
    if (!recipe.image || !mainImgOrNull) return { count: 1, frameW: 0, frameH: 0 }
    return computeFrames(mainImgOrNull.naturalWidth, mainImgOrNull.naturalHeight, recipe)
  }, [recipe, mainImgOrNull])

  // 帧号钳制：切单位/改帧数后滑块可能越界——渲染期钳制，不触发额外 setState
  const clampedFrame = Math.min(frame, Math.max(0, frameInfo.count - 1))
  // 多向动画：方向块单帧，帧播放器停用（方向切换代替帧滑块）
  const dirCount = directionCount(recipe.direction)
  const isDirectional = dirCount > 1
  const animFrameCount = isDirectional ? 1 : frameInfo.count

  // M34 播放器：rAF 累计时长 → animationFrameNumber 计算当前帧。
  // 帧区间/速度/往返（animation_idle/moving/attack_*）按配方播放；无配置时整序列循环。
  useEffect(() => {
    if (!playing || animFrameCount <= 1) return
    let raf = 0
    const loop = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts
      // 钳制单帧 delta（<=250ms）：标签页后台 rAF 停摆后恢复不产生巨跳
      const delta = Math.min(250, ts - lastTsRef.current)
      lastTsRef.current = ts
      elapsedRef.current += delta
      const anim = recipe.animations[animState]
      const n = animationFrameNumber(anim, elapsedRef.current, animFrameCount)
      // 帧号未变不触发重渲染（60fps 下大多数帧号不变）
      setFrame((prev) => (prev === n ? prev : n))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      lastTsRef.current = null
    }
  }, [playing, animState, animFrameCount, recipe.animations])

  /** 切换动画状态：重置播放计时（避免状态切换瞬间跳帧） */
  const switchAnimState = (s: 'idle' | 'moving' | 'attack') => {
    elapsedRef.current = 0
    setAnimState(s)
    setFrame(0)
    setPlaying(true)
  }

  // 加载全部引用图像（主体多帧/阴影/炮塔/残骸去重）
  useEffect(() => {
    let alive = true
    const need = new Map<string, string>()
    for (const item of computeDrawLayout(recipe, turrets)) {
      if (item.kind === 'body' && recipe.imageFrames?.length) {
        for (const f of recipe.imageFrames) if (f) need.set(f, f)
      } else if (item.image) {
        need.set(item.image, item.image)
      }
    }
    void (async () => {
      const map = new Map<string, HTMLImageElement | null>()
      const bad: Array<{ image: string; reason: FailReason }> = []
      for (const image of need.values()) {
        const ref = parseImageRef(image)
        const isGameNs = ref?.namespace === 'core' || ref?.namespace === 'shared'
        if (isGameNs && !gamePath) {
          bad.push({ image, reason: 'no-game-path' })
          continue
        }
        const res = await fetchImage(image, file, rootPath, gamePath)
        if (!alive) return
        if (res) map.set(image, res.img)
        else bad.push({ image, reason: isGameNs ? 'game-missing' : 'local-missing' })
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
    const teamMode = recipe.teamColoringMode
    if (showSight) {
      const sight = computeSightGeometry(recipe, canvas.width, canvas.height, zoom)
      if (sight) {
        ctx.save()
        ctx.globalAlpha = 0.18
        ctx.fillStyle = '#3b82f6'
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(sight.cx, sight.cy, sight.radius, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 0.65
        ctx.stroke()
        ctx.restore()
      }
    }
    for (const item of items) {
      // 多帧引用（a.png;b.png）：主体按帧号切换整图；其余（阴影/炮塔）用首帧或原引用
      let imgKey = item.image
      if (item.kind === 'body' && recipe.imageFrames?.length) {
        imgKey = recipe.imageFrames[clampedFrame] ?? item.image
      }
      const img = imgKey ? images.get(imgKey) : undefined
      if (!img || !imgKey) {
        drawPlaceholder(ctx, cx + item.cx * scale, cy + item.cy * scale, item.placeholder, item.kind === 'turret' ? 28 : 34)
        continue
      }
      // 源矩形：方向块只作用于主体/自动阴影；炮塔始终使用自身整图。
      const directionRect = isDirectional && item.sourceMode === 'bodyFrames'
        ? directionSourceRect(recipe.direction!, directionIdx, img.naturalWidth, img.naturalHeight)
        : undefined
      const geometry = computeDrawGeometry(item, img.naturalWidth, img.naturalHeight, fi, clampedFrame, scale, directionRect)
      const { sx, sy, sw, sh } = geometry.source
      const { dx, dy, dw, dh } = geometry.destination
      const drawX = cx + dx
      const drawY = cy + dy
      ctx.save()
      ctx.globalAlpha = item.alpha
      if (item.kind === 'shadow' && recipe.imageShadow && /^AUTO/i.test(recipe.imageShadow)) {
        // AUTO 阴影：主图剪影（黑色半透明）——不随队伍着色；AUTO_ANIMATED 同属自动剪影
        ctx.filter = 'grayscale(1) brightness(0.2)'
      } else if (item.kind !== 'shadow' && teamMode !== 'disabled') {
        applyTeamColor(ctx, teamMode)
      }
      ctx.drawImage(img, sx, sy, sw, sh, drawX, drawY, dw, dh)
      // hueAdd：'color' 混合模式叠加队伍绿（保留亮度，近似官方色相叠加）
      if (item.kind !== 'shadow' && teamMode === 'hueAdd') {
        ctx.globalCompositeOperation = 'color'
        ctx.fillStyle = '#00c800'
        ctx.fillRect(drawX, drawY, dw, dh)
      }
      ctx.restore()
    }
  }, [images, frameInfo, clampedFrame, showWreck, showSight, zoom, recipe, turrets, mainImgOrNull, isDirectional, directionIdx])

  const noGamePath = failed.filter((f) => f.reason === 'no-game-path')
  const gameMissing = failed.filter((f) => f.reason === 'game-missing')
  const localMissing = failed.filter((f) => f.reason === 'local-missing')
  const totalFrames = frameInfo.count

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card vdiff-card unitprev-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          单位预览 · {file.split(/[\\/]/).pop()}
          {recipe.image && <code className="tool-path" style={{ marginLeft: 8 }}>{recipe.image}</code>}
        </div>
        <div className="modal-body vdiff-body">
          <div className="unitprev-toolbar">
            <span className="vdiff-hint">按 [graphics] 配方合成（帧动画/炮塔叠加/阴影/队伍着色），纯本地渲染</span>
            <span className="grow" />
            <button
              className={`btn${showSight ? ' primary' : ''}`}
              style={{ padding: '2px 10px', fontSize: 11.5 }}
              title="显示/隐藏战争迷雾视野（地块数；不代表攻击范围）"
              aria-label="显示或隐藏战争迷雾视野"
              onClick={() => setShowSight((v) => !v)}
            >
              <AppIcon name="eye" size={12} /> 视野
            </button>
            {animFrameCount > 1 && (
              <>
                <button className="icon-btn" title={playing ? '暂停' : '播放'} onClick={() => setPlaying((p) => !p)}>
                  <AppIcon name={playing ? 'pause' : 'play'} size={13} />
                </button>
                {(['idle', 'moving', 'attack'] as const).map((s) => (
                  <button
                    key={s}
                    className={`btn${animState === s ? ' primary' : ''}`}
                    style={{ padding: '1px 8px', fontSize: 11 }}
                    title={`播放 ${s === 'idle' ? '待机' : s === 'moving' ? '移动' : '攻击'}动画帧区间`}
                    onClick={() => switchAnimState(s)}
                  >
                    {s === 'idle' ? '待机' : s === 'moving' ? '移动' : '攻击'}
                  </button>
                ))}
              </>
            )}
            {isDirectional && recipe.direction && (
              <label className="vdiff-select">
                朝向
                <select value={directionIdx} onChange={(e) => setDirectionIdx(Number(e.target.value))}>
                  {Array.from({ length: dirCount }, (_, i) => (
                    <option key={i} value={i}>
                      {Math.round((recipe.direction!.starting + i * recipe.direction!.units) % 360)}°
                    </option>
                  ))}
                </select>
              </label>
            )}
            {totalFrames > 1 && !isDirectional && (
              <label className="vdiff-select">
                帧 {clampedFrame + 1}/{totalFrames}
                <input
                  type="range"
                  min={0}
                  max={totalFrames - 1}
                  value={clampedFrame}
                  onChange={(e) => {
                    setFrame(Number(e.target.value))
                    setPlaying(false)
                  }}
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
          {noGamePath.length > 0 && (
            <div className="lint-evidence">
              游戏内置引用（{noGamePath.map((f) => f.image).join('、')}）需在 设置 → 游戏 配置铁锈战争安装目录后才能加载
            </div>
          )}
          {gameMissing.length > 0 && (
            <div className="lint-evidence">
              游戏内置引用读取失败（文件可能不存在）：{gameMissing.map((f) => f.image).join('、')}
            </div>
          )}
          {localMissing.length > 0 && (
            <div className="lint-evidence">
              以下图像未找到：{localMissing.map((f) => f.image).join('、')}（图片应放在单位文件同目录或项目根下）
            </div>
          )}
          {failed.length === 0 && <div className="lint-suggestion">预览正常：{recipe.image ? `${recipe.image}（${totalFrames} 帧）` : '未配置主体图像'}{turrets.length > 0 ? ` · ${turrets.length} 个炮塔` : ''}{recipe.teamColoringMode !== 'disabled' ? ` · 队伍着色：${recipe.teamColoringMode === 'pureGreen' ? '纯绿' : recipe.teamColoringMode === 'hueAdd' ? '色相叠加' : '色相偏移'}（Canvas 近似，游戏内为 GPU 着色）` : ''}</div>}
        </div>
        <div className="modal-footer">
          <span className="vdiff-hint">单位中心为原点；视野 = 战争迷雾地块数 × 20 像素；不模拟建造视野/攻击范围</span>
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
