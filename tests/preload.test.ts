/**
 * preload 桥契约测试（M26 审查 L4：preload.ts 此前零测试）。
 * 用假 electron 捕获 exposeInMainWorld 暴露的 API，验证：
 * 1) 暴露键为 rustAssistant；
 * 2) 各域方法映射到与主进程注册一致的 IPC 通道名（跨域抽查）；
 * 3) 事件订阅（onAiEvent/onUpdateEvent/onBeforeClose）返回可注销的取消函数。
 */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn((_key: string, _api: unknown) => undefined),
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => ({ version: '0.0.0-test' })),
  on: vi.fn((_channel: string, _listener: unknown) => undefined),
  removeListener: vi.fn((_channel: string, _listener: unknown) => undefined),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}))

// 触发 preload 模块（模块级：注册暴露 + 拉取版本）
import '../electron/preload'

/** 暴露出的桥对象（假 electron 捕获） */
function api(): Record<string, unknown> {
  const call = mocks.exposeInMainWorld.mock.calls[0]
  if (!call) throw new Error('exposeInMainWorld 未被调用')
  return call[1] as Record<string, unknown>
}

describe('preload 桥契约', () => {
  it('暴露 window.rustAssistant，且各域齐全', () => {
    expect(mocks.exposeInMainWorld).toHaveBeenCalledWith('rustAssistant', expect.any(Object))
    const a = api()
    for (const key of ['app', 'store', 'project', 'avatar', 'knowledge', 'game', 'mod', 'git', 'ai']) {
      expect(a[key]).toBeTypeOf('object')
    }
  })

  it('启动时经 app:info 拉取版本', async () => {
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'app:info')).toBe(true)
  })

  it('项目/文件域方法映射到正确通道', async () => {
    const p = api().project as Record<string, (...a: unknown[]) => Promise<unknown>>
    await p.readDir('r', 'd', true)
    expect(mocks.invoke).toHaveBeenLastCalledWith('fs:readDir', 'r', 'd', true)
    await p.readFile('r', 'f')
    expect(mocks.invoke).toHaveBeenLastCalledWith('fs:readFile', 'r', 'f')
    await p.writeFile('r', 'f', 'c', { hasBom: true })
    expect(mocks.invoke).toHaveBeenLastCalledWith('fs:writeFile', 'r', 'f', 'c', { hasBom: true })
    await p.saveText('t', 'n', 'c')
    expect(mocks.invoke).toHaveBeenLastCalledWith('dialog:saveText', 't', 'n', 'c')
    await p.openFolderDialog()
    expect(mocks.invoke).toHaveBeenLastCalledWith('dialog:openFolder')
    await p.registerRoots(['C:\\x'])
    expect(mocks.invoke).toHaveBeenLastCalledWith('project:registerRoots', ['C:\\x'])
  })

  it('AI 域方法映射到正确通道', async () => {
    const ai = api().ai as Record<string, (...a: unknown[]) => Promise<unknown>>
    await ai.stream({ messages: [] }, { provider: 'deepseek' }, 'root')
    expect(mocks.invoke).toHaveBeenLastCalledWith('ai:stream', { messages: [] }, { provider: 'deepseek' }, 'root')
    await ai.approve({ id: 'x', approved: true })
    expect(mocks.invoke).toHaveBeenLastCalledWith('ai:approval:respond', { id: 'x', approved: true })
    await ai.historyRestore('r', 'units/a.ini', 'snap-1')
    expect(mocks.invoke).toHaveBeenLastCalledWith('ai:history:restore', 'r', 'units/a.ini', 'snap-1')
  })

  it('模组/游戏/git/知识包/商店域抽查', async () => {
    const a = api()
    const mod = a.mod as Record<string, (...x: unknown[]) => Promise<unknown>>
    await mod.pack('r', {})
    expect(mocks.invoke).toHaveBeenLastCalledWith('mod:pack', 'r', {})
    await mod.globalOp('r', { kind: 'replace' })
    expect(mocks.invoke).toHaveBeenLastCalledWith('mod:globalOp', 'r', { kind: 'replace' })
    const game = a.game as Record<string, (...x: unknown[]) => Promise<unknown>>
    await game.importMod('g', 'm.rwmod', 'r')
    expect(mocks.invoke).toHaveBeenLastCalledWith('game:importMod', 'g', 'm.rwmod', 'r')
    const git = a.git as Record<string, (...x: unknown[]) => Promise<unknown>>
    await git.restore('r', 'units/a.ini', 'HEAD')
    expect(mocks.invoke).toHaveBeenLastCalledWith('git:restore', 'r', 'units/a.ini', 'HEAD')
    const knowledge = a.knowledge as Record<string, (...x: unknown[]) => Promise<unknown>>
    await knowledge.readDataFile('code.json')
    expect(mocks.invoke).toHaveBeenLastCalledWith('knowledge:readDataFile', 'code.json')
    await knowledge.update('https://example.com/data.json')
    expect(mocks.invoke).toHaveBeenLastCalledWith('knowledge:update', 'https://example.com/data.json')
    const store = a.store as Record<string, (...x: unknown[]) => Promise<unknown>>
    await store.get('settings')
    expect(mocks.invoke).toHaveBeenLastCalledWith('store:get', 'settings')
  })

  it('事件订阅：onAiEvent 监听 ai:stream，返回的注销函数移除监听', () => {
    const ai = api().ai as { onAiEvent: (cb: (e: unknown) => void) => () => void }
    const cb = vi.fn()
    const unsubscribe = ai.onAiEvent(cb)
    expect(mocks.on).toHaveBeenCalledWith('ai:stream', expect.any(Function))
    const listener = mocks.on.mock.calls[0][1] as (ev: unknown, data: unknown) => void
    // 模拟主进程推送：回调收到事件数据
    listener({}, { type: 'delta', text: '你好' })
    expect(cb).toHaveBeenCalledWith({ type: 'delta', text: '你好' })
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('ai:stream', listener)
  })

  it('事件订阅：onUpdateEvent 监听 app:update，onBeforeClose 监听 app:before-close', () => {
    const app = api().app as {
      onUpdateEvent: (cb: (e: unknown) => void) => () => void
      onBeforeClose: (cb: () => void) => () => void
    }
    const updateCb = vi.fn()
    app.onUpdateEvent(updateCb)
    expect(mocks.on).toHaveBeenCalledWith('app:update', expect.any(Function))
    const beforeCloseCb = vi.fn()
    app.onBeforeClose(beforeCloseCb)
    expect(mocks.on).toHaveBeenCalledWith('app:before-close', expect.any(Function))
  })
})
