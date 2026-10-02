/**
 * 单位预览合成器测试（M41 渲染器插件化）。
 *
 * 覆盖三件事：
 * 1. 场景构建——资源去重、中心偏移换算成画布绝对坐标、缺图条目不进场景；
 * 2. 内置表达——场景条目与 drawTile 指令 1:1，且能通过扩展点的指令校验；
 * 3. 回退链与安全边界——未注册/异常/超时/非法结果统一回退内置，
 *    且插件无法借指令字段注入滤镜，效果只能由宿主在场景资源上声明。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_PREVIEW_ADAPTER_ID,
  buildPreviewScene,
  executePreviewCommands,
  registerBuiltinPreviewAdapter,
  sceneResources,
  sceneToRenderResult,
  type PreviewDrawInput,
} from '../src/features/editor/unitPreview/compositor'
import {
  registerRendererAdapter,
  registeredAdapterIds,
  resetRendererAdaptersForTest,
  runRendererAdapter,
  unregisterRendererAdapter,
} from '../src/features/plugins/adapterRegistry'

afterEach(() => {
  resetRendererAdaptersForTest()
})

/** 一条绘制输入夹具（默认 body 图，效果 teamColor） */
function draw(overrides: Partial<PreviewDrawInput> = {}): PreviewDrawInput {
  return {
    ref: 'body.png',
    offsetX: 10,
    offsetY: -20,
    width: 32,
    height: 32,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 32,
    sourceHeight: 32,
    alpha: 1,
    effect: 'teamColor',
    ...overrides,
  }
}

/** 假 Canvas 上下文：记录调用，并在 drawImage 时快照当时的滤镜/透明度/混合模式 */
function fakeCanvas() {
  const calls: Array<{ op: string; args: unknown[]; filter?: string; alpha?: number; composite?: string; fillStyle?: string }> = []
  let filter = ''
  let globalAlpha = 1
  let globalCompositeOperation = 'source-over'
  let fillStyle = ''
  const record = (op: string, args: unknown[], extra: Record<string, unknown> = {}) => {
    calls.push({ op, args, filter, alpha: globalAlpha, composite: globalCompositeOperation, fillStyle, ...extra })
  }
  const ctx = {
    get filter() { return filter },
    set filter(value: string) { filter = value },
    get globalAlpha() { return globalAlpha },
    set globalAlpha(value: number) { globalAlpha = value },
    get globalCompositeOperation() { return globalCompositeOperation },
    set globalCompositeOperation(value: string) { globalCompositeOperation = value },
    get fillStyle() { return fillStyle },
    set fillStyle(value: string) { fillStyle = value },
    save: () => record('save', []),
    restore: () => record('restore', []),
    fillRect: (...args: unknown[]) => record('fillRect', args),
    drawImage: (...args: unknown[]) => record('drawImage', args),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

/** 按 ref 返回一个占位图像对象（合成器只用其身份，不读像素） */
const imageFor = (ref: string): CanvasImageSource | null => ({ ref } as unknown as CanvasImageSource)

describe('M41 buildPreviewScene（场景构建）', () => {
  it('把相对画布中心的偏移换算为画布绝对坐标', () => {
    const scene = buildPreviewScene({
      canvasWidth: 100,
      canvasHeight: 60,
      teamColorMode: 'disabled',
      draws: [draw({ offsetX: 10, offsetY: -20 })],
    })
    expect(scene.items[0].x).toBe(60) // 100/2 + 10
    expect(scene.items[0].y).toBe(10) // 60/2 - 20
  })

  it('同一 (ref, effect) 组合共享一个资源 id，不同 effect 不共享', () => {
    const scene = buildPreviewScene({
      canvasWidth: 10,
      canvasHeight: 10,
      teamColorMode: 'pureGreen',
      draws: [draw(), draw(), draw({ effect: 'shadow' })],
    })
    expect(scene.resources).toHaveLength(2)
    expect(scene.items[0].resourceId).toBe(scene.items[1].resourceId)
    expect(scene.items[2].resourceId).not.toBe(scene.items[0].resourceId)
  })

  it('缺图条目（ref=null）不进场景，由宿主画占位', () => {
    const scene = buildPreviewScene({
      canvasWidth: 10,
      canvasHeight: 10,
      teamColorMode: 'disabled',
      draws: [draw(), draw({ ref: null })],
    })
    expect(scene.items).toHaveLength(1)
    expect(scene.resources).toHaveLength(1)
  })

  it('缺省 effect 归一为 none', () => {
    const scene = buildPreviewScene({
      canvasWidth: 10,
      canvasHeight: 10,
      teamColorMode: 'disabled',
      draws: [draw({ effect: undefined })],
    })
    expect(scene.resources[0].effect).toBe('none')
  })

  it('sceneResources 产出校验层可用的 id/kind（path 为安全占位名）', () => {
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const resources = sceneResources(scene)
    expect(resources).toHaveLength(1)
    expect(resources[0].id).toBe(scene.resources[0].id)
    expect(resources[0].kind).toBe('image')
    expect(resources[0].path).not.toMatch(/[:\\]/)
  })
})

describe('M41 sceneToRenderResult（内置指令表达）', () => {
  it('场景条目与 drawTile 指令 1:1，几何原样带出', () => {
    const scene = buildPreviewScene({ canvasWidth: 100, canvasHeight: 60, teamColorMode: 'pureGreen', draws: [draw()] })
    const result = sceneToRenderResult(scene)
    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]).toMatchObject({
      type: 'drawTile',
      resourceId: scene.items[0].resourceId,
      x: scene.items[0].x,
      y: scene.items[0].y,
      width: 32,
      height: 32,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 32,
      sourceHeight: 32,
      alpha: 1,
    })
  })
})

describe('M41 executePreviewCommands（宿主落画）', () => {
  it('drawTile 取到图则绘制，取不到则跳过', () => {
    const scene = buildPreviewScene({ canvasWidth: 100, canvasHeight: 100, teamColorMode: 'disabled', draws: [draw()] })
    const { ctx, calls } = fakeCanvas()
    executePreviewCommands(ctx, sceneToRenderResult(scene), scene, () => null)
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(0)
  })

  it('teamColor + pureGreen：drawImage 时滤镜为灰阶+棕+色相转绿', () => {
    const scene = buildPreviewScene({ canvasWidth: 100, canvasHeight: 100, teamColorMode: 'pureGreen', draws: [draw()] })
    const { ctx, calls } = fakeCanvas()
    executePreviewCommands(ctx, sceneToRenderResult(scene), scene, imageFor)
    const drawCall = calls.find((c) => c.op === 'drawImage')
    expect(drawCall?.filter).toBe('grayscale(1) sepia(1) hue-rotate(75deg) saturate(5)')
  })

  it('teamColor + hueAdd：drawImage 后以 color 混合叠加队伍绿', () => {
    const scene = buildPreviewScene({ canvasWidth: 100, canvasHeight: 100, teamColorMode: 'hueAdd', draws: [draw()] })
    const { ctx, calls } = fakeCanvas()
    executePreviewCommands(ctx, sceneToRenderResult(scene), scene, imageFor)
    const drawIndex = calls.findIndex((c) => c.op === 'drawImage')
    const overlay = calls.find((c, i) => i > drawIndex && c.op === 'fillRect')
    expect(overlay?.composite).toBe('color')
    expect(overlay?.fillStyle).toBe('#00c800')
  })

  it('shadow：drawImage 时滤镜为剪影压暗，且不叠加队伍色', () => {
    const scene = buildPreviewScene({ canvasWidth: 100, canvasHeight: 100, teamColorMode: 'pureGreen', draws: [draw({ effect: 'shadow' })] })
    const { ctx, calls } = fakeCanvas()
    executePreviewCommands(ctx, sceneToRenderResult(scene), scene, imageFor)
    expect(calls.find((c) => c.op === 'drawImage')?.filter).toBe('grayscale(1) brightness(0.2)')
    expect(calls.filter((c) => c.op === 'fillRect')).toHaveLength(0)
  })

  it('fillRect 指令按颜色与透明度落地', () => {
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [] })
    const { ctx, calls } = fakeCanvas()
    executePreviewCommands(ctx, { commands: [{ type: 'fillRect', x: 1, y: 2, width: 3, height: 4, color: '#abcdef', alpha: 0.5 }] }, scene, imageFor)
    const fill = calls.find((c) => c.op === 'fillRect')
    expect(fill?.args).toEqual([1, 2, 3, 4]) // 几何进 fillRect 参数
    expect(fill?.alpha).toBe(0.5) // 透明度经 ctx.globalAlpha 施加，不混进几何参数
  })

  it('引用未声明资源的指令被跳过，不抛错', () => {
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [] })
    const { ctx, calls } = fakeCanvas()
    executePreviewCommands(ctx, { commands: [{ type: 'drawTile', resourceId: 'img99', x: 0, y: 0, width: 1, height: 1 }] }, scene, imageFor)
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(0)
  })
})

describe('M41 扩展点回退链（adapterRegistry + renderer）', () => {
  it('未注册任何实现 → 原样返回回退结果，不算异常', async () => {
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const fallback = sceneToRenderResult(scene)
    const r = await runRendererAdapter('not.registered', scene, fallback, { resources: sceneResources(scene) })
    expect(r.usedFallback).toBe(true)
    expect(r.executedPluginId).toBe(null)
    expect(r.result).toEqual(fallback)
  })

  it('内置实现注册后可直接执行，且指令通过校验（不触发回退）', async () => {
    registerBuiltinPreviewAdapter()
    expect(registeredAdapterIds()).toContain(BUILTIN_PREVIEW_ADAPTER_ID)
    const scene = buildPreviewScene({ canvasWidth: 100, canvasHeight: 100, teamColorMode: 'pureGreen', draws: [draw()] })
    const r = await runRendererAdapter(BUILTIN_PREVIEW_ADAPTER_ID, scene, sceneToRenderResult(scene), { resources: sceneResources(scene) })
    expect(r.usedFallback).toBe(false)
    expect(r.executedPluginId).toBe(BUILTIN_PREVIEW_ADAPTER_ID)
    expect(r.result.commands).toHaveLength(1)
  })

  it('宿主 adapter 抛异常 → 回退内置并给出 exception 原因', async () => {
    registerRendererAdapter({ pluginId: 'test.boom', run: () => { throw new Error('boom') } })
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const fallback = sceneToRenderResult(scene)
    const r = await runRendererAdapter('test.boom', scene, fallback, { resources: sceneResources(scene) })
    expect(r.usedFallback).toBe(true)
    expect(r.reason).toBe('exception')
    expect(r.result).toEqual(fallback)
  })

  it('宿主 adapter 超时 → 回退内置并给出 timeout 原因', async () => {
    registerRendererAdapter({ pluginId: 'test.slow', run: () => new Promise((resolve) => { setTimeout(() => resolve({ commands: [] }), 5000) }) })
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const r = await runRendererAdapter('test.slow', scene, sceneToRenderResult(scene), { resources: sceneResources(scene), timeoutMs: 20 })
    expect(r.usedFallback).toBe(true)
    expect(r.reason).toBe('timeout')
  })

  it('宿主 adapter 返回非法结果 → 回退内置并给出 invalid-result 原因', async () => {
    registerRendererAdapter({ pluginId: 'test.invalid', run: () => ({ commands: [{ type: 'drawTile', x: 1 }] }) })
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const r = await runRendererAdapter('test.invalid', scene, sceneToRenderResult(scene), { resources: sceneResources(scene) })
    expect(r.usedFallback).toBe(true)
    expect(r.reason).toBe('invalid-result')
  })

  it('安全边界：插件无法借未知字段注入滤镜', async () => {
    registerRendererAdapter({
      pluginId: 'test.inject',
      run: () => ({ commands: [{ type: 'drawTile', resourceId: 'img0', x: 0, y: 0, width: 1, height: 1, filter: 'none' }] }),
    })
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const r = await runRendererAdapter('test.inject', scene, sceneToRenderResult(scene), { resources: sceneResources(scene) })
    expect(r.usedFallback).toBe(true)
    expect(r.reason).toBe('invalid-result')
  })

  it('安全边界：插件引用了未声明资源 id → 回退内置', async () => {
    registerRendererAdapter({
      pluginId: 'test.unknownResource',
      run: () => ({ commands: [{ type: 'drawTile', resourceId: 'img999', x: 0, y: 0, width: 1, height: 1 }] }),
    })
    const scene = buildPreviewScene({ canvasWidth: 10, canvasHeight: 10, teamColorMode: 'disabled', draws: [draw()] })
    const r = await runRendererAdapter('test.unknownResource', scene, sceneToRenderResult(scene), { resources: sceneResources(scene) })
    expect(r.usedFallback).toBe(true)
    expect(r.reason).toBe('invalid-result')
  })

  it('注销后回到未注册语义（插件卸载路径）', async () => {
    registerBuiltinPreviewAdapter()
    unregisterRendererAdapter(BUILTIN_PREVIEW_ADAPTER_ID)
    expect(registeredAdapterIds()).not.toContain(BUILTIN_PREVIEW_ADAPTER_ID)
  })
})
