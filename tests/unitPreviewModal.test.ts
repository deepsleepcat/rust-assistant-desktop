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
}))
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

afterEach(() => { resetRendererAdaptersForTest() })

function renderDrawingEffect(showWreck = false) {
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

  it('effect cleanup prevents stale adapter results and placeholders from drawing', async () => {
    let finish!: (result: ReturnType<typeof sceneToRenderResult>) => void
    registerRendererAdapter({ pluginId: 'test.preview', run: () => new Promise((resolve) => { finish = resolve }) })
    const { calls, cleanup } = renderDrawingEffect()
    if (typeof cleanup === 'function') cleanup()
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    finish({ commands: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(labels(calls)).toEqual([])
    expect(calls.filter((call) => call.op === 'drawImage')).toEqual([])
  })
})
