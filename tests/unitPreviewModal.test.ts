import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { UnitPreviewModal } from '../src/features/editor/unitPreview/UnitPreviewModal'
import { registerRendererAdapter, resetRendererAdaptersForTest } from '../src/features/plugins/adapterRegistry'
import { sceneToRenderResult, type PreviewScene } from '../src/features/editor/unitPreview/compositor'

// 单位预览只允许 DLC 产出的画面：本地合成 effect 必须直接返回，即使用户装了
// 能正常工作的渲染插件、图像也都加载成功。这里验证的就是这条产品规则，
// 而不是本地合成器的绘制细节（后者由 unitPreviewCompositor.test.ts 覆盖）。
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  states: [] as unknown[],
  stateIndex: 0,
  refIndex: 0,
  canvas: null as unknown,
}))
vi.mock('../src/services/bridge', () => ({ getBridge: () => ({}) }))
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

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object' || !('props' in node)) return ''
  return text((node as ReactElement<{ children?: ReactNode }>).props.children)
}

function elements(node: ReactNode, type: string): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type))
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [...(element.type === type ? [element] : []), ...elements(element.props.children as ReactNode, type)]
}

function renderModal() {
  const drawn: string[] = []
  const ctx = Object.fromEntries(
    ['clearRect', 'fillRect', 'drawImage', 'save', 'restore', 'setLineDash', 'beginPath', 'rect', 'fill', 'stroke', 'fillText']
      .map((op) => [op, vi.fn(() => drawn.push(op))]),
  )
  hooks.canvas = { width: 560, height: 420, getContext: () => ctx }
  hooks.effects = []
  hooks.stateIndex = 0
  hooks.refIndex = 0
  hooks.states = [new Map([['body.png', { naturalWidth: 32, naturalHeight: 32 }]]), 0, false]
  const tree = UnitPreviewModal({
    file: 'units/test.ini',
    rootPath: 'W:/test',
    onClose: vi.fn(),
    content: '[graphics]\nimage: body.png\n',
  })
  return { tree, drawn }
}

describe('unit preview only renders through the engine DLC', () => {
  it('never runs the local compositor even with a working adapter and loaded images', async () => {
    const run = vi.fn((scene: unknown) => sceneToRenderResult(scene as PreviewScene))
    registerRendererAdapter({ pluginId: 'test.preview', run })
    const { drawn } = renderModal()
    const cleanup = hooks.effects.at(-1)!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
    expect(drawn).toEqual([])
    if (typeof cleanup === 'function') cleanup()
  })

  it('shows the DLC requirement instead of a local fallback preview', () => {
    const { tree } = renderModal()
    expect(text(tree)).toContain('单位渲染需要安装并授权引擎 DLC')
    expect(elements(tree, 'img')).toHaveLength(0)
    expect(elements(tree, 'canvas')[0].props.style).toEqual({ display: 'none' })
  })
})
