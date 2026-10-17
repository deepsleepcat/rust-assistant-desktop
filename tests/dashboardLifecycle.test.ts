import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { DashboardLayout } from '../src/services/dashboardApi'

// Executes the actual component with retained hook state and effect teardown/setup.
// This is a lifecycle harness, not a DOM or native Activity integration test.
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  effects: [] as { deps: unknown[]; run: () => void | (() => void); cleanup?: () => void }[],
  pending: [] as (() => void)[],
  state: { communityAuth: { status: 'signed_in', user: { id: 1 } }, settings: { ai: { communityEndpoint: 'https://isolated.invalid' } }, notify: vi.fn(), loginCommunity: vi.fn() },
  api: { dashboard: vi.fn(), layout: vi.fn(), putLayout: vi.fn() },
}))
const equal = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.slots)) h.slots[i] = initial
    return [h.slots[i], (next: unknown) => { h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next }]
  },
  useRef: (initial: unknown) => { const i = h.cursor++; return h.slots[i] ??= { current: initial } },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = h.cursor++, previous = h.slots[i] as { value: unknown; deps: unknown[] } | undefined
    if (!previous || !equal(previous.deps, deps)) h.slots[i] = { deps, value: fn() }
    return (h.slots[i] as { value: unknown }).value
  },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const i = h.cursor++, previous = h.slots[i] as { value: unknown; deps: unknown[] } | undefined
    if (!previous || !equal(previous.deps, deps)) h.slots[i] = { deps, value: fn }
    return (h.slots[i] as { value: unknown }).value
  },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const i = h.cursor++, previous = h.effects[i]
    if (previous && equal(previous.deps, deps)) return
    h.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); h.effects[i] = { deps, run, cleanup: cleanup || undefined } })
  },
}))
vi.mock('../src/stores/workspace', () => ({ useWorkspaceStore: Object.assign((select: (s: typeof h.state) => unknown) => select(h.state), { getState: () => h.state }) }))
vi.mock('../src/services/dashboardApi', () => ({ createDashboardApi: () => h.api, DashboardApiError: class extends Error {} }))
import { DashboardPanel } from '../src/features/dashboard/DashboardPanel'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function render() { h.cursor = 0; return DashboardPanel() }
function effects() { for (const run of h.pending.splice(0)) run() }
function hide() { h.effects.forEach(e => e?.cleanup?.()) }
function show() { h.effects.forEach(e => { if (e) { const cleanup = e.run(); e.cleanup = cleanup || undefined } }) }
type Node = ReactElement<{ children?: unknown; onClick?: () => void; 'aria-label'?: string }>
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return []
  const node = tree as Node
  return [node, ...nodes(node.props.children)]
}
function swap() {
  const button = nodes(render()).find(n => n.type === 'button' && n.props['aria-label']?.startsWith('交换“'))
  expect(button?.props.onClick).toBeTypeOf('function')
  button!.props.onClick!()
}
const layout = (): DashboardLayout => ({ version: 1, slots: ['balance', 'tokens'] })
beforeEach(() => {
  h.slots = []; h.effects = []; h.pending = []
  h.state.communityAuth = { status: 'signed_in', user: { id: 1 } }
  h.state.settings.ai.communityEndpoint = 'https://isolated.invalid'
  h.api.dashboard.mockReset().mockResolvedValue({ usage: { requestCount: 0 }, logs: { page: 1, pageSize: 20, total: 0, items: [], window: { start: '', end: '' } } })
  h.api.layout.mockReset().mockResolvedValue(layout())
  h.api.putLayout.mockReset()
  h.state.notify.mockReset()
})
afterEach(hide)

describe('dashboard save lifecycle (retained hooks, no server/DB)', () => {
  it('waits for the original PUT before rereading layout after effect reattachment', async () => {
    let stored = layout()
    const commit = deferred<void>()
    h.api.layout.mockImplementation(async () => structuredClone(stored))
    h.api.putLayout.mockImplementation(async (next: DashboardLayout) => { await commit.promise; stored = structuredClone(next); return stored })
    render(); effects(); await settle()
    swap(); await settle()
    expect(h.api.putLayout).toHaveBeenCalledTimes(1)
    hide(); show(); await settle()
    const readsBeforeCommit = h.api.layout.mock.calls.length
    commit.resolve(); await settle()
    expect(readsBeforeCommit).toBe(1)
    expect(h.slots[1]).toEqual(stored)
    expect(stored.slots).toEqual(['tokens', 'balance'])
  })
})


it('does not send a queued old-account save while effects are hidden during an account switch', async () => {
  const commit = deferred<void>()
  h.api.putLayout.mockImplementation(async (next: DashboardLayout) => { await commit.promise; return next })
  render(); effects(); await settle()
  swap(); await settle()
  swap(); await settle()
  hide()
  h.state.communityAuth = { status: 'signed_in', user: { id: 2 } }
  commit.resolve(); await settle()
  expect(h.api.putLayout).toHaveBeenCalledTimes(1)
  expect(h.state.notify).not.toHaveBeenCalled()
  render(); effects(); await settle()
  expect(h.slots[1]).toEqual(layout())
})

it('retains a save failure notice across effect reattachment', async () => {
  let reject!: (error: Error) => void
  h.api.putLayout.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  render(); effects(); await settle()
  swap(); await settle()
  hide(); show(); await settle()
  reject(new Error('isolated layout failure')); await settle()
  expect(h.slots[1]).toEqual(layout())
  expect(h.state.notify).toHaveBeenCalledWith(expect.stringContaining('isolated layout failure'))
  expect(h.slots[4]).toEqual(expect.stringContaining('布局自动保存失败'))
})
