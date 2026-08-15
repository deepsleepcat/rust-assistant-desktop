/**
 * IPC 注册层测试（第一线 ②：补核心链路测试——IPC 通道注册与处理器安全边界）。
 * electron/ipc.ts 与 electron 运行时解耦：用假 ipc/假依赖直接调用各域注册函数。
 * 覆盖：通道完整性、store 保留键/大小上限、fs 路径安全、信任锚登记、
 * AI 审批/中止/流守卫、历史恢复、对话框流程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../electron/store'
import { createKnowledgePack } from '../electron/knowledgePack'
import { initAiHistory, getHistory } from '../electron/aiHistory'
import { normalizePath } from '../electron/paths'
import {
  createIpcContext,
  registerAiIpc,
  registerAppIpc,
  registerDialogIpc,
  registerFsIpc,
  registerGameIpc,
  registerGitIpc,
  registerKnowledgeIpc,
  registerModIpc,
  registerStoreIpc,
  registerMediaFromSettings,
  restoreMediaAllowlist,
  restoreProjectRoots,
  type IpcContext,
  type RegisterHandler,
} from '../electron/ipc'
import type { AiApprovalResponse } from '../src/types/ai'

/** 假 ipc：把通道名 → 处理器记录进 Map */
function createFakeIpc(): { channels: Map<string, (...args: never[]) => unknown>; ipc: RegisterHandler } {
  const channels = new Map<string, (...args: never[]) => unknown>()
  const ipc: RegisterHandler = (channel, handler) => {
    channels.set(channel, handler)
  }
  return { channels, ipc }
}

/** 调用已注册的处理器（event 用 undefined 占位；返回 Promise 结果） */
async function invoke<T>(channels: Map<string, (...args: never[]) => unknown>, channel: string, ...args: unknown[]): Promise<T> {
  const h = channels.get(channel)
  if (!h) throw new Error(`通道未注册：${channel}`)
  return (h as (...a: unknown[]) => unknown)(undefined, ...args) as Promise<T>
}

/** 调用需要真实 event 对象的处理器（如 ai:stream 解构 event.sender） */
async function invokeWithEvent<T>(
  channels: Map<string, (...args: never[]) => unknown>,
  channel: string,
  event: unknown,
  ...args: unknown[]
): Promise<T> {
  const h = channels.get(channel)
  if (!h) throw new Error(`通道未注册：${channel}`)
  return (h as (...a: unknown[]) => unknown)(event, ...args) as Promise<T>
}

/** 1x1 透明 PNG（base64）：avatar:saveCropped 魔数校验用 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let tmp: string
let ctx: IpcContext
let cleanup: () => Promise<void>

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-ipc-'))
  const store = createStore(path.join(tmp, 'state.json'))
  initAiHistory(path.join(tmp, 'ai-history.json'))
  ctx = createIpcContext({
    store,
    knowledgePack: createKnowledgePack(path.join(tmp, 'kp'), path.join(tmp, 'builtin')),
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    shell: { trashItem: async () => undefined },
    app: { getVersion: () => '0.0.0-test', getPath: (n) => (n === 'userData' ? tmp : tmp) },
    updater: {
      checkForUpdates: async () => undefined,
      downloadUpdate: async () => undefined,
      quitAndInstall: () => undefined,
      isPackaged: () => false,
    },
    windows: { getAllWindows: () => [] },
  })
  await store.ready()
  cleanup = async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

afterEach(async () => {
  await cleanup()
})

describe('IPC 通道完整性', () => {
  it('九个域注册函数覆盖全部 69 个通道，无遗漏无重复', () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    registerKnowledgeIpc(ctx, ipc)
    registerGitIpc(ctx, ipc)
    registerDialogIpc(ctx, ipc)
    registerFsIpc(ctx, ipc)
    registerModIpc(ctx, ipc)
    registerGameIpc(ctx, ipc)
    registerAppIpc(ctx, ipc)
    registerAiIpc(ctx, ipc)

    const expected = [
      // store
      'store:get', 'store:set',
      // knowledge
      'knowledge:readDataFile', 'knowledge:info', 'knowledge:checkUpdate', 'knowledge:update', 'knowledge:rollback',
      // git
      'git:info', 'git:log', 'git:status', 'git:conflicts', 'git:diff', 'git:restore',
      // dialog + project
      'dialog:openFolder', 'dialog:openImage', 'dialog:saveText', 'project:registerRoots',
      // fs + media
      'fs:readDir', 'fs:readFile', 'fs:stat', 'fs:writeFile', 'fs:createFile', 'fs:createFolder', 'fs:rename', 'fs:delete',
      'image:readAsDataUrl', 'media:readAsDataUrl',
      // mod + template
      'mod:create', 'mod:createUnit', 'mod:listTemplates', 'mod:saveFileAsTemplate', 'mod:createUnitFromTemplate',
      'mod:pack', 'mod:check', 'mod:readModInfo', 'mod:writeModInfo', 'mod:scanResources', 'mod:scanUnits',
      'mod:optimizeScan', 'mod:optimizeApply', 'mod:globalOp', 'mod:chooseMusic', 'mod:import', 'mod:discardImport',
      'template:import', 'template:deleteUser', 'template:listUserKeys',
      // game
      'game:detect', 'game:importSample', 'game:importMod', 'game:launch', 'game:openDir', 'game:preflight', 'game:readAssetImage',
      // app + avatar
      'app:info', 'app:flush-done', 'app:checkUpdate', 'app:downloadUpdate', 'app:installUpdate',
      'avatar:chooseLocal', 'avatar:saveCropped', 'avatar:uploadCommunity',
      // ai
      'ai:check', 'ai:info', 'ai:approval:respond', 'ai:stream:abort', 'ai:history:list', 'ai:history:restore', 'ai:stream',
    ]
    expect([...channels.keys()].sort()).toEqual([...expected].sort())
    expect(channels.size).toBe(69)
  })
})

describe('store 通道', () => {
  it('store:get/set 读写往返', async () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    await invoke(channels, 'store:set', 'myKey', { a: 1 })
    expect(await invoke(channels, 'store:get', 'myKey')).toEqual({ a: 1 })
  })

  it('系统保留键拒绝渲染层写入', async () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    await expect(invoke(channels, 'store:set', 'projectRoots', ['C:\\x'])).rejects.toThrow('不允许写入系统保留键')
    await expect(invoke(channels, 'store:set', 'mediaAllowlist', ['C:\\x'])).rejects.toThrow('不允许写入系统保留键')
  })

  it('超限值拒绝写入（10MB 上限；workspace 键放宽 50MB）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    await expect(invoke(channels, 'store:set', 'settings', { big: 'x'.repeat(10 * 1024 * 1024 + 1) })).rejects.toThrow('写入的数据过大')
    // workspace 键 50MB 内放行
    await invoke(channels, 'store:set', 'workspace', { big: 'x'.repeat(20 * 1024 * 1024) })
    expect(await invoke(channels, 'store:get', 'workspace')).toHaveProperty('big')
  })
})

describe('fs 通道（路径安全边界）', () => {
  async function setupRooted(): Promise<Map<string, (...args: never[]) => unknown>> {
    const { channels, ipc } = createFakeIpc()
    registerFsIpc(ctx, ipc)
    // 登记项目根（等价于 dialog:openFolder 后的状态）
    ctx.roots.add(normalizePath(tmp))
    await fs.mkdir(path.join(tmp, 'units'))
    return channels
  }

  it('未登记的项目根拒绝访问', async () => {
    const { channels, ipc } = createFakeIpc()
    registerFsIpc(ctx, ipc)
    await expect(invoke(channels, 'fs:readDir', path.join(tmp, 'units'), path.join(tmp, 'units'))).rejects.toThrow('未登记的项目目录')
  })

  it('越界路径拒绝（.. 穿越与根外绝对路径）', async () => {
    const channels = await setupRooted()
    const outside = path.join(os.tmpdir(), 'ra-outside-' + Date.now())
    await expect(invoke(channels, 'fs:readFile', tmp, outside)).rejects.toThrow('超出项目目录范围')
    await expect(invoke(channels, 'fs:readFile', tmp, path.join(tmp, '..', '..', 'Windows', 'win.ini'))).rejects.toThrow()
  })

  it('readDir/readFile/stat/writeFile 全流程（含 BOM 写入）', async () => {
    const channels = await setupRooted()
    await invoke(channels, 'fs:writeFile', tmp, path.join(tmp, 'units', 'a.txt'), '你好', { hasBom: true })
    const read = await invoke<{ content: string; hasBom: boolean }>(channels, 'fs:readFile', tmp, path.join(tmp, 'units', 'a.txt'))
    expect(read.content).toBe('你好')
    expect(read.hasBom).toBe(true)
    const st = await invoke<{ size: number }>(channels, 'fs:stat', tmp, path.join(tmp, 'units', 'a.txt'))
    expect(st.size).toBeGreaterThan(0)
    const dir = await invoke<Array<{ name: string }>>(channels, 'fs:readDir', tmp, path.join(tmp, 'units'))
    expect(dir.map((e) => e.name)).toContain('a.txt')
  })

  it('createFile 非法名（保留名 CON）与已存在拒绝', async () => {
    const channels = await setupRooted()
    await expect(invoke(channels, 'fs:createFile', tmp, path.join(tmp, 'units'), 'CON')).rejects.toThrow('系统保留名')
    await expect(invoke(channels, 'fs:createFile', tmp, path.join(tmp, 'units'), 'a<b')).rejects.toThrow('非法字符')
    await invoke(channels, 'fs:createFile', tmp, path.join(tmp, 'units'), 'b.txt')
    await expect(invoke(channels, 'fs:createFile', tmp, path.join(tmp, 'units'), 'b.txt')).rejects.toThrow('已存在同名文件')
  })

  it('rename 目标已存在拒绝；createFolder 后 rename 成功', async () => {
    const channels = await setupRooted()
    await invoke(channels, 'fs:createFile', tmp, path.join(tmp, 'units'), 'x.txt')
    await invoke(channels, 'fs:createFile', tmp, path.join(tmp, 'units'), 'y.txt')
    await expect(invoke(channels, 'fs:rename', tmp, path.join(tmp, 'units', 'x.txt'), path.join(tmp, 'units', 'y.txt'))).rejects.toThrow('已存在同名')
    await invoke(channels, 'fs:createFolder', tmp, tmp, '新目录')
    await invoke(channels, 'fs:rename', tmp, path.join(tmp, 'units', 'x.txt'), path.join(tmp, '新目录', 'x.txt'))
    expect(await fs.stat(path.join(tmp, '新目录', 'x.txt'))).toBeTruthy()
  })

  it('delete 走回收站（shell.trashItem 被调用）', async () => {
    const trash = vi.fn(async () => undefined)
    ctx.shell = { trashItem: trash }
    const { channels, ipc } = createFakeIpc()
    registerFsIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    const file = path.join(tmp, 'del.txt')
    await fs.writeFile(file, 'x', 'utf8')
    await invoke(channels, 'fs:delete', tmp, file)
    expect(trash).toHaveBeenCalledWith(file)
  })
})

describe('对话框与信任锚', () => {
  it('dialog:openFolder 登记项目根并返回', async () => {
    const { channels, ipc } = createFakeIpc()
    registerDialogIpc(ctx, ipc)
    const folder = path.join(tmp, 'proj')
    await fs.mkdir(folder)
    ctx.dialog = {
      ...ctx.dialog,
      showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }),
    }
    const result = await invoke<{ rootPath: string; name: string }>(channels, 'dialog:openFolder')
    expect(result.rootPath).toBe(folder)
    expect(ctx.roots.has(normalizePath(folder))).toBe(true)
    // 信任锚已持久化
    expect(ctx.store.get('projectRoots')).toContain(normalizePath(folder))
  })

  it('dialog:saveText 写入用户选择的文件', async () => {
    const { channels, ipc } = createFakeIpc()
    registerDialogIpc(ctx, ipc)
    const target = path.join(tmp, 'report.txt')
    ctx.dialog = {
      ...ctx.dialog,
      showSaveDialog: async () => ({ canceled: false, filePath: target }),
    }
    const result = await invoke<{ ok: boolean; path?: string }>(channels, 'dialog:saveText', '标题', 'report.txt', '内容abc')
    expect(result.ok).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('内容abc')
  })

  it('project:registerRoots 只接受信任锚内路径', async () => {
    const { channels, ipc } = createFakeIpc()
    registerDialogIpc(ctx, ipc)
    const known = path.join(tmp, 'known')
    const unknown = path.join(tmp, 'unknown')
    await fs.mkdir(known)
    // 预置信任锚（模拟历史会话已登记）
    await ctx.store.set('projectRoots', [normalizePath(known)])
    restoreProjectRoots(ctx)
    await invoke(channels, 'project:registerRoots', [known, unknown])
    expect(ctx.roots.has(normalizePath(known))).toBe(true)
    expect(ctx.roots.has(normalizePath(unknown))).toBe(false)
  })
})

describe('AI 通道', () => {
  function setupAi(): Map<string, (...args: never[]) => unknown> {
    const { channels, ipc } = createFakeIpc()
    registerAiIpc(ctx, ipc)
    return channels
  }

  it('ai:check：未知提供者/未配 Key/社区占位均返回可读信息（不触网）', async () => {
    const channels = setupAi()
    const unknown = await invoke<{ ok: boolean; message: string }>(channels, 'ai:check', { provider: 'x' })
    expect(unknown.ok).toBe(false)
    expect(unknown.message).toContain('未知的 AI 提供者')
    const noKey = await invoke<{ ok: boolean; message: string }>(channels, 'ai:check', { provider: 'deepseek', deepseekApiKey: '' })
    expect(noKey.message).toContain('未配置 DeepSeek API Key')
    const community = await invoke<{ ok: boolean; message: string }>(channels, 'ai:check', { provider: 'community', endpoint: '', token: '' })
    expect(community.message).toContain('即将上线')
  })

  it('ai:info 列出提供者', async () => {
    const channels = setupAi()
    const info = await invoke<{ providers: Array<{ type: string }> }>(channels, 'ai:info')
    expect(info.providers.map((p) => p.type)).toContain('deepseek')
  })

  it('ai:approval:respond：按 id 匹配，过期/错误 id 一律忽略', async () => {
    const channels = setupAi()
    let resolved: AiApprovalResponse | null = null
    ctx.ai.pendingApproval = { id: 'a1', resolve: (r) => { resolved = r } }
    // 错误 id → false，不 resolve
    expect(await invoke(channels, 'ai:approval:respond', { id: 'other', approved: true })).toBe(false)
    expect(resolved).toBeNull()
    // 正确 id → true + resolve + 清空
    expect(await invoke(channels, 'ai:approval:respond', { id: 'a1', approved: true })).toBe(true)
    expect(resolved).toEqual({ id: 'a1', approved: true })
    expect(ctx.ai.pendingApproval).toBeNull()
    // 已清空后再响应 → false
    expect(await invoke(channels, 'ai:approval:respond', { id: 'a1', approved: false })).toBe(false)
  })

  it('ai:stream:abort：置取消标志、硬停止、拒绝在途审批、释放锁', async () => {
    const channels = setupAi()
    const abort = vi.fn()
    let rejected: AiApprovalResponse | null = null
    ctx.ai.streamActive = true
    const cancel = { current: false, abort }
    ctx.ai.cancel = cancel
    ctx.ai.pendingApproval = { id: 'p1', resolve: (r) => { rejected = r } }
    const result = await invoke<{ aborted: boolean }>(channels, 'ai:stream:abort')
    expect(result.aborted).toBe(true)
    expect(cancel.current).toBe(true)
    expect(abort).toHaveBeenCalled()
    expect(rejected).toEqual({ id: 'p1', approved: false })
    expect(ctx.ai.streamActive).toBe(false)
    // 无活动流 → aborted:false
    expect(await invoke<{ aborted: boolean }>(channels, 'ai:stream:abort')).toEqual({ aborted: false })
  })

  it('ai:stream：活动流互斥', async () => {
    const channels = setupAi()
    ctx.ai.streamActive = true
    await expect(invoke(channels, 'ai:stream', { messages: [] }, { provider: 'community' }, tmp)).rejects.toThrow('已有 AI 请求')
  })

  it('ai:stream：项目未登记拒绝', async () => {
    const channels = setupAi()
    const event = { sender: { isDestroyed: () => false, send: () => undefined } }
    await expect(invokeWithEvent(channels, 'ai:stream', event, { messages: [] }, { provider: 'community' }, tmp)).rejects.toThrow('项目未登记')
  })

  it('ai:stream：消息超限拒绝（>200 条 / >2MB）', async () => {
    const channels = setupAi()
    ctx.roots.add(normalizePath(tmp))
    const event = { sender: { isDestroyed: () => false, send: () => undefined } }
    const many = Array.from({ length: 201 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }))
    await expect(invokeWithEvent(channels, 'ai:stream', event, { messages: many }, { provider: 'community' }, tmp)).rejects.toThrow('对话历史过长')
    const huge = [{ role: 'user' as const, content: 'x'.repeat(2 * 1024 * 1024 + 1) }]
    await expect(invokeWithEvent(channels, 'ai:stream', event, { messages: huge }, { provider: 'community' }, tmp)).rejects.toThrow('对话历史过大')
  })

  it('ai:stream：社区提供者发错误事件并释放锁（不触网）', async () => {
    const channels = setupAi()
    ctx.roots.add(normalizePath(tmp))
    const sent: Array<{ type: string; message?: string }> = []
    const fakeSender = { isDestroyed: () => false, send: (_ch: string, e: unknown) => { sent.push(e as { type: string }) } }
    const result = await invokeWithEvent(channels, 'ai:stream', { sender: fakeSender }, { messages: [{ role: 'user', content: 'hi' }] }, { provider: 'community' }, tmp)
    expect(result).toBe('ai:stream')
    expect(sent[0]).toMatchObject({ type: 'error' })
    expect(ctx.ai.streamActive).toBe(false)
    expect(ctx.ai.cancel).toBeNull()
  })

  it('ai:history:list/restore：登记根内相对路径可列出/恢复，越界拒绝', async () => {
    const channels = setupAi()
    ctx.roots.add(normalizePath(tmp))
    await fs.mkdir(path.join(tmp, 'units'))
    const id = (await getHistory().addSnapshot(tmp, 'units/a.txt', '历史内容'))!
    const list = await invoke<Array<{ id: string }>>(channels, 'ai:history:list', tmp, 'units/a.txt')
    expect(list.map((e) => e.id)).toContain(id)
    const restored = await invoke<{ ok: boolean }>(channels, 'ai:history:restore', tmp, 'units/a.txt', id)
    expect(restored.ok).toBe(true)
    expect(await fs.readFile(path.join(tmp, 'units', 'a.txt'), 'utf8')).toBe('历史内容')
    // 越界 relPath（.. 穿越）拒绝
    await expect(invoke(channels, 'ai:history:list', tmp, '../secret.txt')).rejects.toThrow('无效的文件路径')
  })
})

describe('mod / game / app 通道', () => {
  it('mod:create：未经选择的音乐源拒绝（防任意路径读入转码）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    await expect(
      invoke(channels, 'mod:create', tmp, { musicFiles: ['C:\\任意\\a.mp3'] }),
    ).rejects.toThrow('未经选择的音频文件')
    // 未登记项目根也拒绝
    await expect(invoke(channels, 'mod:create', path.join(tmp, 'nope'), {})).rejects.toThrow('未登记的项目目录')
  })

  it('mod:pack：互斥锁生效', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    ctx.packing.active = true
    await expect(invoke(channels, 'mod:pack', tmp)).rejects.toThrow('已有打包任务')
  })

  it('mod:discardImport：只清理本次会话导入的目录', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    const notImported = path.join(tmp, 'keep')
    await fs.mkdir(notImported)
    const imported = path.join(tmp, 'discard-me')
    await fs.mkdir(imported)
    ctx.importedDirs.add(normalizePath(imported))
    ctx.roots.add(normalizePath(imported))
    expect(await invoke<{ ok: boolean }>(channels, 'mod:discardImport', notImported)).toEqual({ ok: false })
    expect(await invoke<{ ok: boolean }>(channels, 'mod:discardImport', imported)).toEqual({ ok: true })
    expect(ctx.roots.has(normalizePath(imported))).toBe(false)
    await expect(fs.stat(imported)).rejects.toThrow()
  })

  it('game:openDir / preflight：未登记根拒绝', async () => {
    const { channels, ipc } = createFakeIpc()
    registerGameIpc(ctx, ipc)
    const empty = await invoke<{ ok: boolean; message?: string }>(channels, 'game:openDir', '')
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain('目录为空')
    const unregistered = await invoke<{ ok: boolean; message?: string }>(channels, 'game:openDir', tmp)
    expect(unregistered.ok).toBe(false)
    expect(unregistered.message).toContain('未登记')
    const pre = await invoke<{ ok: boolean }>(channels, 'game:preflight', tmp)
    expect(pre.ok).toBe(false)
  })

  it('app:info / flush-done / installUpdate', async () => {
    const { channels, ipc } = createFakeIpc()
    registerAppIpc(ctx, ipc)
    expect(await invoke<{ version: string }>(channels, 'app:info')).toEqual({ version: '0.0.0-test', platform: process.platform })

    // flush-done：before-quit 路径（flushResolve 挂起 → 调用后 resolve）
    let flushed = false
    ctx.lifecycle.flushResolve = () => { flushed = true }
    expect(await invoke<boolean>(channels, 'app:flush-done')).toBe(true)
    expect(flushed).toBe(true)

    // flush-done：close 路径（无 flushResolve → 销毁窗口）
    const destroy = vi.fn()
    ctx.windows = { getAllWindows: () => [{ isDestroyed: () => false, destroy }] }
    expect(await invoke<boolean>(channels, 'app:flush-done')).toBe(true)
    expect(destroy).toHaveBeenCalled()

    // installUpdate：退出流程中 → 直接 false（不弹框）
    ctx.lifecycle.quitting = true
    expect(await invoke<boolean>(channels, 'app:installUpdate')).toBe(false)

    // installUpdate：用户点「稍后再说」（response 0）→ false
    ctx.lifecycle.quitting = false
    expect(await invoke<boolean>(channels, 'app:installUpdate')).toBe(false)

    // installUpdate：用户点「重启并安装」（response 1）→ 调用 quitAndInstall
    const quitAndInstall = vi.fn()
    ctx.updater.quitAndInstall = quitAndInstall
    ctx.dialog = { ...ctx.dialog, showMessageBox: async () => ({ response: 1, checkboxChecked: false }) }
    expect(await invoke<boolean>(channels, 'app:installUpdate')).toBe(true)
    expect(quitAndInstall).toHaveBeenCalled()
  })

  it('avatar:saveCropped：非法数据拒绝，合法 PNG 写入并登记媒体', async () => {
    const { channels, ipc } = createFakeIpc()
    registerAppIpc(ctx, ipc)
    await expect(invoke(channels, 'avatar:saveCropped', 'data:image/png;base64,not-png!')).rejects.toThrow('不是有效的 PNG')
    const file = await invoke<string>(channels, 'avatar:saveCropped', `data:image/png;base64,${TINY_PNG}`)
    expect(file).toBe(path.join(tmp, 'avatar.png'))
    expect(ctx.media.has(normalizePath(file))).toBe(true)
  })

  it('git 通道参数校验与项目根登记校验（M3 加固）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerGitIpc(ctx, ipc)
    await expect(invoke(channels, 'git:restore', 123, 'a.txt', 'HEAD')).rejects.toThrow('参数错误')
    await expect(invoke(channels, 'git:info', '')).rejects.toThrow('参数错误')
    // 未登记项目根：一律拒绝（git:restore 是写操作，不得对任意目录执行）
    await expect(invoke(channels, 'git:info', tmp)).rejects.toThrow('未登记的项目目录')
    await expect(invoke(channels, 'git:restore', tmp, 'a.txt', 'HEAD')).rejects.toThrow('未登记的项目目录')
    // 登记后可调用（非仓库目录返回可用性信息，不抛错）
    ctx.roots.add(normalizePath(tmp))
    const info = await invoke<{ isRepo: boolean }>(channels, 'git:info', tmp)
    expect(info.isRepo).toBe(false)
  })

  it('knowledge:readDataFile 参数校验', async () => {
    const { channels, ipc } = createFakeIpc()
    registerKnowledgeIpc(ctx, ipc)
    await expect(invoke(channels, 'knowledge:readDataFile', 42)).rejects.toThrow('参数错误')
  })
})

describe('安全加固（第一线审查 M2：媒体信任/上限/白名单）', () => {
  it('restoreMediaAllowlist：从持久化锚恢复媒体信任（旧版迁移只做一次）', async () => {
    const file = path.join(tmp, 'bg.png')
    await fs.writeFile(file, Buffer.from(TINY_PNG, 'base64'))
    await ctx.store.set('mediaAllowlist', [normalizePath(file)])
    restoreMediaAllowlist(ctx)
    expect(ctx.media.has(normalizePath(file))).toBe(true)
    // 渲染层无法用伪造锚扩张：只有锚里有的路径才被恢复
    const evil = path.join(tmp, 'evil.png')
    expect(ctx.media.has(normalizePath(evil))).toBe(false)
  })

  it('registerMediaFromSettings：只保持已有信任的路径，不新增信任', async () => {
    const trusted = path.join(tmp, 'trusted.png')
    const untrusted = path.join(tmp, 'untrusted.png')
    ctx.media.add(normalizePath(trusted))
    registerMediaFromSettings(ctx, { background: { imagePath: trusted }, avatar: { localPath: untrusted } })
    expect(ctx.media.has(normalizePath(trusted))).toBe(true)
    expect(ctx.media.has(normalizePath(untrusted))).toBe(false)
  })

  it('media:readAsDataUrl：空 rootPath 只读已登记媒体；项目内路径走根校验', async () => {
    const { channels, ipc } = createFakeIpc()
    registerFsIpc(ctx, ipc)
    const file = path.join(tmp, 'preview.ogg')
    await fs.writeFile(file, Buffer.from('OggS 假音频数据'))
    // 未登记 → 拒绝（媒体信任不扩张）
    await expect(invoke(channels, 'media:readAsDataUrl', '', file)).rejects.toThrow('未登记的文件')
    // 登记后 → 返回 data URL
    ctx.media.add(normalizePath(file))
    const data = await invoke<string>(channels, 'media:readAsDataUrl', '', file)
    expect(data.startsWith('data:audio/ogg;base64,')).toBe(true)
    // 项目内路径：根登记 + 链接逃逸校验后放行
    ctx.roots.add(normalizePath(tmp))
    const inProject = await invoke<string>(channels, 'media:readAsDataUrl', tmp, file)
    expect(inProject.startsWith('data:audio/ogg;base64,')).toBe(true)
    // 不支持的后缀拒绝（图片扩展名不走音频白名单）
    const png = path.join(tmp, 'image.png')
    await fs.writeFile(png, Buffer.from('x'))
    await expect(invoke(channels, 'media:readAsDataUrl', tmp, png)).rejects.toThrow('不支持的文件格式')
  })

  it('avatar:saveCropped：超大输入先按字符串长度拒绝（不解码大缓冲）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerAppIpc(ctx, ipc)
    await expect(invoke(channels, 'avatar:saveCropped', 'data:image/png;base64,' + 'a'.repeat(7 * 1024 * 1024))).rejects.toThrow('头像图片过大')
  })

  it('mod:globalOp：超 1MB 文本拒绝（防注入大文本刷盘）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    await expect(invoke(channels, 'mod:globalOp', tmp, { kind: 'replace', text: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('文本过长')
    await expect(invoke(channels, 'mod:globalOp', tmp, { kind: 'replace', find: 'y'.repeat(1024 * 1024 + 1) })).rejects.toThrow('文本过长')
  })

  it('game:importMod：文件名必须通过 basename 白名单（防路径穿越）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerGameIpc(ctx, ipc)
    // 构造假游戏目录（detectGameDir 只认 assets/units + mods/units）
    await fs.mkdir(path.join(tmp, 'assets', 'units'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'mods', 'units'), { recursive: true })
    const target = path.join(tmp, 'target')
    await fs.mkdir(target)
    ctx.roots.add(normalizePath(target))
    await expect(invoke(channels, 'game:importMod', tmp, '../evil.rwmod', target)).rejects.toThrow('无效的模组包文件名')
    // 目标目录未登记同样拒绝
    await expect(invoke(channels, 'game:importMod', tmp, 'x.rwmod', path.join(tmp, 'not-registered'))).rejects.toThrow('未登记')
  })

  it('fs:rename：纯大小写改名放行（caseOnly 判定，不误报已存在）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerFsIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    await invoke(channels, 'fs:createFile', tmp, tmp, 'case.txt')
    await invoke(channels, 'fs:rename', tmp, path.join(tmp, 'case.txt'), path.join(tmp, 'CASE.txt'))
    expect(await fs.stat(path.join(tmp, 'CASE.txt'))).toBeTruthy()
  })

  it('dialog:openImage：选中图片登记为允许媒体并持久化锚', async () => {
    const { channels, ipc } = createFakeIpc()
    registerDialogIpc(ctx, ipc)
    const img = path.join(tmp, 'bg.png')
    ctx.dialog = { ...ctx.dialog, showOpenDialog: async () => ({ canceled: false, filePaths: [img] }) }
    const result = await invoke<string>(channels, 'dialog:openImage')
    expect(result).toBe(img)
    expect(ctx.media.has(normalizePath(img))).toBe(true)
    // 信任锚已写入 store（set 异步但内存态立即可见）
    await new Promise((r) => setTimeout(r, 10))
    expect(ctx.store.get('mediaAllowlist')).toContain(normalizePath(img))
  })
})
