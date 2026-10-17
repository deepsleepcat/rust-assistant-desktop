import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { packModBufferWithCount } from '../electron/modPack'
import { createMockBridge } from '../src/services/mockBridge'
import { createWorkspaceStore } from '../src/stores/workspace'
import type { ModPackProgress, ModPackProgressEvent } from '../src/types/modPack'

const tempDirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('真实归档进度', () => {
  it('读取计数来自源文件字节，清理后归档文件数不同；压缩回调不宣称保存完成', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-pack-progress-'))
    tempDirs.push(root)
    const source = '[core]\nname: 测试\n'
    await fs.writeFile(path.join(root, 'tank.ini'), source)
    await fs.writeFile(path.join(root, 'empty.ini'), ' \n')
    await fs.writeFile(path.join(root, 'sprite.png'), Buffer.from([0, 1, 2, 3]))
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, '.git', 'ignored'), 'ignored')
    const events: ModPackProgress[] = []
    const result = await packModBufferWithCount(root, { removeEmptyFiles: true }, (p) => events.push(p))
    const compressed = events.filter((p) => p.phase === 'compressing')
    expect(events[0]).toMatchObject({ phase: 'reading', filesRead: 0, bytesRead: 0 })
    expect(compressed[0]).toMatchObject({ filesRead: 3, bytesRead: Buffer.byteLength(source) + 2 + 4, files: 2 })
    expect(compressed.at(-1)?.percent).toBe(100)
    const percentages = compressed.map((p) => p.percent!)
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b))
    expect(events.every((p) => p.phase === 'reading' || p.phase === 'compressing')).toBe(true)
    const zip = await JSZip.loadAsync(result.buffer)
    expect(await zip.file('tank.ini')?.async('string')).toBe(source)
    expect(zip.file('empty.ini')).toBeNull()
    expect(zip.file('.git/ignored')).toBeNull()
  })

  it('空目录也会真实完成压缩，不要求有文件才能报告进度', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-pack-empty-'))
    tempDirs.push(root)
    const events: ModPackProgress[] = []
    const result = await packModBufferWithCount(root, {}, (p) => events.push(p))
    expect(result.files).toBe(0)
    expect(events.at(-1)).toMatchObject({ phase: 'compressing', filesRead: 0, bytesRead: 0, percent: 100 })
  })
})

async function setup() {
  const bridge = createMockBridge()
  const store = createWorkspaceStore(bridge)
  await store.getState().init()
  await store.getState().openProject()
  let listener: ((p: ModPackProgressEvent) => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  bridge.mod.onPackProgress = vi.fn((callback) => {
    listener = callback
    return unsubscribe
  })
  return { bridge, store, unsubscribe, emit: (event: ModPackProgressEvent) => listener?.(event), getListener: () => listener }
}

describe('打包任务状态与事件生命周期', () => {
  it('订阅早于invoke；重复启动被挡住；忽略其他任务；切项目保留归属；取消后移除监听', async () => {
    const { bridge, store, emit, unsubscribe, getListener } = await setup()
    let finish!: (result: { canceled: true }) => void
    let staleListener: ((p: ModPackProgressEvent) => void) | undefined
    const pack = vi.fn((_root, _options, requestId: string | undefined) => {
      expect(getListener()).toBeTypeOf('function')
      staleListener = getListener()
      emit({ requestId: requestId!, phase: 'awaiting-save', files: 2 })
      return new Promise<{ canceled: true }>((resolve) => { finish = resolve })
    })
    bridge.mod.pack = pack
    const running = store.getState().packModWithOptions({})
    const task = store.getState().modPackTask!
    expect(task).toMatchObject({ phase: 'awaiting-save', busy: true })
    emit({ requestId: 'other-task', phase: 'failed' })
    expect(store.getState().modPackTask?.phase).toBe('awaiting-save')
    await store.getState().packModWithOptions({})
    await store.getState().packModProject()
    expect(pack).toHaveBeenCalledTimes(1)
    expect(store.getState().modDialog).toBeNull()
    store.setState({ activeProjectId: null })
    expect(store.getState().modPackTask?.projectName).toBe(task.projectName)
    finish({ canceled: true })
    await running
    expect(store.getState().modPackTask).toMatchObject({ phase: 'canceled', busy: false })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    staleListener?.({ requestId: task.requestId, phase: 'compressing', percent: 99 })
    expect(store.getState().modPackTask?.phase).toBe('canceled')
  })

  it('写盘失败保留明确错误并解锁，重试成功只响应新任务事件', async () => {
    const { bridge, store, emit, unsubscribe, getListener } = await setup()
    let oldListener: ((p: ModPackProgressEvent) => void) | undefined
    bridge.mod.pack = vi.fn(async (_root, _options, requestId) => {
      oldListener = getListener()
      emit({ requestId: requestId!, phase: 'writing', files: 1 })
      throw new Error('EACCES: 写入被拒绝')
    })
    await store.getState().packModWithOptions({})
    const oldId = store.getState().modPackTask!.requestId
    expect(store.getState().modPackTask).toMatchObject({ phase: 'failed', busy: false, message: 'EACCES: 写入被拒绝' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    bridge.mod.pack = vi.fn(async (_root, _options, requestId) => {
      expect(requestId).not.toBe(oldId)
      oldListener?.({ requestId: oldId, phase: 'failed', message: 'stale' })
      expect(store.getState().modPackTask?.phase).toBe('reading')
      return { canceled: false as const, files: 1, filePath: '/test/mod.rwmod', size: 123 }
    })
    await store.getState().packModWithOptions({})
    expect(store.getState().modPackTask).toMatchObject({ phase: 'completed', busy: false, files: 1, message: '已保存：/test/mod.rwmod' })
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('部署覆盖取消为canceled；配置/业务失败为failed；兼容没有进度事件的旧桥', async () => {
    const { bridge, store, unsubscribe } = await setup()
    store.setState({ settings: { ...store.getState().settings, gamePath: '/test/game' } })
    vi.stubGlobal('window', { confirm: vi.fn(() => false) })
    bridge.mod.packAndDeploy = vi.fn(async () => ({ ok: false as const, code: 'EXISTS' as const, filePath: '/test/game/a.rwmod', message: 'exists' }))
    await store.getState().packModWithOptions({}, true)
    expect(store.getState().modPackTask).toMatchObject({ phase: 'canceled', busy: false })
    expect(bridge.mod.packAndDeploy).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    bridge.mod.packAndDeploy = vi.fn(async () => ({ ok: false as const, message: '游戏目录校验失败' }))
    await store.getState().packModWithOptions({}, true)
    expect(store.getState().modPackTask).toMatchObject({ phase: 'failed', busy: false, message: '游戏目录校验失败' })
    delete bridge.mod.onPackProgress
    bridge.mod.pack = vi.fn(async () => ({ canceled: true as const }))
    await store.getState().packModWithOptions({})
    expect(store.getState().modPackTask).toMatchObject({ phase: 'canceled', busy: false })
  })
})
