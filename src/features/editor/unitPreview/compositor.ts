/**
 * 单位预览合成器（M41 渲染器插件化）：
 * 把单位预览的绘制布局换算成「宿主冻结场景」+「受限绘制指令」，
 * 供 plugins/adapterRegistry 的 rendererAdapter 扩展点消费。
 *
 * 分工：
 * - 本模块（宿主）：算几何、声明资源与效果、把指令落到 Canvas；
 * - 插件：只能引用场景里已声明的资源 id，返回 drawTile/fillRect/imageRef 指令。
 *
 * 安全边界：本模块只做纯数据换算，不读文件、不碰 Canvas、不执行插件代码。
 * 队伍着色/阴影/色相叠加等效果一律由**宿主**在场景资源上声明（PreviewSceneResource.effect），
 * 插件无法注入滤镜、混合模式或任意绘制 API——它只能引用资源 id。
 */
import type { RenderCommand, RenderResult } from '../../plugins/renderer'
import type { PluginResource } from '../../plugins/manifest'
import { registerRendererAdapter } from '../../plugins/adapterRegistry'
import type { TeamColoringMode } from './recipe'

/**
 * 资源上由宿主声明的绘制效果（插件不可自行指定）：
 * - none      原样绘制
 * - shadow    AUTO 阴影剪影（灰阶压暗；不随队伍着色）
 * - teamColor 队伍着色（具体滤镜由场景 teamColorMode 决定）
 */
export type PreviewEffect = 'none' | 'shadow' | 'teamColor'

/** 一条待绘制的输入（由 UnitPreviewModal 从配方几何算出） */
export interface PreviewDrawInput {
  /** 原始图像引用（CORE:/SHARED:/ROOT: 或项目内相对路径）；缺图时为 null */
  ref: string | null
  /** 相对画布中心的左上角（已含缩放） */
  offsetX: number
  offsetY: number
  width: number
  height: number
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  alpha: number
  /** 宿主声明的效果；缺省 none */
  effect?: PreviewEffect
}

export interface PreviewSceneResource {
  id: string
  ref: string
  effect: PreviewEffect
}

export interface PreviewSceneItem {
  resourceId: string
  x: number
  y: number
  width: number
  height: number
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  alpha: number
}

export interface PreviewScene {
  formatVersion: 1
  canvasWidth: number
  canvasHeight: number
  teamColorMode: TeamColoringMode
  resources: ReadonlyArray<PreviewSceneResource>
  items: ReadonlyArray<PreviewSceneItem>
}

export interface BuildPreviewSceneInput {
  canvasWidth: number
  canvasHeight: number
  teamColorMode: TeamColoringMode
  draws: ReadonlyArray<PreviewDrawInput>
}

/** 为校验层准备的资源表：renderer.ts 只校验 id/kind，path 用安全占位名 */
export function sceneResources(scene: PreviewScene): PluginResource[] {
  return scene.resources.map((resource, index) => ({
    id: resource.id,
    path: `preview/image${index}.png`,
    kind: 'image' as const,
  }))
}

/**
 * 构建冻结场景：把绘制输入去重成资源表 + 画布绝对坐标的条目表。
 * 同一 (ref, effect) 组合共享一个资源 id；缺图条目（ref=null）不进场景（由宿主画占位）。
 */
export function buildPreviewScene(input: BuildPreviewSceneInput): PreviewScene {
  const resources: PreviewSceneResource[] = []
  const idByKey = new Map<string, string>()
  const items: PreviewSceneItem[] = []
  const halfWidth = input.canvasWidth / 2
  const halfHeight = input.canvasHeight / 2

  for (const draw of input.draws) {
    if (!draw.ref) continue
    const effect = draw.effect ?? 'none'
    const key = `${draw.ref}\u0000${effect}`
    let id = idByKey.get(key)
    if (id === undefined) {
      id = `img${resources.length}`
      idByKey.set(key, id)
      resources.push({ id, ref: draw.ref, effect })
    }
    items.push({
      resourceId: id,
      x: halfWidth + draw.offsetX,
      y: halfHeight + draw.offsetY,
      width: draw.width,
      height: draw.height,
      sourceX: draw.sourceX,
      sourceY: draw.sourceY,
      sourceWidth: draw.sourceWidth,
      sourceHeight: draw.sourceHeight,
      alpha: draw.alpha,
    })
  }

  return {
    formatVersion: 1,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    teamColorMode: input.teamColorMode,
    resources,
    items,
  }
}

/**
 * 内置绘制结果：场景条目 1:1 映射为 drawTile 指令。
 * 这是「内置 recipe 渲染器」的可移植表达，也是插件缺失/超时/返回非法时的回退结果。
 */
export function sceneToRenderResult(scene: PreviewScene): RenderResult {
  const commands: RenderCommand[] = scene.items.map((item) => ({
    type: 'drawTile',
    resourceId: item.resourceId,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    sourceX: item.sourceX,
    sourceY: item.sourceY,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    alpha: item.alpha,
  }))
  return { commands }
}

/**
 * 内置 adapter 的插件 id（宿主注册；它同时是「内置渲染器」与「回退实现」的落点）。
 * 全小写：adapterRegistry 注册与查询都按小写归一（adapterRegistry.ts:23/53），
 * 且 registeredAdapterIds() 返回的是小写键——常量若含大写，消费方用 `id !== 常量`
 * 排除内置实现时会永远不相等，把内置适配器误当成第三方插件。
 */
export const BUILTIN_PREVIEW_ADAPTER_ID = 'builtin.unitpreview'

/**
 * 注册内置 adapter：宿主受信任代码，直接返回内置绘制结果。
 * 未注册任何 adapter 时 adapterRegistry 会自行返回消费方提供的 fallback，无需依赖本注册。
 */
export function registerBuiltinPreviewAdapter(): void {
  registerRendererAdapter({
    pluginId: BUILTIN_PREVIEW_ADAPTER_ID,
    run: (scene) => sceneToRenderResult(scene as PreviewScene),
  })
}

/**
 * 把绘制结果落到 Canvas。
 * 效果来自**场景资源声明**，绝不读插件返回的字段——插件伪造 effect 字段会在校验层被拒（未知字段）。
 */
export function executePreviewCommands(
  ctx: CanvasRenderingContext2D,
  result: RenderResult,
  scene: PreviewScene,
  resolveImage: (ref: string) => CanvasImageSource | null,
): void {
  const refById = new Map(scene.resources.map((resource) => [resource.id, resource.ref]))
  const effectById = new Map(scene.resources.map((resource) => [resource.id, resource.effect]))
  const mode = scene.teamColorMode

  for (const command of result.commands) {
    if (command.type === 'fillRect') {
      ctx.save()
      if (command.alpha !== undefined) ctx.globalAlpha = command.alpha
      ctx.fillStyle = command.color
      ctx.fillRect(command.x, command.y, command.width, command.height)
      ctx.restore()
      continue
    }

    const id: string | undefined = command.resourceId
    const ref = id === undefined ? undefined : refById.get(id)
    const image = ref === undefined ? null : resolveImage(ref)
    if (!image) continue
    const effect: PreviewEffect = id === undefined ? 'none' : (effectById.get(id) ?? 'none')

    // imageRef 允许省略几何——省略时无法确定目标矩形，按未命中跳过
    if (command.type === 'imageRef') {
      const { x, y, width, height } = command
      if (x === undefined || y === undefined || width === undefined || height === undefined) continue
      ctx.save()
      ctx.globalAlpha = command.alpha ?? 1
      applyPreviewEffect(ctx, effect, mode)
      ctx.drawImage(image, x, y, width, height)
      drawHueAddOverlay(ctx, effect, mode, x, y, width, height)
      ctx.restore()
      continue
    }

    ctx.save()
    ctx.globalAlpha = command.alpha ?? 1
    applyPreviewEffect(ctx, effect, mode)
    ctx.drawImage(
      image,
      command.sourceX ?? 0,
      command.sourceY ?? 0,
      command.sourceWidth ?? command.width,
      command.sourceHeight ?? command.height,
      command.x,
      command.y,
      command.width,
      command.height,
    )
    drawHueAddOverlay(ctx, effect, mode, command.x, command.y, command.width, command.height)
    ctx.restore()
  }
}

/**
 * 按宿主声明的效果设置 Canvas 状态（与 M34 既有实现保持一致）：
 * - shadow     → 主图剪影：灰阶压暗（不随队伍着色）
 * - teamColor  → pureGreen：灰阶+棕+色相转绿；hueShift：色相偏移 120°；hueAdd 无滤镜（改由叠加层处理）
 */
export function applyPreviewEffect(
  ctx: CanvasRenderingContext2D,
  effect: PreviewEffect,
  mode: TeamColoringMode,
): void {
  if (effect === 'shadow') {
    ctx.filter = 'grayscale(1) brightness(0.2)'
    return
  }
  if (effect !== 'teamColor') return
  if (mode === 'pureGreen') ctx.filter = 'grayscale(1) sepia(1) hue-rotate(75deg) saturate(5)'
  else if (mode === 'hueShift') ctx.filter = 'hue-rotate(120deg)'
  // hueAdd：绘制后以 'color' 混合叠加（见 drawHueAddOverlay）
}

/** hueAdd：'color' 混合模式叠加队伍绿（保留亮度，近似官方色相叠加） */
function drawHueAddOverlay(
  ctx: CanvasRenderingContext2D,
  effect: PreviewEffect,
  mode: TeamColoringMode,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (effect !== 'teamColor' || mode !== 'hueAdd') return
  ctx.globalCompositeOperation = 'color'
  ctx.fillStyle = '#00c800'
  ctx.fillRect(x, y, width, height)
}
