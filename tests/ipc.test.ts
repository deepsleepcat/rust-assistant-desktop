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
import { createSecureCredentials, DEEPSEEK_CREDENTIAL_KEY } from '../electron/secureCredentials'
import {
  createFeedbackChannel,
  createIpcContext,
  registerAiIpc,
  registerAppIpc,
  registerCommunityAuthIpc,
  registerCommunityIpc,
  registerDialogIpc,
  registerFsIpc,
  registerGameIpc,
  registerGitIpc,
  registerKnowledgeIpc,
  registerModIpc,
  registerStoreIpc,
  registerIpc,
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
  it('registerIpc 组合函数不重复注册通道（真实 ipcMain.handle 对重复注册会抛错）', () => {
    const seen = new Set<string>()
    const strictIpc: RegisterHandler = (channel) => {
      if (seen.has(channel)) throw new Error(`重复注册通道：${channel}`)
      seen.add(channel)
    }
    expect(() => registerIpc(ctx, strictIpc)).not.toThrow()
  })

  it('十一个域注册函数覆盖全部 81 个通道，无遗漏无重复', () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    registerCommunityIpc(ctx, ipc)
    registerCommunityAuthIpc(ctx, ipc)
    registerKnowledgeIpc(ctx, ipc)
    registerGitIpc(ctx, ipc)
    registerDialogIpc(ctx, ipc)
    registerFsIpc(ctx, ipc)
    registerModIpc(ctx, ipc)
    registerGameIpc(ctx, ipc)
    registerAppIpc(ctx, ipc)
    registerAiIpc(ctx, ipc)

    const expected = [
      // store + 受限社区代理 + 主进程设备认证
      'store:get', 'store:set', 'community:request',
      'auth:status', 'auth:startPairing', 'auth:pollPairing', 'auth:cancelPairing', 'auth:logout',
      // knowledge
      'knowledge:readDataFile', 'knowledge:info', 'knowledge:checkUpdate', 'knowledge:update', 'knowledge:rollback',
      // git
      'git:info', 'git:log', 'git:status', 'git:conflicts', 'git:diff', 'git:restore',
      // dialog + project
      'dialog:openFolder', 'dialog:openImage', 'dialog:saveText', 'project:registerRoots',
      // fs + media
      'fs:readDir', 'project:searchFiles', 'fs:readFile', 'fs:stat', 'fs:writeFile', 'fs:createFile', 'fs:createFolder', 'fs:rename', 'fs:delete',
      'image:readAsDataUrl', 'media:readAsDataUrl',
      // mod + template
      'mod:create', 'mod:createUnit', 'mod:listTemplates', 'mod:saveFileAsTemplate', 'mod:createUnitFromTemplate',
      'mod:pack', 'mod:packAndDeploy', 'mod:check', 'mod:readModInfo', 'mod:writeModInfo', 'mod:scanResources', 'mod:scanUnits', 'mod:copyUnit',
      'mod:optimizeScan', 'mod:optimizeApply', 'mod:globalOp', 'mod:chooseMusic', 'mod:import', 'mod:discardImport',
      'mod:translationRepairScan', 'mod:translationRepairApply',
      'template:import', 'template:deleteUser', 'template:listUserKeys',
      // game
      'game:detect', 'game:importSample', 'game:importMod', 'game:launch', 'game:openDir', 'game:preflight', 'game:readAssetImage',
      // app
      'app:info', 'app:flush-done', 'app:checkUpdate', 'app:downloadUpdate', 'app:installUpdate',
      // ai
      'ai:check', 'ai:credential:save', 'ai:credential:status', 'ai:credential:clear', 'ai:info', 'ai:approval:respond', 'ai:stream:abort', 'ai:history:list', 'ai:history:restore', 'ai:stream', 'ai:feedback',
    ]
    expect([...channels.keys()].sort()).toEqual([...expected].sort())
    expect(channels.size).toBe(81)
  })
})

describe('社区设备认证 IPC', () => {
  it('只暴露状态式认证方法，认证服务不可用时拒绝', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityAuthIpc(ctx, ipc)
    await expect(invoke(channels, 'auth:status')).rejects.toThrow('社区设备认证不可用')

    const auth = {
      status: vi.fn(async () => ({ state: 'signed-out' as const })),
      startPairing: vi.fn(async () => ({ state: 'pairing' as const, userCode: 'ABCD-1234', expiresAt: 1, pollAfterMs: 1_000 })),
      pollPairing: vi.fn(async () => ({ state: 'pairing' as const })),
      cancelPairing: vi.fn(async () => ({ state: 'signed-out' as const })),
      logout: vi.fn(async () => ({ state: 'signed-out' as const })),
      withCredential: vi.fn(),
      invalidate: vi.fn(),
    }
    ctx.communityAuth = auth
    await expect(invoke(channels, 'auth:status')).resolves.toEqual({ state: 'signed-out' })
    await expect(invoke(channels, 'auth:startPairing')).resolves.toMatchObject({ userCode: 'ABCD-1234' })
    await invoke(channels, 'auth:pollPairing')
    await invoke(channels, 'auth:cancelPairing')
    await invoke(channels, 'auth:logout')
    expect(auth.status).toHaveBeenCalledTimes(1)
    expect(auth.startPairing).toHaveBeenCalledTimes(1)
    expect(auth.pollPairing).toHaveBeenCalledTimes(1)
    expect(auth.cancelPairing).toHaveBeenCalledTimes(1)
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })
})

describe('社区请求代理', () => {
  it('只读取受信任社区的规范头像 URL，并拒绝写入、任意主机和路径', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const trusted = 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
    const objectKey = `${'a'.repeat(48)}.png`
    await expect(invoke<{ status: number }>(channels, 'community:request', { url: `${trusted}/api/avatar/${objectKey}`, method: 'GET' })).resolves.toMatchObject({ status: 200 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/avatar/${objectKey}`, method: 'POST' })).rejects.toThrow('只允许读取')
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/avatar`, method: 'POST' })).rejects.toThrow('路径不允许')
    await expect(invoke(channels, 'community:request', { url: 'https://example.com/api/avatar', method: 'POST' })).rejects.toThrow('不受信任')
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/avatar/not-an-object.png`, method: 'GET' })).rejects.toThrow('路径不允许')
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/avatar/../../secrets`, method: 'GET' })).rejects.toThrow('路径不允许')
    vi.unstubAllGlobals()
  })

  it('认证意图由主进程注入 Bearer，renderer 提供的 Authorization 一律剥除', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    const injected = 'sk-main-process-secret'
    ctx.communityAuth = {
      withCredential: async (apply: (secret: string) => unknown) => apply(injected),
    } as never
    const seen: Array<{ headers: Headers; body: unknown }> = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ headers: new Headers(init?.headers), body: init?.body })
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const trusted = 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'

    // authenticated 请求：主进程注入自己的凭据
    await invoke(channels, 'community:request', {
      url: `${trusted}/api/me`,
      method: 'GET',
      authenticated: true,
    })
    expect(seen[0].headers.get('Authorization')).toBe('Bearer sk-main-process-secret')

    // renderer 伪造 Authorization 的请求：主进程剥除并注入受信凭据
    await invoke(channels, 'community:request', {
      url: `${trusted}/api/me`,
      method: 'GET',
      authenticated: true,
      headers: { authorization: 'Bearer sk-forged-by-renderer' },
    })
    expect(seen[1].headers.get('Authorization')).toBe('Bearer sk-main-process-secret')

    // 未登录（无凭据）时认证请求失败且不发出网络调用
    ctx.communityAuth = { withCredential: async () => null } as never
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/me`, method: 'GET', authenticated: true })).rejects.toThrow('社区登录已失效')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/community/posts/1/resources`, method: 'POST', upload: null })).rejects.toThrow('社区附件参数无效')
    await expect(invoke(channels, 'community:request', { url: `${trusted}/api/community/posts/1/resources`, method: 'POST', upload: { name: 'x.zip', type: 'application/zip', bytes: 'not-an-array-buffer' } })).rejects.toThrow('社区附件超过 50 MiB 限制')
    vi.unstubAllGlobals()
  })
})

describe('store 通道', () => {
  it('store:get/set 读写往返', async () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    await invoke(channels, 'store:set', 'myKey', { a: 1 })
    expect(await invoke(channels, 'store:get', 'myKey')).toEqual({ a: 1 })
  })

  it('系统保留键拒绝渲染层读写', async () => {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    await expect(invoke(channels, 'store:set', 'projectRoots', ['C:\\x'])).rejects.toThrow('不允许写入系统保留键')
    await expect(invoke(channels, 'store:set', 'mediaAllowlist', ['C:\\x'])).rejects.toThrow('不允许写入系统保留键')
    await expect(invoke(channels, 'store:set', 'communityAuthCredentialV1', 'ciphertext')).rejects.toThrow('不允许写入系统保留键')
    await expect(invoke(channels, 'store:get', 'communityAuthCredentialV1')).rejects.toThrow('不允许读取系统保留键')
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

  it('project:searchFiles：递归命中文件，且未登记根/类型参数拒绝', async () => {
    const { channels, ipc } = createFakeIpc()
    registerFsIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    await fs.mkdir(path.join(tmp, 'units', 'tank'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'units', 'tank', 'HeavyTank.ini'), 'x', 'utf8')
    const result = await invoke<{ entries: Array<{ relativePath: string }>; truncated: boolean }>(channels, 'project:searchFiles', tmp, 'heavytank', false)
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(['units/tank/HeavyTank.ini'])
    expect(result.truncated).toBe(false)
    await expect(invoke(channels, 'project:searchFiles', path.join(tmp, 'other'), 'x', false)).rejects.toThrow('未登记的项目目录')
    await expect(invoke(channels, 'project:searchFiles', tmp, 123, false)).rejects.toThrow('搜索关键词无效')
  })

  it('mod:translationRepairScan：参数校验和未登记根拒绝', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    await expect(invoke(channels, 'mod:translationRepairScan')).rejects.toThrow('项目目录为空')
    await expect(invoke(channels, 'mod:translationRepairScan', 123)).rejects.toThrow('项目目录为空')
    await expect(invoke(channels, 'mod:translationRepairScan', path.join(tmp, 'other'))).rejects.toThrow('未登记的项目目录')
  })

  it('mod:translationRepairApply：参数校验和互斥', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    await expect(invoke(channels, 'mod:translationRepairApply')).rejects.toThrow('项目目录为空')
    await expect(invoke(channels, 'mod:translationRepairApply', tmp, 'not-array')).rejects.toThrow('修复选择无效')
    ctx.packing.active = true
    await expect(invoke(channels, 'mod:translationRepairApply', tmp, [])).rejects.toThrow('已有打包')
    ctx.packing.active = false
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
    const noKey = await invoke<{ ok: boolean; message: string }>(channels, 'ai:check', { provider: 'deepseek' })
    expect(noKey.message).toContain('未配置 DeepSeek API Key')
    const community = await invoke<{ ok: boolean; message: string }>(channels, 'ai:check', { provider: 'community', endpoint: '', token: '' })
    expect(community.message).toContain('即将上线')
  })

  it('ai:credential:*：DeepSeek Key 保管（key 不回传、空值拒绝、密文只落保留键）+ stream 未配置即拒绝', async () => {
    const channels = setupAi()
    const data = new Map<string, unknown>()
    const memoryStore = { get: (k: string) => data.get(k), set: async (k: string, v: unknown) => { data.set(k, v) } }
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'os_crypt',
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8'),
    }
    ctx.deepSeekCredentials = createSecureCredentials(memoryStore as never, fakeSafeStorage as never, DEEPSEEK_CREDENTIAL_KEY)

    expect(await invoke<{ configured: boolean }>(channels, 'ai:credential:status')).toEqual({ configured: false })

    // stream 未配置 Key：拒绝且不泄漏 AI 锁（两次调用都应命中同一错误而非「已有请求」）
    ctx.roots.add(normalizePath(tmp))
    const streamEvent = { sender: { isDestroyed: () => false, send: () => undefined } }
    await expect(invokeWithEvent(channels, 'ai:stream', streamEvent, { messages: [] }, { provider: 'deepseek', deepseekModel: 'deepseek-v4-flash' }, tmp)).rejects.toThrow('尚未配置 DeepSeek API Key')
    await expect(invokeWithEvent(channels, 'ai:stream', streamEvent, { messages: [] }, { provider: 'deepseek', deepseekModel: 'deepseek-v4-flash' }, tmp)).rejects.toThrow('尚未配置 DeepSeek API Key')

    await expect(invoke(channels, 'ai:credential:save', '   ')).rejects.toThrow('API Key 不能为空')
    await expect(invoke(channels, 'ai:credential:save', 123)).rejects.toThrow('API Key 不能为空')

    // 测试占位值（非真实凭据样式）
    await invoke(channels, 'ai:credential:save', 'test-key-placeholder')
    expect(await invoke<{ configured: boolean }>(channels, 'ai:credential:status')).toEqual({ configured: true })
    // 密文（safe-v1: 前缀）落在 DeepSeek 保留键里，明文不落盘
    expect(String(data.get(DEEPSEEK_CREDENTIAL_KEY))).toMatch(/^safe-v1:/)
    expect(String(data.get(DEEPSEEK_CREDENTIAL_KEY))).not.toContain('test-key-placeholder')

    await invoke(channels, 'ai:credential:clear')
    expect(await invoke<{ configured: boolean }>(channels, 'ai:credential:status')).toEqual({ configured: false })
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

  it('ai:feedback：只投递给当前活动流；参数校验；abort 唤醒等待', async () => {
    const channels = setupAi()
    // 无活动流 → false
    expect(await invoke<boolean>(channels, 'ai:feedback', '质检反馈')).toBe(false)
    // 参数校验：非字符串 / 超 8KB 拒绝
    await expect(invoke(channels, 'ai:feedback', 42)).rejects.toThrow('参数错误')
    await expect(invoke(channels, 'ai:feedback', 'x'.repeat(8 * 1024 + 1))).rejects.toThrow('参数错误')
    // 有活动流 → 投递成功
    let received: string | null = null
    ctx.ai.feedbackReceiver = (msg) => {
      received = msg
      return true
    }
    expect(await invoke<boolean>(channels, 'ai:feedback', '第3行：血量超限')).toBe(true)
    expect(received).toBe('第3行：血量超限')
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

  it('mod:packAndDeploy：未配置游戏路径返回提示；未登记根/参数类型拒绝；成功写入游戏 mods/units', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    // 项目根 + 假游戏目录（assets/units 存在，mods/units 不存在——部署时自动创建）
    ctx.roots.add(normalizePath(tmp))
    await fs.writeFile(path.join(tmp, 'mod-info.txt'), '[mod]\ntitle: 测试\n', 'utf8')
    const gameDir = path.join(tmp, 'game')
    await fs.mkdir(path.join(gameDir, 'assets', 'units'), { recursive: true })

    // 未配置游戏路径
    const noPath = await invoke(channels, 'mod:packAndDeploy', tmp, {}, '', false)
    expect(noPath).toMatchObject({ ok: false, message: expect.stringContaining('配置游戏安装目录') })

    // 未登记项目根拒绝
    await expect(
      invoke(channels, 'mod:packAndDeploy', path.join(tmp, 'unregistered'), {}, gameDir, false),
    ).rejects.toThrow('项目目录未登记')

    // 参数类型校验
    await expect(invoke(channels, 'mod:packAndDeploy', 123, {}, gameDir, false)).rejects.toThrow('项目目录为空')
    await expect(invoke(channels, 'mod:packAndDeploy', tmp, {}, gameDir, 'yes')).rejects.toThrow('overwrite 参数')

    // 成功：写入 <gameDir>/mods/units/<项目名>.rwmod（mods/units 自动创建；
    // 执行传原始 rootPath——项目名大小写保留，游戏内模组名与项目一致）
    const result = await invoke<{ ok: boolean; filePath: string }>(channels, 'mod:packAndDeploy', tmp, {}, gameDir, false)
    expect(result.ok).toBe(true)
    expect(result.filePath).toBe(path.join(gameDir, 'mods', 'units', `${path.basename(tmp)}.rwmod`))
    const buf = await fs.readFile(result.filePath)
    expect(buf.byteLength).toBeGreaterThan(0)

    // 同名已存在且未 overwrite → EXISTS（不覆盖）
    const exists = await invoke<{ ok: boolean; code?: string }>(channels, 'mod:packAndDeploy', tmp, {}, gameDir, false)
    expect(exists.ok).toBe(false)
    expect(exists.code).toBe('EXISTS')

    // overwrite=true 覆盖成功
    const overwritten = await invoke<{ ok: boolean; overwritten: boolean }>(channels, 'mod:packAndDeploy', tmp, {}, gameDir, true)
    expect(overwritten.ok).toBe(true)
    expect(overwritten.overwritten).toBe(true)
  })

  it('mod:packAndDeploy：与 mod:pack 共用互斥（打包进行中拒绝部署）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    ctx.packing.active = true
    await expect(invoke(channels, 'mod:packAndDeploy', tmp, {}, path.join(tmp, 'game'), false)).rejects.toThrow('已有打包任务')
  })

  it('mod:copyUnit：两端项目根都须登记，成功时写入目标', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    const src = tmp
    const dst = path.join(tmp, 'dst')
    await fs.mkdir(dst)
    ctx.roots.add(normalizePath(src))
    ctx.roots.add(normalizePath(dst))
    await fs.mkdir(path.join(src, 'units'))
    await fs.writeFile(path.join(src, 'units', 'tank.ini'), '[core]\nname: tank\n', 'utf8')

    // 未登记源项目根拒绝
    await expect(
      invoke(channels, 'mod:copyUnit', { sourceRoot: path.join(tmp, 'unregistered'), sourceFilePath: 'units/tank.ini', targetRoot: dst, targetName: 'b' }),
    ).rejects.toThrow('未登记的项目目录')
    // 未登记目标项目根拒绝
    await expect(
      invoke(channels, 'mod:copyUnit', { sourceRoot: src, sourceFilePath: 'units/tank.ini', targetRoot: path.join(tmp, 'unregistered2'), targetName: 'b' }),
    ).rejects.toThrow('未登记的项目目录')

    // 成功：写入目标项目 <name>/<name>.ini
    const result = await invoke<{ path: string }>(channels, 'mod:copyUnit', {
      sourceRoot: src,
      sourceFilePath: 'units/tank.ini',
      targetRoot: dst,
      targetName: 'copiedTank',
    })
    expect(result.path).toBe('copiedTank/copiedTank.ini')
    expect(await fs.readFile(path.join(dst, 'copiedTank', 'copiedTank.ini'), 'utf8')).toContain('name: tank')

    // 参数校验：缺项目目录拒绝
    await expect(invoke(channels, 'mod:copyUnit', { sourceRoot: src })).rejects.toThrow('复制参数')
    // 非字符串参数拒绝（防 TypeError 泄露内部细节）
    await expect(
      invoke(channels, 'mod:copyUnit', { sourceRoot: src, sourceFilePath: 123, targetRoot: dst, targetName: 'b' }),
    ).rejects.toThrow('复制参数')
    await expect(
      invoke(channels, 'mod:copyUnit', { sourceRoot: src, sourceFilePath: 'units/tank.ini', targetRoot: dst, targetName: 'b', targetFolder: 7 }),
    ).rejects.toThrow('目标文件夹无效')
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

  it('mod:import：前端类型决定文件包或文件夹选择器', async () => {
    const { channels, ipc } = createFakeIpc()
    registerModIpc(ctx, ipc)
    const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }))

    // 无效类型在打开任何原生选择器前拒绝，且导入不再弹系统消息框
    ctx.dialog = { ...ctx.dialog, showMessageBox }
    await expect(invoke(channels, 'mod:import', 'file')).rejects.toThrow('无效的模组导入类型')
    expect(showMessageBox).not.toHaveBeenCalled()

    // 文件夹：只打开目录选择器；用户取消则不改变项目根
    const canceledFolderPicker = vi.fn(async () => ({ canceled: true, filePaths: [] }))
    ctx.dialog = { ...ctx.dialog, showOpenDialog: canceledFolderPicker }
    expect(await invoke(channels, 'mod:import', 'folder')).toBeNull()
    expect(canceledFolderPicker).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory'] }))

    const folderPicker = vi.fn(async () => ({ canceled: false, filePaths: [tmp] }))
    ctx.dialog = { ...ctx.dialog, showOpenDialog: folderPicker }
    const folder = await invoke<{ rootPath: string; name: string }>(channels, 'mod:import', 'folder')
    expect(folder.rootPath).toBe(tmp)
    expect(ctx.roots.has(normalizePath(tmp))).toBe(true)
    expect(folderPicker).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory'] }))

    // 文件包：第一次只选 .rwmod/.zip 文件，第二次只选解压目标目录
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file('mod-info.txt', 'name: sample')
    zip.file('units/a.ini', '[core]\nname: a')
    const zipPath = path.join(tmp, 'sample.rwmod')
    const zipDest = path.join(tmp, 'import-root')
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const archivePicker = vi.fn(async (opts?: { title?: string }) =>
      opts?.title?.includes('模组文件')
        ? { canceled: false, filePaths: [zipPath] }
        : { canceled: false, filePaths: [zipDest] },
    )
    ctx.dialog = { ...ctx.dialog, showOpenDialog: archivePicker }
    const pkg = await invoke<{ rootPath: string; name: string; files: number }>(channels, 'mod:import', 'archive')
    expect(pkg.files).toBe(2)
    expect(pkg.name).toBe('sample')
    expect(ctx.roots.has(normalizePath(pkg.rootPath))).toBe(true)
    expect((await fs.readdir(pkg.rootPath)).sort()).toEqual(['mod-info.txt', 'units'])
    expect(archivePicker.mock.calls[0][0]).toEqual(expect.objectContaining({ properties: ['openFile'] }))
    expect(archivePicker.mock.calls[0][0]).toEqual(expect.objectContaining({ filters: expect.arrayContaining([expect.objectContaining({ extensions: ['rwmod', 'zip'] })]) }))
    expect(archivePicker.mock.calls[1][0]).toEqual(expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }))
    // 撤销语义登记：本次导入创建的目录可被 discardImport 清理
    expect(await invoke<{ ok: boolean }>(channels, 'mod:discardImport', pkg.rootPath)).toEqual({ ok: true })
    expect(showMessageBox).not.toHaveBeenCalled()
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

    // flush-done：没有待确认退出流程时，渲染层不得凭空销毁窗口
    const destroy = vi.fn()
    ctx.windows = { getAllWindows: () => [{ isDestroyed: () => false, destroy }] }
    expect(await invoke<boolean>(channels, 'app:flush-done')).toBe(false)
    expect(destroy).not.toHaveBeenCalled()

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

describe('createFeedbackChannel（M26-3 自纠闭环时序）', () => {
  it('反馈先到入队 → wait 取回；多条拼接为一次修正输入', async () => {
    const ch = createFeedbackChannel()
    expect(ch.receiver('第一条')).toBe(true)
    expect(ch.receiver('第二条')).toBe(true)
    const got = await ch.wait(1000)
    expect(got).toBe('第一条\n\n第二条')
    // 队列已清空：再次 wait 走挂起路径（超时返回 null）
    const timeout = await ch.wait(50)
    expect(timeout).toBeNull()
  })

  it('wait 挂起时反馈到达 → 立即唤醒并返回消息', async () => {
    const ch = createFeedbackChannel()
    const pending = ch.wait(5000)
    expect(ch.receiver('第3行：血量超限')).toBe(true)
    expect(await pending).toBe('第3行：血量超限')
  })

  it('wait 超时返回 null（渲染层无响应不阻塞流）', async () => {
    vi.useFakeTimers()
    try {
      const ch = createFeedbackChannel()
      const pending = ch.wait(5000)
      await vi.advanceTimersByTimeAsync(5001)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('队列上限 16 条：溢出丢弃（防恶意渲染层塞爆内存）', () => {
    const ch = createFeedbackChannel()
    for (let i = 0; i < 20; i++) ch.receiver(`m${i}`)
    const got = ch.wait(1000)
    return got.then((v) => {
      const count = v!.split('\n\n').length
      expect(count).toBe(16)
    })
  })

  it('abort 唤醒：空串到达 → wait 返回空串（不修正）', async () => {
    const ch = createFeedbackChannel()
    const pending = ch.wait(5000)
    expect(ch.receiver('')).toBe(true)
    expect(await pending).toBe('')
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
    registerMediaFromSettings(ctx, { background: { imagePath: trusted } })
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
