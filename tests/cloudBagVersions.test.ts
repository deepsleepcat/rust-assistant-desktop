import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { CloudBagApi, CloudBagRepo } from '../src/services/cloudBagApi'

// 组件状态/回调回归 harness；不是 DOM/原生 GUI 测试，不伪造写盘成功。
const harness = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as unknown[], index: 0, refIndex: 0, save: vi.fn() }))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const slot = harness.index++
    if (!(slot in harness.values)) harness.values[slot] = initial
    return [harness.values[slot], (value: unknown) => {
      harness.values[slot] = typeof value === 'function' ? value(harness.values[slot]) : value
    }]
  },
  useRef: (initial: unknown) => {
    const slot = harness.refIndex++
    if (!(slot in harness.refs)) harness.refs[slot] = { current: initial }
    return harness.refs[slot]
  },
  useEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
}))
vi.mock('../src/services/bridge', () => ({ getBridge: () => ({ cloudbag: { saveRwmod: harness.save } }) }))
import { VersionsView } from '../src/features/community/CloudBagRepoVersions'

function nodes(node: unknown): ReactElement<{ children?: unknown; onClick?: () => Promise<void> }>[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<{ children?: unknown; onClick?: () => Promise<void> }>
  return [element, ...nodes(element.props.children)]
}
const repo = { slug: 'repo', headVersionNo: 3 } as CloudBagRepo
const version = (versionNo: number) => ({ id: versionNo, versionNo, parentVersionNo: null, message: 'v', manifest: {}, createdAt: 0 })

function render(api: CloudBagApi, onChanged = vi.fn()) {
  harness.index = harness.refIndex = 0
  return VersionsView({ api, repo, canWrite: true, onChanged })
}
function click(tree: unknown, label: string) {
  const button = nodes(tree).find((node) => node.type === 'button' && node.props.children === label)
  if (!button?.props.onClick) throw new Error(`missing button ${label}`)
  return button.props.onClick()
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(() => {
  harness.values = [[version(1)], null, false, null, null, null]
  harness.refs = []
  harness.save.mockReset()
  vi.stubGlobal('window', { confirm: () => true })
})

describe('VersionsView callbacks（非 GUI）', () => {
  it('下载等待桥完成；取消无成功文案；写盘失败回显错误', async () => {
    const bytes = new ArrayBuffer(22)
    const api = { exportRwmod: vi.fn(async () => ({ bytes, filename: 'test.rwmod' })) } as unknown as CloudBagApi
    let resolve!: (value: { canceled: true }) => void
    harness.save.mockImplementation(() => new Promise((done) => { resolve = done }))
    click(render(api), '下载 .rwmod')
    await settle()
    expect(harness.save).toHaveBeenCalledWith('test.rwmod', bytes)
    expect(harness.values[5]).toBe(null)
    resolve({ canceled: true })
    await settle()
    expect(harness.values[5]).toBe('已取消保存。')
    harness.save.mockRejectedValue(new Error('磁盘写入失败'))
    click(render(api), '下载 .rwmod')
    await settle()
    expect(harness.values[5]).toBe('磁盘写入失败')
    harness.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.rwmod', size: 22 })
    click(render(api), '下载 .rwmod')
    await settle()
    expect(harness.values[5]).toContain('已保存 C:/downloads/test.rwmod')
  })

  it('分页加载后回滚：重新请求第一页、替换旧页、显示新版本并刷新 head', async () => {
    harness.values[1] = 'older-page'
    const versions = vi.fn(async (_slug: string, cursor?: string) => cursor
      ? { items: [version(0)], nextCursor: null }
      : { items: [version(4), version(3)], nextCursor: 'older-page' })
    const api = { versions, pushVersion: vi.fn(async () => ({ versionNo: 4 })) } as unknown as CloudBagApi
    const changed = vi.fn()
    click(render(api, changed), '加载更多版本')
    await settle()
    expect((harness.values[0] as unknown[])).toHaveLength(2)
    click(render(api, changed), '回滚到此版本')
    await settle()
    expect(versions.mock.calls).toEqual([['repo', 'older-page'], ['repo', undefined]])
    expect(harness.values[0]).toEqual([version(4), version(3)])
    expect(changed).toHaveBeenCalledOnce()
  })
})
