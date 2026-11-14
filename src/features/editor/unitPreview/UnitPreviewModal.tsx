/**
 * 单位预览渲染（M22 → M42 起改为引擎唯一路径 → M43 锈匠级实时预览）：
 * 画面只来自引擎渲染 DLC 的产出；没有可用的 DLC 就不显示预览。
 *
 * 图像来源（命名空间语义与运行前检查/官方文档一致）：
 * - 无前缀 / ROOT: / CUSTOM: → 项目内文件（readImageAsDataUrl，绝对路径）
 * - CORE: → 游戏 assets/units/ 下资源（readGameAssetImage）
 * - SHARED: → 游戏共享图库 assets/units/shared/ 下资源（readGameAssetImage）
 * - 缺图一律占位（灰块 + 名称），不报错不崩溃；加载失败原因分类提示。
 *
 * M42 引擎渲染路径（唯一路径）：
 * 用户把自己准备的渲染 DLC 放进指定目录并授权后，预览改用「引擎渲染」——
 * 由主进程调用该 DLC 拿回一张 PNG 显示。
 * 产品规则：单位渲染只允许 DLC 产出的画面；没有可用的 DLC 就不显示预览，
 * 也不回退到下面的本地合成。本地合成实现保留在文件里（未删除），由
 * ENGINE_ONLY_RENDER 显式关闭执行，避免依赖样式值这种隐式条件。
 * 界面这一层不接触任何可执行文件路径：只说「画什么」，用哪个 DLC 由主进程决定。
 *
 * M43 实时预览（对齐锈匠）：
 * - 引擎会话热渲染（~30-80ms/帧）支撑动画播放（timeMs 绝对时间轴）、队伍 0-9 换色；
 * - 阴影开关：渲染时把 image_shadow 临时替换为 NONE（patchShadowOff，零 DLC 改动）；
 * - 背景层（草/沙/海地块贴图平铺 / 无 / 棋 / 透）与叠加层（网格/炮塔标记/调试线/视野）
 *   画在引擎图之下/之上，与引擎图同尺寸同缩放；
 * - 控件收进右侧可折叠面板，工具栏只留「面板」开关与缩放（悬浮窗/模态共用）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getBridge } from '../../../services/bridge'
import { AppIcon } from '../../../components/AppIcon'
import { FloatingWindow } from '../../../components/FloatingWindow'
import { useEscapeHandler } from '../../../utils/modalStack'
import type { EngineDlcSessionFrame } from '../../../types/bridge'
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
  patchShadowOff,
  resolveImageCandidates,
  type TeamColoringMode,
} from './recipe'
import { selectEnabledRendererAdapter } from '../../plugins/rendererSelection'
import { registeredAdapterIds } from '../../plugins/adapterRegistry'
import { runRendererAdapter } from '../../plugins/adapterRegistry'
import {
  BUILTIN_PREVIEW_ADAPTER_ID,
  buildPreviewScene,
  executePreviewCommands,
  sceneResources,
  sceneToRenderResult,
  type PreviewDrawInput,
  type PreviewEffect,
} from './compositor'

interface Props {
  file: string
  content: string
  rootPath: string
  /** 配置的游戏安装路径（可为空：CORE:/SHARED: 官方贴图无法加载，显示占位） */
  gamePath?: string
  /** 中文显示层回译（[图像组]/主体图像 → graphics/image）；英文模式可不传 */
  zhToEn?: (s: string) => string | undefined
  onClose: () => void
  /** 悬浮窗形态（可拖动小窗，与代码并排看）；默认居中模态弹窗 */
  floating?: boolean
}

/**
 * 单位预览只使用 DLC 渲染：置 true 时本地合成 effect 直接返回，旧合成代码只是
 * 保留在文件里、不参与执行。不要用 canvas 的 CSS 显示状态代替这个开关——
 * 样式只负责布局，改样式不应改变渲染行为。
 */
const ENGINE_ONLY_RENDER = true

/** 引擎画布尺寸（引擎图 / 背景层 / 叠加层三者同尺寸，CSS 同步缩放） */
const CANVAS_W = 560
const CANVAS_H = 420
/** 引擎播放目标帧间隔（热会话 ~30-80ms/帧；66ms ≈ 15fps 上限，渲染慢时按真实耗时推进） */
const ENGINE_FRAME_INTERVAL = 66
/** 无 direction 配置时引擎默认 45°/步（direction_units 缺省值） */
const DEFAULT_DIRECTION_STEP = 45
/** 引擎原版十色队伍（EngineRender initializeTeamPalette 同源，队伍 0-9） */
const TEAM_NAMES = ['绿', '红', '蓝', '黄', '青', '白', '黑', '粉', '橙', '紫']

/** 背景（M43/M45）：草/沙/海/雪/石优先用 DLC 提供的 20px 地块贴图（锈匠同源），
 *  DLC 缺失时回退游戏地块贴图（需配置游戏目录），再缺就回退纯色；无=纯深色；棋=棋盘格；透=透明 */
type BackgroundTileKind = 'grass' | 'sand' | 'sea' | 'snow' | 'stone'
type BackgroundKind = BackgroundTileKind | 'none' | 'checker' | 'transparent'
const BACKGROUND_TILE_KINDS: BackgroundTileKind[] = ['grass', 'sand', 'sea', 'snow', 'stone']
const BACKGROUND_TILES: Record<BackgroundTileKind, { path: string; fallback: string }> = {
  grass: { path: 'assets/tilesets/bitmaps/longgrass.png', fallback: '#3f7a33' },
  sand: { path: 'assets/tilesets/bitmaps/sand.png', fallback: '#c9b787' },
  sea: { path: 'assets/tilesets/bitmaps/deepwater.png', fallback: '#1d5fa8' },
  snow: { path: 'assets/tilesets/bitmaps/snow.png', fallback: '#dfe8ee' },
  stone: { path: 'assets/tilesets/bitmaps/stone.png', fallback: '#8d8d8d' },
}

/** 引擎渲染回传的叠加层元数据（炮塔锚点/坐标映射；旧 DLC 冷路径没有） */
interface EngineMeta {
  turrets?: EngineDlcSessionFrame['turrets']
  coordinateMapping?: EngineDlcSessionFrame['coordinateMapping']
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
 * M41 起由两条路径共用：本地合成路径直接调用；指令路径由 compositor 按场景声明的
 * effect 施加同一组滤镜，保证两条路径着色一致。
 * - pureGreen：灰阶 → 棕 → 色相转到绿（官方 pureGreenTeamColor.frag 的近似）
 * - hueShift：整体色相偏移到默认队伍绿 120°
 * - hueAdd：绘制后以 'color' 混合模式叠加绿色（调用方处理，需图像区域矩形）
 */
function applyTeamColor(ctx: CanvasRenderingContext2D, mode: TeamColoringMode): void {
  if (mode === 'pureGreen') {
    ctx.filter = 'grayscale(1) sepia(1) hue-rotate(75deg) saturate(5)'
  } else if (mode === 'hueShift') {
    ctx.filter = 'hue-rotate(120deg)'
  }
  // hueAdd 由调用方在 drawImage 后叠加（需要图像区域矩形）
}

/** 单位合成预览器（默认居中模态；floating=true 时为可拖动悬浮窗） */
export function UnitPreviewModal({ file, content, rootPath, gamePath, zhToEn, onClose, floating = false }: Props) {
  useEscapeHandler(onClose, !floating)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 背景层（引擎图之下）：草/沙/海贴图平铺 / 纯色 / 棋盘格 */
  const backCanvasRef = useRef<HTMLCanvasElement>(null)
  /** 叠加层（引擎图之上）：网格 / 炮塔标记 / 调试线 / 视野圈 */
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [images, setImages] = useState<Map<string, HTMLImageElement | null>>(new Map())
  const [frame, setFrame] = useState(0)
  const [showWreck, setShowWreck] = useState(false)
  const [showSight, setShowSight] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [failed, setFailed] = useState<Array<{ image: string; reason: FailReason }>>([])
  // M41：当前实际走的渲染路径（用于界面标注「精确渲染（插件）」/「本地渲染（内置）」）
  const [renderPath, setRenderPath] = useState<{ pluginId: string | null; usedFallback: boolean; reason?: string }>({
    pluginId: null,
    usedFallback: false,
  })
  // M34 动画播放：播放中 / 当前动画状态（待机/移动/攻击）
  const [playing, setPlaying] = useState(true)
  const [animState, setAnimState] = useState<'idle' | 'moving' | 'attack'>('idle')
  /** M44 连续旋转角度（度，顺时针，相对「方向 0」）；引擎只按最近方向档出图，残余角度由贴图旋转补齐 */
  const [angleDeg, setAngleDeg] = useState(0)
  const elapsedRef = useRef(0)
  const lastTsRef = useRef<number | null>(null)

  // ── M43 实时预览新增状态 ──
  /** 右侧控制面板开关（工具栏「面板」按钮切换） */
  const [panelOpen, setPanelOpen] = useState(true)
  /** 队伍号：-1 = 默认贴图，0..9 = 引擎原版十色 */
  const [team, setTeam] = useState(-1)
  /** 阴影开关：false = 渲染时把 image_shadow 临时替换为 NONE（不改编辑器内容） */
  const [showShadow, setShowShadow] = useState(true)
  /** 叠加层开关 */
  const [showTurretMarks, setShowTurretMarks] = useState(false)
  const [showDebugLines, setShowDebugLines] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [background, setBackground] = useState<BackgroundKind>('checker')
  /** 背景「草/沙/海/雪/石」的地块贴图（记录来源：DLC/游戏；切背景后旧贴图按种类失配 → 派生为 null 回退纯色） */
  const [tileState, setTileState] = useState<{ kind: BackgroundTileKind; img: HTMLImageElement | null } | null>(null)
  /** 引擎回传的炮塔锚点/坐标映射（叠加层用；null = 旧 DLC 冷路径没有） */
  const [engineMeta, setEngineMeta] = useState<EngineMeta | null>(null)

  // ── M42 引擎渲染路径（可选）：没有已授权的 DLC 时整块保持关闭，行为与从前一致 ──
  /** 可用的引擎 DLC 名字；null = 没有可用 DLC（此时界面不显示任何引擎相关控件） */
  const [engineDlcName, setEngineDlcName] = useState<string | null>(null)
  /** 用户是否选择了引擎渲染 */
  const [engineMode, setEngineMode] = useState(false)
  /** 引擎渲染产出的 PNG（data URL） */
  const [engineImage, setEngineImage] = useState<string | null>(null)
  /** 引擎渲染的进行中/回退说明（null = 一切正常） */
  const [engineNote, setEngineNote] = useState<string | null>(null)
  const engineSeqRef = useRef(0)

  // ── M44 平滑旋转（对齐锈匠观感）：连续角度 + 缓动 + 拖拽 + 自转 ──
  /** 旋转动画目标角度（null = 不在动画中）；点击 ◀▶ 走缓动，拖动/滑杆直接落值 */
  const [angleTarget, setAngleTarget] = useState<number | null>(null)
  /** 自动旋转（演示/看整体轮廓） */
  const [spin, setSpin] = useState(false)
  /** 0.2.3+ DLC：引擎原生任意角度渲染（无位图重采样；否则用贴图残余旋转兜底） */
  const [nativeAngleCapable, setNativeAngleCapable] = useState(false)
  /** 机体不随角度旋转的单位：
   *  - lock_body_rotation_with_main_turret:true（机体锁定主炮塔角度）
   *  - rotate_with_direction:false（原版"单位图像锁定 0 度"开关）
   *  这类单位交给引擎按 angle 渲染也不会转，继续用贴图残余旋转兜底。 */
  const bodyRotationLocked = /lock_body_rotation_with_main_turret\s*[:=]\s*true/i.test(content)
    || /rotate_with_direction\s*[:=]\s*false/i.test(content)
  /** 空闲状态下要请求引擎渲染的角度（松手/动画结束/滑杆松开时更新，避免拖动时每帧重渲染） */
  const [angleRequest, setAngleRequest] = useState(0)
  /** 当前这张引擎图实际渲染时的角度（CSS 残余旋转 = 当前角度 - 它；只在渲染成功回调里更新，不进 effect 依赖） */
  const [nativeRenderedAngle, setNativeRenderedAngle] = useState(0)
  /** 原生角度校验失败（会话回退冷路径/引擎没应用 angle）：改回贴图残余旋转，避免"转了个寂寞" */
  const [nativeAngleBroken, setNativeAngleBroken] = useState(false)
  /** 当前连续角度（rAF 动画读取，避免闭包旧值） */
  const angleRef = useRef(0)
  /** 画面拖拽旋转的起点 */
  const dragRef = useRef<{ startX: number; startAngle: number } | null>(null)

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
  // 背景贴图派生值：归属种类与当前背景一致才生效（切背景瞬间旧贴图自动失配回退纯色）
  const tileImg = tileState && tileState.kind === background ? tileState.img : null
  // 多向动画：方向块单帧，帧播放器停用（方向切换代替帧滑块）
  const dirCount = directionCount(recipe.direction)
  const isDirectional = dirCount > 1
  const animFrameCount = isDirectional ? 1 : frameInfo.count
  // M44 连续旋转：引擎只认「方向档序号」，一步 = direction.units 度（缺省 45°）
  const dirStep = recipe.direction && recipe.direction.units > 0 ? recipe.direction.units : DEFAULT_DIRECTION_STEP
  const dirStarting = Math.round(recipe.direction?.starting ?? 0)
  /** 引擎方向档序号：连续角度取最近档（跨档才重渲染引擎，其余由贴图残余旋转补齐） */
  const dirFrame = isDirectional && dirCount > 0
    ? ((Math.round(angleDeg / dirStep) % dirCount) + dirCount) % dirCount
    : 0
  /** 显示角度（含 INI starting 偏移），1° 精度 */
  const dirDegrees = ((dirStarting + angleDeg) % 360 + 360) % 360
  /** 实际生效的原生角度：DLC 支持 且 单位机体允许随角度旋转 且 校验未失败 */
  const nativeAngleActive = nativeAngleCapable && !bodyRotationLocked && !nativeAngleBroken
  /** 贴图残余旋转：原生角度下 = 当前角度 - 已渲染角度；旧 DLC/锁机体 = 当前角度 - 方向档角度 */
  const residualDeg = nativeAngleActive
    ? angleDeg - nativeRenderedAngle
    : isDirectional ? angleDeg - dirFrame * dirStep : angleDeg
  /** 单位在引擎图里的原点（贴图旋转中心；无 meta 回退画布中心） */
  const originX = engineMeta?.coordinateMapping?.originX ?? CANVAS_W / 2
  const originY = engineMeta?.coordinateMapping?.originY ?? CANVAS_H / 2

  /** 旋转一步：平滑缓动到目标（连续点击可累积） */
  const rotateStep = (steps: number) => {
    setSpin(false)
    const delta = steps * (isDirectional ? dirStep : 15)
    setAngleTarget((prev) => (prev == null ? angleRef.current + delta : prev + delta))
  }

  /** 直接落值（滑杆/拖拽）：同步 ref、取消动画 */
  const setAngleImmediate = (next: number) => {
    setSpin(false)
    setAngleTarget(null)
    angleRef.current = next
    setAngleDeg(next)
  }

  // M34 播放器（本地合成路径用）：rAF 累计时长 → animationFrameNumber 计算当前帧。
  // 帧区间/速度/往返（animation_idle/moving/attack_*）按配方播放；无配置时整序列循环。
  // 引擎模式不走这条：播放由下方引擎渲染 effect 内的 timeMs 循环驱动。
  useEffect(() => {
    if (!playing || animFrameCount <= 1 || engineMode) return
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
  }, [playing, animState, animFrameCount, recipe.animations, engineMode])

  /** 切换动画状态：重置播放计时（避免状态切换瞬间跳帧） */
  const switchAnimState = (s: 'idle' | 'moving' | 'attack') => {
    elapsedRef.current = 0
    setAnimState(s)
    setFrame(0)
    setPlaying(true)
  }

  // M42：进弹窗时问一次主进程「有没有可用的引擎 DLC」。
  // 没有（未安装/未授权/清单不合法）就整块关掉——界面连开关都不显示。
  useEffect(() => {
    const api = getBridge().engineDlc
    if (!api) return
    let alive = true
    void api
      .list()
      .then((result) => {
        if (!alive) return
        const ready = result.dlcs.find((item) => item.runnable)
        setEngineDlcName(ready ? ready.name || ready.id : null)
        setEngineMode(Boolean(ready))
        setNativeAngleCapable(Boolean(ready?.angle))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // M43：引擎模式渲染（播放与静态合一）。
  // 播放 = timeMs 绝对时间轴循环：上一帧渲染完成后再请求下一帧（天然节流，
  // 热会话 ~30-80ms/帧），时钟按真实耗时推进（渲染慢动画速度不漂移）；
  // 暂停/拖滑块 = 静态帧（frame，timeMs 缺省）。任一视图参数变化都会重启循环。
  useEffect(() => {
    const api = getBridge().engineDlc
    if (!engineMode || !api || !engineDlcName) return
    let alive = true
    /** 在途请求 id（清理时取消，防止旧参数渲染结果覆盖新参数） */
    let inflightId: string | null = null
    // 阴影开关的零 DLC 改动实现：只改发给引擎的内容副本
    const unitContent = showShadow ? content : patchShadowOff(content)
    /** 0.2.3+：本次请求要用的原生角度（播放时跟随实时角度；暂停时用空闲角度） */
    const angleForRequest = (): number | null => {
      if (!nativeAngleActive) return null
      return playing ? angleRef.current : angleRequest
    }
    const renderOnce = async (timeMs: number | null): Promise<boolean> => {
      const seq = ++engineSeqRef.current
      const requestId = crypto.randomUUID()
      inflightId = requestId
      const requestedAngle = angleForRequest()
      try {
        const result = await api.render({
          requestId,
          unitFile: file,
          unitContent,
          projectRoot: rootPath,
          gamePath: gamePath ?? '',
          frame: clampedFrame,
          timeMs,
          team,
          includeMeta: true,
          direction: dirFrame,
          ...(requestedAngle === null ? {} : { angle: requestedAngle }),
          animationState: animState,
          showWreck,
          width: CANVAS_W,
          height: CANVAS_H,
        })
        if (!alive || seq !== engineSeqRef.current) return false
        if (result.ok) {
          // 记下这张图对应的角度：CSS 残余旋转 = 当前角度 - 它（原生角度下通常为 0）
          if (requestedAngle !== null) {
            setNativeRenderedAngle(requestedAngle)
            // 校验引擎确实按该角度渲染（冷路径回退/引擎忽略角度时 bodyAngle 缺失或不符）
            const reported = result.bodyAngle
            const normalizedDiff = typeof reported === 'number'
              ? Math.abs((((reported - requestedAngle) % 360) + 540) % 360 - 180)
              : Number.POSITIVE_INFINITY
            if (normalizedDiff > 1) setNativeAngleBroken(true)
          }
          setEngineImage(result.dataUrl)
          setEngineMeta({ turrets: result.turrets, coordinateMapping: result.coordinateMapping })
          setEngineNote(null)
          return true
        }
        // result.ok 已在上面返回；这里只剩失败分支
        // 引擎没有该状态的时间线关键帧（如 total_frames:1 的单位点「移动/攻击」）：
        // 退回静态帧，不当作错误刷屏
        if (result.reason.includes('时间线动画状态')) {
          setPlaying(false)
          setEngineNote(null)
          return false
        }
        setEngineNote(`引擎渲染失败，本次未生成预览：${result.reason}`)
        return false
      } catch (error) {
        if (!alive || seq !== engineSeqRef.current) return false
        setEngineNote(`引擎渲染失败，本次未生成预览：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }
    // 残骸/单帧单位是静态贴图：引擎会话不接受「残骸 + timeMs」，单帧单位也没有时间线关键帧，
    // 这里都强制走静态帧（避免每帧回退冷路径）
    if (!playing || showWreck || animFrameCount <= 1) {
      void renderOnce(null)
      return () => {
        alive = false
        if (inflightId) void api.cancel(inflightId).catch(() => undefined)
      }
    }
    let clock = 0
    void (async () => {
      while (alive) {
        const started = performance.now()
        const ok = await renderOnce(Math.round(clock))
        if (!alive) return
        // 失败一次即停（提示已给出），避免错误风暴刷屏
        if (!ok) break
        clock += Math.max(ENGINE_FRAME_INTERVAL, performance.now() - started)
      }
    })()
    return () => {
      alive = false
      if (inflightId) void api.cancel(inflightId).catch(() => undefined)
    }
  }, [engineMode, engineDlcName, file, content, rootPath, gamePath, clampedFrame, dirFrame, animState, showWreck, showShadow, team, playing, nativeAngleActive, angleRequest, animFrameCount])

  // M43/M45 背景贴图：草/沙/海/雪/石 优先由 DLC 提供（0.2.4+，20px 地块贴图，锈匠同源），
  // DLC 没有该贴图时回退游戏地块；两者都取不到 → 派生 null 回退纯色。
  useEffect(() => {
    if (!BACKGROUND_TILE_KINDS.includes(background as BackgroundTileKind)) return
    const kind = background as BackgroundTileKind
    let alive = true
    void (async () => {
      // 1) DLC 提供（不需要用户配置游戏目录）
      try {
        const fromDlc = await getBridge().engineDlc?.background?.(kind)
        if (alive && fromDlc?.ok) {
          const img = await loadImage(fromDlc.dataUrl)
          if (alive && img) { setTileState({ kind, img }); return }
        }
      } catch {
        // 继续走游戏回退
      }
      if (!alive) return
      // 2) 游戏地块（需配置游戏目录）
      if (!gamePath) {
        setTileState({ kind, img: null })
        return
      }
      try {
        const url = await getBridge().game.readAssetImage(gamePath, BACKGROUND_TILES[kind].path)
        const img = await loadImage(url)
        if (alive) setTileState(img ? { kind, img } : { kind, img: null })
      } catch {
        // 读取失败 → 派生 null 回退纯色
        if (alive) setTileState({ kind, img: null })
      }
    })()
    return () => {
      alive = false
    }
  }, [background, gamePath, engineDlcName])

  // M43 背景层绘制：画布坐标与引擎图一致（CSS 同步缩放）
  useEffect(() => {
    const canvas = backCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (background === 'transparent') return
    if (background === 'none') {
      ctx.fillStyle = '#181a20'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return
    }
    if (background === 'checker') {
      const SIZE = 12
      ctx.fillStyle = 'rgba(128,128,128,0.15)'
      for (let y = 0; y < canvas.height; y += SIZE) {
        for (let x = 0; x < canvas.width; x += SIZE) {
          if ((x / SIZE + y / SIZE) % 2 === 0) ctx.fillRect(x, y, SIZE, SIZE)
        }
      }
      return
    }
    // 草/沙/海：地块贴图平铺；无贴图（未配置游戏路径/读取失败）回退纯色
    const def = BACKGROUND_TILES[background]
    if (tileImg) {
      const w = tileImg.naturalWidth || 20
      const h = tileImg.naturalHeight || 20
      for (let y = 0; y < canvas.height; y += h) {
        for (let x = 0; x < canvas.width; x += w) {
          ctx.drawImage(tileImg, x, y, w, h)
        }
      }
    } else {
      ctx.fillStyle = def.fallback
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }, [background, tileImg])

  // M43 叠加层绘制：网格 / 炮塔标记 / 调试线 / 视野圈。
  // 坐标 = 引擎图像素坐标（与引擎图同缩放），锚点优先用引擎回传的真实像素位置。
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const mapping = engineMeta?.coordinateMapping
    // 单位中心：引擎坐标映射原点；无 meta 回退画布中心
    const cx = mapping?.originX ?? canvas.width / 2
    const cy = mapping?.originY ?? canvas.height / 2

    if (showGrid) {
      // 1 tile = 20 world 单位；pixelsPerUnit 来自引擎相机映射（无 meta 按 20px 兜底）
      const stepPx = Math.max(4, Math.round(mapping?.pixelsPerUnit ?? 20))
      ctx.strokeStyle = 'rgba(127,127,127,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = cx % stepPx; x <= canvas.width; x += stepPx) {
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, canvas.height)
      }
      for (let y = cy % stepPx; y <= canvas.height; y += stepPx) {
        ctx.moveTo(0, y + 0.5)
        ctx.lineTo(canvas.width, y + 0.5)
      }
      ctx.stroke()
    }

    if (showSight) {
      const sight = computeSightGeometry(recipe, canvas.width, canvas.height, 1)
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

    // 炮塔锚点：引擎回传优先（真实像素位置，误差 ≤0.34px）；无 meta 回退本地 INI 估算
    const anchors: Array<{ x: number; y: number; label: string }> = []
    if (engineMeta?.turrets?.length) {
      for (const t of engineMeta.turrets) anchors.push({ x: t.imageX, y: t.imageY, label: String(t.index) })
    } else {
      const scale = 2 // 与本地合成的基础放大一致（zoom 由 CSS 同步作用于两层）
      for (const item of computeDrawLayout(recipe, turrets)) {
        if (item.kind !== 'turret') continue
        anchors.push({ x: cx + item.cx * scale, y: cy + item.cy * scale, label: '?' })
      }
    }
    // M44 平滑旋转：锚点是「方向档贴图坐标」，贴图又转了残余角度 → 锚点跟着绕单位原点转
    const residualRad = (residualDeg * Math.PI) / 180
    const placedAnchors = residualDeg === 0 ? anchors : anchors.map((a) => {
      const dx = a.x - originX
      const dy = a.y - originY
      return {
        ...a,
        x: originX + dx * Math.cos(residualRad) - dy * Math.sin(residualRad),
        y: originY + dx * Math.sin(residualRad) + dy * Math.cos(residualRad),
      }
    })

    if (showDebugLines) {
      // 调试线：单位中心十字 + 中心→炮塔锚点连线 + 朝向箭头（0°=+X 右，顺时针）
      ctx.save()
      ctx.strokeStyle = 'rgba(56,189,248,0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx - 10, cy)
      ctx.lineTo(cx + 10, cy)
      ctx.moveTo(cx, cy - 10)
      ctx.lineTo(cx, cy + 10)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(56,189,248,0.55)'
      ctx.beginPath()
      for (const a of placedAnchors) {
        ctx.moveTo(cx, cy)
        ctx.lineTo(a.x, a.y)
      }
      ctx.stroke()
      // 朝向箭头（度数与引擎一致：贴图 0° 指向 +X，正值顺时针）
      const rad = (dirDegrees * Math.PI) / 180
      const len = 44
      const ax = cx + Math.cos(rad) * len
      const ay = cy + Math.sin(rad) * len
      ctx.strokeStyle = '#facc15'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(ax, ay)
      ctx.moveTo(ax - Math.cos(rad - 0.5) * 8, ay - Math.sin(rad - 0.5) * 8)
      ctx.lineTo(ax, ay)
      ctx.lineTo(ax - Math.cos(rad + 0.5) * 8, ay - Math.sin(rad + 0.5) * 8)
      ctx.stroke()
      ctx.restore()
    }

    if (showTurretMarks) {
      ctx.save()
      for (const a of placedAnchors) {
        ctx.strokeStyle = '#f59e0b'
        ctx.fillStyle = 'rgba(245,158,11,0.2)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(a.x, a.y, 9, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#fbbf24'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(a.label, a.x, a.y - 12)
      }
      ctx.restore()
    }
  }, [engineMeta, showGrid, showSight, showTurretMarks, showDebugLines, dirDegrees, residualDeg, originX, originY, recipe, turrets])

  // 加载全部引用图像（主体多帧/阴影/炮塔/残骸去重；本地合成与占位提示共用）
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

  // ── M44 平滑旋转：缓动 / 自转 / 引擎方向档同步（都放在本地合成 effect 之前，保持其仍是最后一个 effect） ──

  // 点击 ◀▶ 后从当前角度平滑过渡到目标（180ms ease-out），中间角度由贴图残余旋转补齐
  useEffect(() => {
    if (angleTarget == null) return
    const from = angleRef.current
    const delta = angleTarget - from
    if (Math.abs(delta) < 0.01) {
      setAngleTarget(null)
      setAngleRequest(angleRef.current)
      return
    }
    const started = performance.now()
    let raf = 0
    const step = (ts: number) => {
      const t = Math.min(1, (ts - started) / 180)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = from + delta * eased
      angleRef.current = next
      setAngleDeg(next)
      if (t < 1) raf = requestAnimationFrame(step)
      else {
        setAngleTarget(null)
        // 动画结束：让 0.2.3+ 引擎按最终角度原生重渲染一帧（残余旋转归零 → 像素清晰）
        setAngleRequest(angleRef.current)
      }
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [angleTarget])

  // 自动旋转：60°/s 连续转动
  useEffect(() => {
    if (!spin) return
    let raf = 0
    let last: number | null = null
    const loop = (ts: number) => {
      if (last == null) last = ts
      const dt = Math.min(100, ts - last)
      last = ts
      angleRef.current += dt * 0.06
      setAngleDeg(angleRef.current)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [spin])

  // 引擎方向档由 angleDeg 派生（见上方 dirFrame），不需要额外 effect 同步。
  // M41 渲染器插件化（方案乙·零回归双路径）：
  // - 无插件，或插件执行失败 → 走本文件内的 drawLocalComposite()，与改动前逐像素一致；
  // - 插件执行成功 → 走 rendererAdapter 受限指令路径落地。
  // 两条路径着色规则共用 applyTeamColor / compositor，避免规则漂移。
  // 安全边界：插件只能引用场景声明的资源 id；effect 由宿主在场景资源上声明，
  //           插件无法注入滤镜、混合模式或任意绘制 API。
  useEffect(() => {
    const canvas = canvasRef.current
    // 保留旧合成实现，但单位预览只允许 DLC 产出的画面。
    if (ENGINE_ONLY_RENDER || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let alive = true
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
      // 这里不 setState：effect 体内同步 setState 会触发级联渲染（react-hooks/set-state-in-effect）。
      // 初始状态已是「本地内置」，缺主体图时界面无需改标。
      drawPlaceholder(ctx, canvas.width / 2, canvas.height / 2, '未配置主体图像')
      return
    }
    const fi = frameInfo
    const scale = 2 * zoom // 基础 2 倍放大便于观察
    const cx = canvas.width / 2
    const cy = canvas.height / 2
    const items = computeDrawLayout(recipe, turrets).filter((i) => (i.kind === 'wreck' ? showWreck : true))
    const teamMode = recipe.teamColoringMode
    // AUTO 阴影才做剪影；文件型阴影（imageShadow 非 AUTO）不套滤镜也不随队伍着色
    const autoShadow = Boolean(recipe.imageShadow && /^AUTO/i.test(recipe.imageShadow))

    /** 本地合成（内置渲染器本体）：改动前的绘制循环原样保留，保证零回归 */
    const drawLocalComposite = (): void => {
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
          ? directionSourceRect(recipe.direction!, dirFrame, img.naturalWidth, img.naturalHeight)
          : undefined
        const geometry = computeDrawGeometry(item, img.naturalWidth, img.naturalHeight, fi, clampedFrame, scale, directionRect)
        const { sx, sy, sw, sh } = geometry.source
        const { dx, dy, dw, dh } = geometry.destination
        const drawX = cx + dx
        const drawY = cy + dy
        ctx.save()
        ctx.globalAlpha = item.alpha
        if (item.kind === 'shadow' && autoShadow) {
          // AUTO 阴影：主图剪影（黑色半透明）——不随队伍着色
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
    }

    // 有插件：先组建冻结场景（纯数据）再交给扩展点执行
    const draws: PreviewDrawInput[] = []
    const missingItems: typeof items = []
    for (const item of items) {
      let imgKey = item.image
      if (item.kind === 'body' && recipe.imageFrames?.length) {
        imgKey = recipe.imageFrames[clampedFrame] ?? item.image
      }
      const img = imgKey ? images.get(imgKey) : undefined
      if (!img || !imgKey) {
        missingItems.push(item)
        continue
      }
      const directionRect = isDirectional && item.sourceMode === 'bodyFrames'
        ? directionSourceRect(recipe.direction!, dirFrame, img.naturalWidth, img.naturalHeight)
        : undefined
      const geometry = computeDrawGeometry(item, img.naturalWidth, img.naturalHeight, fi, clampedFrame, scale, directionRect)
      const { sx, sy, sw, sh } = geometry.source
      const { dx, dy, dw, dh } = geometry.destination
      const effect: PreviewEffect = item.kind === 'shadow'
        ? (autoShadow ? 'shadow' : 'none')
        : teamMode === 'disabled' ? 'none' : 'teamColor'
      draws.push({
        ref: imgKey,
        offsetX: dx,
        offsetY: dy,
        width: dw,
        height: dh,
        sourceX: sx,
        sourceY: sy,
        sourceWidth: sw,
        sourceHeight: sh,
        alpha: item.alpha,
        effect,
      })
    }
    const scene = buildPreviewScene({
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      teamColorMode: teamMode,
      draws,
    })
    void (async () => {
      // 注册实现不代表启用；从持久化声明读取能力，读取失败时保持本地预览可用。
      const raw = await getBridge().store.get('plugins').catch(() => null)
      if (!alive) return
      const adapter = selectEnabledRendererAdapter(raw, registeredAdapterIds(), BUILTIN_PREVIEW_ADAPTER_ID)
      if (!adapter) {
        drawLocalComposite()
        setRenderPath({ pluginId: null, usedFallback: false })
        return
      }
      const execution = await runRendererAdapter(adapter.pluginId, scene, sceneToRenderResult(scene), {
        resources: sceneResources(scene),
        adapter: {
          allowedCommands: adapter.allowedCommands,
          resourceIds: adapter.resourceIds,
          maxCommands: adapter.maxCommands,
          maxResponseBytes: adapter.maxResponseBytes,
        },
      })
      if (!alive) return
      if (execution.usedFallback) {
        // 插件不可用 → 回退本地合成本体。刻意不使用指令形式的结果：本地合成与指令表达
        // 在缺图占位等边界上有顺序差异，直接重跑原循环才能保证「回退后与无插件逐像素一致」。
        drawLocalComposite()
        setRenderPath({ pluginId: null, usedFallback: true, reason: execution.reason })
        return
      }
      executePreviewCommands(ctx, execution.result, scene, (ref) => images.get(ref) ?? null)
      // 缺图提示由宿主覆盖在插件结果之上，按配方顺序绘制，避免被插件图像遮住。
      for (const item of missingItems) {
        drawPlaceholder(ctx, cx + item.cx * scale, cy + item.cy * scale, item.placeholder, item.kind === 'turret' ? 28 : 34)
      }
      setRenderPath({ pluginId: execution.executedPluginId, usedFallback: false })
    })()
    return () => {
      alive = false
    }
  }, [images, frameInfo, clampedFrame, showWreck, showSight, zoom, recipe, turrets, mainImgOrNull, isDirectional, dirFrame])

  const noGamePath = failed.filter((f) => f.reason === 'no-game-path')
  const gameMissing = failed.filter((f) => f.reason === 'game-missing')
  const localMissing = failed.filter((f) => f.reason === 'local-missing')
  const totalFrames = frameInfo.count
  void renderPath

  const fileName = file.split(/[\\/]/).pop()
  const layerSize = { width: CANVAS_W * zoom, height: CANVAS_H * zoom }

  /** 控制面板（M43）：动画/旋转/叠加/背景/队伍。悬浮窗与模态共用。 */
  const panel = (
    <div className="unitprev-panel">
      <div className="unitprev-panel-title">动画</div>
      <div className="unitprev-panel-row">
        <button className="icon-btn" title={playing ? '暂停' : '播放'} onClick={() => setPlaying((p) => !p)}>
          <AppIcon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        {(['idle', 'moving', 'attack'] as const).map((s) => (
          <button
            key={s}
            className={`btn${animState === s ? ' primary' : ''}`}
            style={{ padding: '1px 8px', fontSize: 12 }}
            title={`播放 ${s === 'idle' ? '待机' : s === 'moving' ? '移动' : '攻击'}动画帧区间`}
            onClick={() => switchAnimState(s)}
          >
            {s === 'idle' ? '待机' : s === 'moving' ? '移动' : '攻击'}
          </button>
        ))}
      </div>
      {totalFrames > 1 && !isDirectional && (
        <label className="vdiff-select unitprev-panel-row">
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
            style={{ width: 130 }}
          />
        </label>
      )}
      <div className="unitprev-panel-title">旋转{nativeAngleActive ? ' · 引擎原生角度' : ''}</div>
      <div className="unitprev-panel-row">
        <button className="icon-btn" title="逆时针旋转一步（平滑缓动）" onClick={() => rotateStep(-1)}>
          ◀
        </button>
        <span className="vdiff-hint" style={{ minWidth: 46, textAlign: 'center' }}>{Math.round(dirDegrees)}°</span>
        <button className="icon-btn" title="顺时针旋转一步（平滑缓动）" onClick={() => rotateStep(1)}>
          ▶
        </button>
        <button
          className={`btn${spin ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="自动旋转（连续转动观察轮廓）"
          onClick={() => {
            const next = !spin
            setSpin(next)
            // 停止自转：让引擎按当前角度原生重渲染一帧
            if (!next) setAngleRequest(angleRef.current)
          }}
        >
          自转
        </button>
      </div>
      <div className="unitprev-panel-row">
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={Math.round(dirDegrees) % 360}
          title="拖动精确旋转（1°）；也可以在画面上直接拖拽"
          onChange={(e) => {
            const value = ((Number(e.target.value) - dirStarting) % 360 + 360) % 360
            setAngleImmediate(value)
          }}
          // 松手/键盘松开后再让 0.2.3+ 引擎按最终角度原生重渲染（拖动过程用贴图残余旋转保持跟手）
          onPointerUp={() => setAngleRequest(angleRef.current)}
          onKeyUp={() => setAngleRequest(angleRef.current)}
          style={{ width: '100%' }}
        />
      </div>
      {isDirectional && recipe.direction && (
        <div className="unitprev-panel-row vdiff-hint" style={{ fontSize: 11 }}>
          方向档 {dirFrame + 1}/{dirCount}（每档 {Math.round(dirStep)}°，中间角度由贴图旋转补齐）
        </div>
      )}
      <div className="unitprev-panel-title">叠加</div>
      <div className="unitprev-panel-row">
        <button
          className={`btn${showShadow ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="显示/隐藏单位阴影（渲染时临时关闭 image_shadow，不改文件）"
          onClick={() => setShowShadow((v) => !v)}
        >
          阴影
        </button>
        <button
          className={`btn${showTurretMarks ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="标记炮塔锚点（引擎真实像素位置）"
          onClick={() => setShowTurretMarks((v) => !v)}
        >
          标记炮塔
        </button>
        <button
          className={`btn${showDebugLines ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="调试线：中心十字 + 炮塔连线 + 朝向箭头"
          onClick={() => setShowDebugLines((v) => !v)}
        >
          调试线
        </button>
        <button
          className={`btn${showGrid ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="20px 地块网格"
          onClick={() => setShowGrid((v) => !v)}
        >
          网格
        </button>
        <button
          className={`btn${showSight ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="显示/隐藏战争迷雾视野（地块数；不代表攻击范围）"
          onClick={() => setShowSight((v) => !v)}
        >
          视野
        </button>
        <button
          className={`btn${showWreck ? ' primary' : ''}`}
          style={{ padding: '1px 8px', fontSize: 12 }}
          title="显示残骸贴图（残骸是静态帧；打开后会暂停动画播放）"
          onClick={() => {
            const next = !showWreck
            setShowWreck(next)
            // 引擎会话不接受「残骸 + 动画时间轴」组合，打开残骸时自动暂停
            if (next) setPlaying(false)
          }}
        >
          残骸
        </button>
      </div>
      <div className="unitprev-panel-title">背景</div>
      <div className="unitprev-panel-row">
        {([
          ['grass', '草'],
          ['sand', '沙'],
          ['sea', '海'],
          ['snow', '雪'],
          ['stone', '石'],
          ['none', '无'],
          ['checker', '棋'],
          ['transparent', '透'],
        ] as const).map(([kind, label]) => (
          <button
            key={kind}
            className={`btn${background === kind ? ' primary' : ''}`}
            style={{ padding: '1px 8px', fontSize: 12 }}
            title={
              BACKGROUND_TILE_KINDS.includes(kind as BackgroundTileKind)
                ? `${label}地块贴图平铺（优先用 DLC 内置贴图，锈匠同源；无 DLC 贴图回退游戏地块）`
                : kind === 'none' ? '纯色底' : kind === 'checker' ? '棋盘格（透明底可见）' : '透明底'
            }
            onClick={() => setBackground(kind as BackgroundKind)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="unitprev-panel-title">队伍</div>
      <div className="unitprev-panel-row">
        <button className="icon-btn" title="上一个队伍" onClick={() => setTeam((t) => (t <= -1 ? 9 : t - 1))}>
          ◀
        </button>
        <span className="vdiff-hint" style={{ minWidth: 88, textAlign: 'center' }}>
          {team < 0 ? '默认贴图' : `队伍 ${team}（${TEAM_NAMES[team]}）`}
        </span>
        <button className="icon-btn" title="下一个队伍" onClick={() => setTeam((t) => (t >= 9 ? -1 : t + 1))}>
          ▶
        </button>
      </div>
    </div>
  )

  /** 预览主体（工具栏 + 画布 + 面板 + 提示）：模态与悬浮窗共用 */
  const bodyContent = (
    <>
      <div className="unitprev-toolbar">
        <span className="vdiff-hint">
          {engineMode && engineImage
            ? `引擎渲染：${engineDlcName}${playing && animFrameCount > 1 ? '（动画播放中）' : ''}`
            : '单位渲染仅支持已安装并授权的引擎 DLC'}
        </span>
        <span className="grow" />
        {engineDlcName && (
          <button
            className={`btn${engineMode ? ' primary' : ''}`}
            style={{ padding: '2px 10px', fontSize: 12 }}
            title={`当前使用「${engineDlcName}」渲染，失败时停止显示预览`}
            aria-label="切换引擎渲染"
            disabled
            onClick={() => setEngineMode(true)}
          >
            <AppIcon name="sparkle" size={12} /> 引擎渲染
          </button>
        )}
        <button
          className={`btn${panelOpen ? ' primary' : ''}`}
          style={{ padding: '2px 10px', fontSize: 12 }}
          title="打开/收起右侧控制面板（动画/旋转/叠加/背景/队伍）"
          aria-label="打开或收起控制面板"
          onClick={() => setPanelOpen((v) => !v)}
        >
          <AppIcon name="menu" size={12} /> 面板
        </button>
        <button className="icon-btn" title="缩小" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
        <span className="vdiff-hint">{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" title="放大" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
      </div>
      {!engineDlcName && <div className="local-note" role="status">单位渲染需要安装并授权引擎 DLC。请前往设置中的「插件与 DLC」添加引擎 DLC。</div>}
      <div className="unitprev-body-row">
        <div className="unitprev-main">
          <div
            className="unitprev-canvas-wrap unitprev-stack unitprev-rotatable"
            title="在画面上左右拖拽可直接旋转（1° 精度）"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              dragRef.current = { startX: e.clientX, startAngle: angleRef.current }
              setSpin(false)
              setAngleTarget(null)
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current
              if (!drag) return
              setAngleImmediate(drag.startAngle + (e.clientX - drag.startX) * 0.6)
            }}
            onPointerUp={(e) => {
              dragRef.current = null
              // 松手：0.2.3+ 引擎按最终角度原生渲染，残余旋转归零
              setAngleRequest(angleRef.current)
              try {
                e.currentTarget.releasePointerCapture(e.pointerId)
              } catch {
                /* 指针捕获已释放 */
              }
            }}
            onPointerCancel={() => {
              dragRef.current = null
              setAngleRequest(angleRef.current)
            }}
          >
            {/* M42：单位预览只显示引擎 DLC 的成品图；本地合成 canvas 仅保留为
                旧实现的载体（不渲染可见内容，执行开关见 ENGINE_ONLY_RENDER）。 */}
            <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="unitprev-canvas" style={{ display: 'none' }} />
            {/* M43 背景层：草/沙/海/无/棋/透（引擎图之下） */}
            <canvas ref={backCanvasRef} width={CANVAS_W} height={CANVAS_H} className="unitprev-canvas" style={layerSize} />
            {engineMode && engineImage && (
              <img
                src={engineImage}
                alt="引擎渲染结果"
                className="unitprev-canvas"
                style={{
                  ...layerSize,
                  // M44 平滑旋转：引擎按方向档出图，残余角度直接旋转贴图（旋转中心 = 单位原点）
                  transform: `rotate(${residualDeg}deg)`,
                  transformOrigin: `${(originX / CANVAS_W) * 100}% ${(originY / CANVAS_H) * 100}%`,
                }}
                onError={() => {
                  setEngineImage(null)
                  setEngineNote('引擎图片无法显示，本次未生成预览')
                }}
              />
            )}
            {/* M43 叠加层：网格/炮塔标记/调试线/视野（引擎图之上，同尺寸同缩放） */}
            <canvas ref={overlayRef} width={CANVAS_W} height={CANVAS_H} className="unitprev-canvas" style={layerSize} />
          </div>
          {engineNote && <div className="lint-evidence">{engineNote}</div>}
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
          {failed.length === 0 && <div className="lint-suggestion">预览正常：{recipe.image ? `${recipe.image}（${totalFrames} 帧）` : '未配置主体图像'}{turrets.length > 0 ? `，${turrets.length} 个炮塔` : ''}{recipe.teamColoringMode !== 'disabled' ? (engineMode && engineImage ? '，队伍着色：引擎原版十色' : `，队伍着色：${recipe.teamColoringMode === 'pureGreen' ? '纯绿' : recipe.teamColoringMode === 'hueAdd' ? '色相叠加' : '色相偏移'}（Canvas 近似，游戏内为 GPU 着色）`) : ''}</div>}
        </div>
        {panelOpen && panel}
      </div>
    </>
  )

  if (floating) {
    return (
      <FloatingWindow title={<>单位预览：{fileName}{recipe.image && <code className="tool-path" style={{ marginLeft: 8 }}>{recipe.image}</code>}</>} onClose={onClose} width={860} height={560} minWidth={480} minHeight={340}>
        <div className="vdiff-body" style={{ padding: '10px 12px' }}>{bodyContent}</div>
        <div className="modal-footer" style={{ borderTop: '1px solid var(--divider)' }}>
          <span className="vdiff-hint">单位中心为原点；视野 = 战争迷雾地块数 × 20 像素；不模拟建造视野/攻击范围</span>
        </div>
      </FloatingWindow>
    )
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card vdiff-card unitprev-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          单位预览：{fileName}
          {recipe.image && <code className="tool-path" style={{ marginLeft: 8 }}>{recipe.image}</code>}
        </div>
        <div className="modal-body vdiff-body">{bodyContent}</div>
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
