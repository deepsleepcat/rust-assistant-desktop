import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnitPreviewModal } from '../src/features/editor/unitPreview/UnitPreviewModal'
import { registerRendererAdapter, resetRendererAdaptersForTest } from '../src/features/plugins/adapterRegistry'
import { sceneToRenderResult, type PreviewScene } from '../src/features/editor/unitPreview/compositor'

// Run the modal's actual drawing effect in the Node test environment. Canvas records
// the host calls; only React's lifecycle and the unrelated escape handler are stubbed.
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  states: [] as unknown[],
  stateIndex: 0,
  refIndex: 0,
  canvas: null as unknown,
  pluginState: null as unknown,
  storeReadFails: false,
  storeReadOverride: null as Promise<unknown> | null,
}))
vi.mock('../src/services/bridge', () => ({ getBridge: () => ({ store: { get: async () => {
  if (hooks.storeReadFails) throw new Error('store unavailable')
  return hooks.storeReadOverride ?? hooks.pluginState
} } }) }))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => ({ current: hooks.refIndex++ === 0 ? hooks.canvas : initial }),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    return [index in hooks.states ? hooks.states[index] : initial, vi.fn()]
  },
}))
vi.mock('../src/utils/modalStack', () => ({ useEscapeHandler: vi.fn() }))

afterEach(() => { resetRendererAdaptersForTest(); hooks.storeReadFails = false; hooks.storeReadOverride = null })

function renderDrawingEffect(showWreck = false, options: { enabled?: boolean; declared?: boolean; allowedCommands?: string[]; resourceIds?: string[]; maxCommands?: number; maxResponseBytes?: number } = {}) {
  hooks.pluginState = { plugins: [{ enabled: options.enabled ?? true, manifest: {
    manifestVersion: 1, id: 'test.preview', name: 'Preview', version: '1.0.0',
    capabilities: options.declared === false ? ['translations'] : ['rendererAdapter'],
    ...(options.declared === false ? { translations: { en: { image: '图像' } } } : {}),
    resources: [{ id: 'img0', path: 'body.png', kind: 'image' }],
    ...(options.declared === false ? {} : { rendererAdapter: {
      formatVersion: 1, kind: 'canvas-2d', allowedCommands: options.allowedCommands ?? ['drawTile', 'fillRect', 'imageRef'],
      resourceIds: options.resourceIds ?? ['img0'], maxCommands: options.maxCommands ?? 256, maxResponseBytes: options.maxResponseBytes ?? 262144,
    } }),
  } }] }
  const calls: Array<{ op: string; args: unknown[] }> = []
  const record = (op: string) => (...args: unknown[]) => { calls.push({ op, args }) }
  const ctx = Object.fromEntries(['clearRect', 'fillRect', 'drawImage', 'save', 'restore', 'setLineDash', 'beginPath', 'rect', 'fill', 'stroke', 'fillText'].map((op) => [op, record(op)]))
  hooks.canvas = { width: 560, height: 420, getContext: () => ctx }
  hooks.effects = []
  hooks.stateIndex = 0
  hooks.refIndex = 0
  hooks.states = [new Map([['body.png', { naturalWidth: 32, naturalHeight: 32 }]]), 0, showWreck]
  UnitPreviewModal({
    file: 'units/test.ini', rootPath: 'W:/test', onClose: vi.fn(),
    content: '[graphics]\nimage: body.png\nimage_shadow: missing-shadow.png\nshadowOffsetX: 2\nshadowOffsetY: 3\nimage_turret: missing-gun.png\nimage_wreak: missing-wreck.png\n[turret_1]\nx: 10\ny: -20\n',
  })
  const cleanup = hooks.effects.at(-1)!()
  return { calls, cleanup }
}

function labels(calls: Array<{ op: string; args: unknown[] }>) {
  return calls.filter((call) => call.op === 'fillText').map((call) => call.args)
}

describe('UnitPreviewModal host missing image placeholders', () => {
  it.each([false, true])('successful adapter preserves gray blocks/labels above plugin commands (wreck=%s)', async (showWreck) => {
    let receivedScene: PreviewScene | undefined
    registerRendererAdapter({ pluginId: 'test.preview', run: (scene) => {
      receivedScene = scene as PreviewScene
      return sceneToRenderResult(receivedScene)
    } })
    const { calls } = renderDrawingEffect(showWreck)
    await vi.waitFor(() => { expect(labels(calls)).toHaveLength(showWreck ? 3 : 2) })
    expect(receivedScene?.resources.map((resource) => resource.ref)).toEqual(['body.png'])
    expect(labels(calls)).toEqual([
      ['阴影图像', 284, 245],
      ['missing-gun.png', 300, 196],
      ...(showWreck ? [['missing-wreck.p…', 280, 239]] : []),
    ])
    const drawing = calls.filter((call) => ['drawImage', 'rect', 'fillText'].includes(call.op))
    expect(drawing.map((call) => call.op)).toEqual(['drawImage', 'rect', 'fillText', 'rect', 'fillText', ...(showWreck ? ['rect', 'fillText'] : [])])
    expect(calls.filter((call) => call.op === 'rect').map((call) => call.args)).toEqual([
      [267, 199, 34, 34], [286, 156, 28, 28], ...(showWreck ? [[263, 193, 34, 34]] : []),
    ])
  })

  it.each(['absent', 'invalid', 'exception'])('%s adapter keeps the local shadow/body/turret placeholder order without duplicates', async (mode) => {
    if (mode !== 'absent') registerRendererAdapter({ pluginId: 'test.preview', run: () => {
      if (mode === 'exception') throw new Error('test failure')
      return { commands: [{ type: 'drawTile', path: 'undeclared.png', x: 0, y: 0, width: 1, height: 1 }] }
    } })
    const { calls } = renderDrawingEffect()
    await vi.waitFor(() => { expect(labels(calls)).toHaveLength(2) })
    expect(calls.filter((call) => ['drawImage', 'fillText'].includes(call.op)).map((call) => call.op)).toEqual(['fillText', 'drawImage', 'fillText'])
  })

  it.each([{ enabled: false }, { declared: false }])('registered adapter requires an enabled declaration (%j)', async (options) => {
    const run = vi.fn(() => ({ commands: [] }))
    registerRendererAdapter({ pluginId: 'test.preview', run })
    const { calls } = renderDrawingEffect(false, options)
    await vi.waitFor(() => { expect(labels(calls)).toHaveLength(2) })
    expect(run).not.toHaveBeenCalled()
    expect(calls.filter((call) => call.op === 'drawImage')).toHaveLength(1)
  })

  it.each([
    { options: { allowedCommands: ['fillRect'] }, commands: [{ type: 'drawTile', resourceId: 'img0', x: 0, y: 0, width: 1, height: 1 }] },
    { options: { resourceIds: [] }, commands: [{ type: 'drawTile', path: 'preview/image0.png', x: 0, y: 0, width: 1, height: 1 }] },
    { options: { resourceIds: [] }, commands: [{ type: 'imageRef', resourceId: 'img0', x: 0, y: 0, width: 1, height: 1 }] },
    { options: { maxCommands: 1 }, commands: Array.from({ length: 2 }, () => ({ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: '#000' })) },
    { options: { maxResponseBytes: 1024 }, commands: Array.from({ length: 20 }, () => ({ type: 'fillRect', x: 0, y: 0, width: 1, height: 1, color: '#000' })) },
  ])('manifest restrictions are enforced by the real drawing effect (%j)', async ({ options, commands }) => {
    const run = vi.fn(() => ({ commands }))
    registerRendererAdapter({ pluginId: 'test.preview', run })
    const { calls } = renderDrawingEffect(false, options)
    await vi.waitFor(() => { expect(labels(calls)).toHaveLength(2) })
    expect(run).toHaveBeenCalledOnce()
    // Rejection runs the local compositor, including its shadow/body/turret order.
    expect(calls.filter((call) => ['drawImage', 'fillText'].includes(call.op)).map((call) => call.op)).toEqual(['fillText', 'drawImage', 'fillText'])
  })

  it('declared scene alias resolves to the same image as resourceId', async () => {
    registerRendererAdapter({ pluginId: 'test.preview', run: () => ({ commands: [{ type: 'imageRef', path: 'preview/image0.png', x: 10, y: 20, width: 30, height: 40 }] }) })
    const { calls } = renderDrawingEffect()
    await vi.waitFor(() => { expect(labels(calls)).toHaveLength(2) })
    expect(calls.filter((call) => call.op === 'drawImage').map((call) => call.args.slice(1))).toEqual([[10, 20, 30, 40]])
  })

  it('store read failure falls back to the local drawing without invoking a registered adapter', async () => {
    hooks.storeReadFails = true
    const run = vi.fn(() => ({ commands: [] }))
    registerRendererAdapter({ pluginId: 'test.preview', run })
    const { calls } = renderDrawingEffect()
    await vi.waitFor(() => { expect(labels(calls)).toHaveLength(2) })
    expect(run).not.toHaveBeenCalled()
    expect(calls.filter((call) => ['drawImage', 'fillText'].includes(call.op)).map((call) => call.op)).toEqual(['fillText', 'drawImage', 'fillText'])
  })

  it('cleanup while reading the store prevents adapter execution and local drawing', async () => {
    let finish!: (raw: unknown) => void
    hooks.storeReadOverride = new Promise((resolve) => { finish = resolve })
    const run = vi.fn(() => ({ commands: [] }))
    registerRendererAdapter({ pluginId: 'test.preview', run })
    const { calls, cleanup } = renderDrawingEffect()
    const state = hooks.pluginState
    if (typeof cleanup === 'function') cleanup()
    finish(state)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
    expect(labels(calls)).toEqual([])
    expect(calls.filter((call) => call.op === 'drawImage')).toEqual([])
  })

  it('effect cleanup prevents stale adapter results and placeholders from drawing', async () => {
    let finish!: (result: ReturnType<typeof sceneToRenderResult>) => void
    registerRendererAdapter({ pluginId: 'test.preview', run: () => new Promise((resolve) => { finish = resolve }) })
    const { calls, cleanup } = renderDrawingEffect()
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    if (typeof cleanup === 'function') cleanup()
    finish({ commands: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(labels(calls)).toEqual([])
    expect(calls.filter((call) => call.op === 'drawImage')).toEqual([])
  })
})
