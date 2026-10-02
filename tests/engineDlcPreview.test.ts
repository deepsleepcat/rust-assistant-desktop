import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { registerRendererAdapter, resetRendererAdaptersForTest } from '../src/features/plugins/adapterRegistry'
import { sceneToRenderResult, type PreviewScene } from '../src/features/editor/unitPreview/compositor'

const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  stateIndex: 0, refIndex: 0,
  effects: [] as Array<() => void | (() => void)>,
  render: vi.fn(), cancel: vi.fn(),
}))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    if (!(index in hooks.states)) hooks.states[index] = initial
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = value }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++
    return hooks.refs[index] ??= { current: initial }
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
}))
vi.mock('../src/utils/modalStack', () => ({ useEscapeHandler: () => undefined }))
vi.mock('../src/services/bridge', () => ({ getBridge: () => ({
  engineDlc: { render: hooks.render, cancel: hooks.cancel },
  store: { get: async () => ({ plugins: [{ enabled: true, manifest: {
    manifestVersion: 1, id: 'test.preview', name: 'Preview', version: '1.0.0', capabilities: ['rendererAdapter'],
    resources: [{ id: 'img0', path: 'body.png', kind: 'image' }],
    rendererAdapter: { formatVersion: 1, kind: 'canvas-2d', allowedCommands: ['drawTile'], resourceIds: ['img0'], maxCommands: 256, maxResponseBytes: 262144 },
  } }] }) },
}) }))
import { UnitPreviewModal } from '../src/features/editor/unitPreview/UnitPreviewModal'

function renderTree(content = '') {
  hooks.stateIndex = 0
  hooks.refIndex = 0
  hooks.effects = []
  return UnitPreviewModal({ file: '/project/tank.ini', content, rootPath: '/project', onClose: () => undefined })
}
function elements(node: ReactNode, type: string): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type))
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [...(element.type === type ? [element] : []), ...elements(element.props.children as ReactNode, type)]
}

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object' || !('props' in node)) return ''
  return text((node as ReactElement<{ children?: ReactNode }>).props.children)
}

beforeEach(() => {
  resetRendererAdaptersForTest()
  hooks.states = []
  hooks.refs = []
  hooks.render.mockReset().mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,test' })
  hooks.cancel.mockReset().mockResolvedValue({ ok: false, reason: 'cancelled' })
})

describe('engine preview React tree and effect contracts (no real GUI)', () => {
  it.each(['failure', 'exception', 'image-error', 'success'])('shows the actual displayed renderer after DLC %s', async (mode) => {
    const drawImage = vi.fn()
    const ctx = Object.fromEntries(['clearRect', 'fillRect', 'save', 'restore'].map((op) => [op, vi.fn()]))
    hooks.refs[0] = { current: { width: 560, height: 420, getContext: () => ({ ...ctx, drawImage }) } }
    renderTree()
    hooks.states[0] = new Map([['body.png', { naturalWidth: 32, naturalHeight: 32 }]])
    hooks.states[10] = 'Test DLC'
    hooks.states[11] = true
    const run = vi.fn((scene: unknown) => sceneToRenderResult(scene as PreviewScene))
    registerRendererAdapter({ pluginId: 'test.preview', run })
    if (mode === 'failure') hooks.render.mockResolvedValue({ ok: false, reason: 'test failure' })
    if (mode === 'exception') hooks.render.mockRejectedValue(new Error('test exception'))
    const content = '[graphics]\nimage: body.png\n'
    renderTree(content)
    hooks.effects[2]() // Actual DLC request effect.
    hooks.effects.at(-1)!() // Actual Canvas adapter effect.
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledOnce()
      expect(drawImage).toHaveBeenCalledOnce()
      expect(hooks.states[6]).toMatchObject({ pluginId: 'test.preview' })
      expect(hooks.states[13]).not.toBe('正在用引擎渲染…')
    })
    if (mode === 'image-error') {
      const image = elements(renderTree(content), 'img')[0]
      ;(image.props.onError as () => void)()
    }
    const tree = renderTree(content)
    const visible = text(tree)
    if (mode === 'success') {
      expect(visible).toContain('引擎渲染：Test DLC')
      expect(visible).not.toContain('渲染路径：插件')
      expect(elements(tree, 'canvas')[0].props.style).toEqual({ display: 'none' })
      expect(elements(tree, 'img')).toHaveLength(1)
    } else {
      expect(visible).toContain('渲染路径：插件 test.preview')
      expect(visible).toContain('已回退 Canvas 预览')
      expect(visible).not.toContain('已回退内置合成')
      expect(visible).not.toContain('引擎渲染：Test DLC')
      expect(elements(tree, 'canvas')[0].props.style).toEqual({ display: undefined })
      expect(elements(tree, 'img')).toHaveLength(0)
    }
  })

  it('retains the same canvas position and ref through engine success and paused local fallback', () => {
    const local = renderTree()
    hooks.states[7] = false // paused (plugin renderPath occupies state 6)
    hooks.states[10] = 'Demo'
    hooks.states[11] = true
    hooks.states[12] = 'data:image/png;base64,test'
    const engine = renderTree()
    const original = elements(local, 'canvas')[0]
    const retained = elements(engine, 'canvas')[0]
    expect(retained.props.ref).toBe(original.props.ref)
    expect(retained.key).toBe(original.key)
    expect(retained.props.style).toEqual({ display: 'none' })
    expect(elements(engine, 'img')).toHaveLength(1)
    hooks.states[11] = false
    const fallback = elements(renderTree(), 'canvas')[0]
    expect(fallback.props.ref).toBe(original.props.ref)
    expect(fallback.props.style).toEqual({ display: undefined })
    expect(elements(renderTree(), 'img')).toHaveLength(0)
  })

  it('image decode errors clear engine output and restore the canvas', () => {
    renderTree()
    hooks.states[11] = true
    hooks.states[12] = 'bad-image'
    const image = elements(renderTree(), 'img')[0]
    ;(image.props.onError as () => void)()
    expect(hooks.states[12]).toBeNull()
    expect(hooks.states[13]).toContain('回退')
    const fallback = renderTree()
    expect(elements(fallback, 'img')).toHaveLength(0)
    expect(elements(fallback, 'canvas')[0].props.style).toEqual({ display: undefined })
  })

  it('effect cleanup cancels its own request and ignores a late response', async () => {
    renderTree()
    hooks.states[10] = 'Demo'
    hooks.states[11] = true
    let finish!: (value: unknown) => void
    hooks.render.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTree()
    const cleanup = hooks.effects[2]()
    await Promise.resolve()
    expect(hooks.render).toHaveBeenCalledOnce()
    const request = hooks.render.mock.calls[0][0]
    expect(request.requestId).toEqual(expect.any(String))
    if (typeof cleanup !== 'function') throw new Error('missing cleanup')
    cleanup()
    expect(hooks.cancel).toHaveBeenCalledWith(request.requestId)
    finish({ ok: true, dataUrl: 'late' })
    await Promise.resolve()
    expect(hooks.states[12]).toBeNull()
  })
})
