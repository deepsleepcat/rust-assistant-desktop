/**
 * 云书包 IPC 白名单矩阵与主进程恢复通道（桌面契约 §7.2/§10.6/§10.7）：
 * - 上传规则表：cloudbag blobs（POST，50MiB，multipart fields）命中；方法/路径/大小/fields 越界拒绝
 * - 下载规则表：export.rwmod / shares download 50MiB；树内 file 2MiB；JSON 2MiB
 * - cloudbag:restore：已登记根内备份→覆盖→回滚；.ohmytx 锚点永不覆盖
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

// rename 触发点可控（默认完全透传）：用于在「移走多余文件」阶段注入一次失败，
// 覆盖 restoreRwmod 回滚中「把已移走的文件还原」分支（该分支此前从未被执行）。
// writeDelayMs 可注入写盘延迟（默认 0 完全透传）：让第一个恢复稳定停留在执行中，
// 用于断言同根并发恢复的主进程互斥（第二个请求 fail-fast 拒绝）。
const fsHooks = vi.hoisted(() => ({ renameFailAt: 0, renames: 0, writeDelayMs: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const patchedRename = async (
    from: Parameters<typeof actual.rename>[0],
    to: Parameters<typeof actual.rename>[1],
  ): Promise<void> => {
    fsHooks.renames += 1
    if (fsHooks.renameFailAt > 0 && fsHooks.renames === fsHooks.renameFailAt) throw new Error('模拟移走失败')
    return actual.rename(from, to)
  }
  const patchedWriteFile = async (
    ...args: Parameters<typeof actual.writeFile>
  ): Promise<void> => {
    if (fsHooks.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fsHooks.writeDelayMs))
    return actual.writeFile(...args)
  }
  return { ...actual, default: { ...actual, rename: patchedRename, writeFile: patchedWriteFile } }
})
import { createStore } from '../electron/store'
import { createKnowledgePack } from '../electron/knowledgePack'
import { initAiHistory, getHistory } from '../electron/aiHistory'
import { normalizePath } from '../electron/paths'
import { createIpcContext, registerCommunityIpc, registerCloudbagIpc, type IpcContext, type RegisterHandler } from '../electron/ipc'
import { restoreRwmod } from '../electron/cloudbagRestore'

function createFakeIpc(): { channels: Map<string, (...args: never[]) => unknown>; ipc: RegisterHandler } {
  const channels = new Map<string, (...args: never[]) => unknown>()
  const ipc: RegisterHandler = (channel, handler) => { channels.set(channel, handler) }
  return { channels, ipc }
}

async function invoke<T>(channels: Map<string, (...args: never[]) => unknown>, channel: string, ...args: unknown[]): Promise<T> {
  const h = channels.get(channel)
  if (!h) throw new Error(`通道未注册：${channel}`)
  return (h as (...a: unknown[]) => unknown)(channel === 'cloudbag:saveRwmod' ? saveEvent : undefined, ...args) as Promise<T>
}

let tmp: string
let ctx: IpcContext
let cleanup: () => Promise<void>
let saveEvent: { sender: unknown; senderFrame: unknown }

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-cloudbag-'))
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
    shell: { trashItem: async () => undefined, openPath: async () => '' },
    app: { getVersion: () => '0.0.0-test', getPath: (n) => (n === 'userData' ? tmp : tmp) },
    updater: {
      checkForUpdates: async () => undefined,
      downloadUpdate: async () => undefined,
      quitAndInstall: () => undefined,
      isPackaged: () => false,
    },
    windows: { getAllWindows: () => [] },
  })
  const frame = { url: 'file:///trusted/dist/index.html' }
  const contents = { isDestroyed: () => false, mainFrame: frame, getURL: () => frame.url }
  saveEvent = { sender: contents, senderFrame: frame }
  ctx.cloudbagRendererUrl = new URL(frame.url)
  ctx.windows.getAllWindows = () => [{ isDestroyed: () => false, destroy: () => undefined,
    webContents: contents as NonNullable<ReturnType<IpcContext['windows']['getAllWindows']>[number]['webContents']> }]
  await store.ready()
  cleanup = async () => {
    await store.flush().catch(() => undefined)
    await getHistory().flush().catch(() => undefined)
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined)
  }
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

const TRUSTED = 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'

describe('community:request 云书包上传规则表', () => {
  it('cloudbag blobs POST multipart 命中白名单：fields 随表单转发、file 恒最后', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    ctx.communityAuth = { withCredential: async (apply: (secret: string) => unknown) => apply('sk-test-secret'), invalidate: async () => undefined } as never
    const bodies: FormData[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body as FormData)
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const bytes = new TextEncoder().encode('[core]').buffer as ArrayBuffer
    const result = await invoke<{ status: number }>(channels, 'community:request', {
      url: `${TRUSTED}/api/community/cloudbag/repos/iron-curtain/blobs`,
      method: 'POST',
      authenticated: true,
      upload: { name: 'tank.ini', type: 'application/octet-stream', bytes, fields: { session_id: 'sess-1', sha256: 'a'.repeat(64) } },
    })
    expect(result.status).toBe(200)
    const form = bodies[0]
    expect(form.get('session_id')).toBe('sess-1')
    expect(form.get('sha256')).toBe('a'.repeat(64))
    expect((form.get('file') as File).name).toBe('tank.ini')
  })

  it('上传越界拒绝：GET/PUT 方法、非 blobs 路径、携带 body、超 50MiB、非法 fields', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    const upload = { name: 'a.bin', type: 'application/octet-stream', bytes: new ArrayBuffer(1) }
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'GET', upload })).rejects.toThrow('附件只能上传到')
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'PUT', upload })).rejects.toThrow('附件只能上传到')
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/versions`, method: 'POST', upload })).rejects.toThrow('附件只能上传到')
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'POST', body: '{}', upload })).rejects.toThrow('附件只能上传到')
    await expect(invoke(channels, 'community:request', {
      url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'POST',
      upload: { name: 'a.bin', type: 'application/octet-stream', bytes: new ArrayBuffer(50 * 1024 * 1024 + 1) },
    })).rejects.toThrow('社区附件超过 50 MiB 限制')
    await expect(invoke(channels, 'community:request', {
      url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'POST',
      upload: { name: 'a.bin', type: 'application/octet-stream', bytes: new ArrayBuffer(1), fields: { 'bad-key!': 'v' } },
    })).rejects.toThrow('社区附件参数无效')
    await expect(invoke(channels, 'community:request', {
      url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'POST',
      upload: { name: 'a.bin', type: 'application/octet-stream', bytes: new ArrayBuffer(1), fields: { k: 'v'.repeat(201) } },
    })).rejects.toThrow('社区附件参数无效')
    // 保留名 file/filename 会与真正的 file 部件同名：拒绝
    for (const reserved of ['file', 'fileName']) {
      await expect(invoke(channels, 'community:request', {
        url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'POST',
        upload: { name: 'a.bin', type: 'application/octet-stream', bytes: new ArrayBuffer(1), fields: { [reserved]: 'v' } },
      })).rejects.toThrow('社区附件参数无效')
    }
    // fields 为 null：先判类型再取键，不得靠 Object.keys 抛 TypeError 兜底
    await expect(invoke(channels, 'community:request', {
      url: `${TRUSTED}/api/community/cloudbag/repos/x/blobs`, method: 'POST',
      upload: { name: 'a.bin', type: 'application/octet-stream', bytes: new ArrayBuffer(1), fields: null },
    })).rejects.toThrow('社区附件参数无效')
  })

  it('帖子资源上传规则保持不变（既有行为不回退）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(invoke(channels, 'community:request', {
      url: `${TRUSTED}/api/community/posts/12/resources`, method: 'POST',
      upload: { name: 'a.zip', type: 'application/zip', bytes: new ArrayBuffer(1) },
    })).resolves.toMatchObject({ status: 200 })
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/me`, method: 'POST', upload: { name: 'a.zip', type: 'application/zip', bytes: new ArrayBuffer(1) } })).rejects.toThrow('附件只能上传到帖子资源接口')
  })
})

describe('community:request 云书包下载规则表', () => {
  function stubWithLength(length: string): { fetcher: ReturnType<typeof vi.fn> } {
    const fetcher = vi.fn(async () => new Response(new ArrayBuffer(4), { status: 200, headers: { 'content-length': length } }))
    vi.stubGlobal('fetch', fetcher)
    return { fetcher }
  }

  it('export.rwmod / shares download 按 50MiB 上限放行', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    stubWithLength(String(40 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/versions/3/export.rwmod`, method: 'GET' })).resolves.toMatchObject({ status: 200 })
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/shares/Ab12Cd34/download`, method: 'GET' })).resolves.toMatchObject({ status: 200 })
  })

  it('树内单文件 /file 按 2MiB 上限：超过拒绝', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    stubWithLength(String(3 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/versions/3/file?path=units%2Ftank.ini`, method: 'GET' })).rejects.toThrow('超过桌面端本地上限')
  })

  it('普通 JSON 端点仍按 2MiB（超过拒绝）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    stubWithLength(String(3 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x`, method: 'GET' })).rejects.toThrow('超过桌面端本地上限')
  })

  it('帖子附件 /api/community/resources/<id>/download 仍按 50MiB（不能落进默认 2MiB）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    // 40MiB 是既有可用附件：收紧到 2MiB 会让 2~50MiB 的下载变成「响应过大」
    stubWithLength(String(40 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/resources/12/download`, method: 'GET' })).resolves.toMatchObject({ status: 200 })
    // 超过 50MiB 仍拒绝
    stubWithLength(String(60 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/resources/12/download`, method: 'GET' })).rejects.toThrow('超过桌面端本地上限')
  })

  it('以 /download 结尾但不在分享家族内的路径退回 2MiB 上限（收紧旧的 /download$ 规则）', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCommunityIpc(ctx, ipc)
    stubWithLength(String(3 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/repos/x/download`, method: 'GET' })).rejects.toThrow('超过桌面端本地上限')
    // 家族内（shares/<token>/download）仍按 50MiB 放行
    stubWithLength(String(40 * 1024 * 1024))
    await expect(invoke(channels, 'community:request', { url: `${TRUSTED}/api/community/cloudbag/shares/tok123/download`, method: 'GET' })).resolves.toMatchObject({ status: 200 })
  })
})

describe('cloudbag:saveRwmod（原生对话框授权 + 真实文件 IO）', () => {
  async function packageBytes(): Promise<ArrayBuffer> {
    const zip = new JSZip()
    zip.file('tank.ini', '[core]')
    return zip.generateAsync({ type: 'arraybuffer' })
  }

  it('foreign sender、子 frame、外部/未配置页面来源均拒绝，不能打开保存对话框', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    const bytes = await packageBytes()
    ctx.dialog.showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: '' }))
    const handler = channels.get('cloudbag:saveRwmod')! as (...args: unknown[]) => Promise<unknown>
    for (const event of [undefined, { sender: {}, senderFrame: saveEvent.senderFrame }, { sender: saveEvent.sender, senderFrame: { url: ctx.cloudbagRendererUrl } }]) {
      await expect(handler(event, 'test.rwmod', bytes)).rejects.toThrow('受信应用窗口')
    }
    const frame = saveEvent.senderFrame as { url: string }
    frame.url = 'https://external.example/index.html'
    await expect(handler(saveEvent, 'test.rwmod', bytes)).rejects.toThrow('页面来源')
    frame.url = 'file:///trusted/dist/index.html'
    ctx.cloudbagRendererUrl = null
    await expect(handler(saveEvent, 'test.rwmod', bytes)).rejects.toThrow('受信应用窗口')
    expect(ctx.dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it('取消不写盘；确认后完成落盘再返回路径与大小', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    const bytes = await packageBytes()
    expect(await invoke(channels, 'cloudbag:saveRwmod', 'test.rwmod', bytes)).toEqual({ canceled: true })
    const target = path.join(tmp, 'saved.rwmod')
    await expect(fs.stat(target)).rejects.toThrow()
    ctx.dialog.showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: target }))
    await fs.writeFile(target, 'old')
    expect(await invoke(channels, 'cloudbag:saveRwmod', 'test.rwmod', bytes)).toEqual({ canceled: false, filePath: target, size: bytes.byteLength })
    expect(await fs.readFile(target)).toEqual(Buffer.from(bytes))
    expect(ctx.dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'test.rwmod', filters: [{ name: '铁锈战争模组包', extensions: ['rwmod'] }] }))
    expect((await fs.readdir(tmp)).filter((name) => name.startsWith('.cloudbag-'))).toEqual([])
  })

  it('拒绝任意路径、URL、扩展名、设备名、非包数据与超限，且不打开对话框', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    ctx.dialog.showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: '' }))
    const bytes = await packageBytes()
    for (const name of ['../x.rwmod', 'C:\\x.rwmod', 'https://x/a.rwmod', 'x.exe', 'nul.rwmod', 'x\x7f.rwmod']) {
      await expect(invoke(channels, 'cloudbag:saveRwmod', name, bytes)).rejects.toThrow('文件名无效')
    }
    for (const invalid of ['not-buffer', new ArrayBuffer(0), new ArrayBuffer(22), new ArrayBuffer(50 * 1024 * 1024 + 1)]) {
      await expect(invoke(channels, 'cloudbag:saveRwmod', 'x.rwmod', invalid)).rejects.toThrow()
    }
    expect(ctx.dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it('对话框选择错误扩展名或目标写盘失败：抛错且不残留临时文件', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    const bytes = await packageBytes()
    ctx.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(tmp, 'x.exe') })
    await expect(invoke(channels, 'cloudbag:saveRwmod', 'x.rwmod', bytes)).rejects.toThrow('.rwmod')
    const directory = path.join(tmp, 'directory.rwmod')
    await fs.mkdir(directory)
    ctx.dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory })
    await expect(invoke(channels, 'cloudbag:saveRwmod', 'x.rwmod', bytes)).rejects.toThrow()
    expect((await fs.readdir(tmp)).filter((name) => name.startsWith('.cloudbag-'))).toEqual([])
    expect((await fs.stat(directory)).isDirectory()).toBe(true)
  })
})

describe('cloudbag:restore（主进程恢复通道）', () => {
  function makeZip(files: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip()
    for (const [name, content] of Object.entries(files)) zip.file(name, content)
    return zip.generateAsync({ type: 'nodebuffer' })
  }

  it('包内 Unicode simple-lower 键冲突写盘前拒绝，非冲突组合保留', async () => {
    for (const [left, right] of [['A', 'a'], ['İ', 'i'], ['É', 'é'], ['Σ', 'σ'], ['K', 'k'], ['ΟΣ', 'οσ']]) {
      await expect(restoreRwmod(await makeZip({ [`${left}.ini`]: 'one', [`${right}.ini`]: 'two' }), tmp, 1)).rejects.toThrow('路径键冲突')
    }
    expect(await fs.readdir(tmp)).not.toContain('A.ini')
    for (const [left, right] of [['é', 'e'], ['ß', 'ss'], ['ς', 'σ'], ['e\u0301', 'é']]) {
      const zip = await makeZip({ [`${left}.ini`]: 'one', [`${right}.ini`]: 'two' })
      const { validateZipEntries } = await import('../electron/cloudbagRestore')
      expect((await validateZipEntries(zip)).entries).toHaveLength(2)
    }
  })

  it('同 simple-lower 键但磁盘不同文件：旧本地文件移入备份，不遗留旧内容', async () => {
    const root = path.join(tmp, 'unicode-local')
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, 'İ.ini'), 'old')
    const oldStat = await fs.stat(path.join(root, 'İ.ini'))
    const result = await restoreRwmod(await makeZip({ 'i.ini': 'remote' }), root, 1)
    expect(await fs.readFile(path.join(root, 'i.ini'), 'utf8')).toBe('remote')
    const newStat = await fs.stat(path.join(root, 'i.ini'))
    if (oldStat.ino !== newStat.ino) {
      expect(result.movedList).toContain('İ.ini')
      expect(await fs.readFile(path.join(root, result.backupDir, 'İ.ini'), 'utf8')).toBe('old')
      await expect(fs.stat(path.join(root, 'İ.ini'))).rejects.toThrow()
    } else {
      expect(result.removed).toBe(0)
      expect(await fs.readFile(path.join(root, result.backupDir, 'i.ini'), 'utf8')).toBe('old')
    }
  })

  it('DEL 本地文件留原位且不备份；远端 DEL 条目在写盘前拒绝', async () => {
    const root = path.join(tmp, 'del-path')
    await fs.mkdir(root)
    const invalidName = 'bad\x7f.ini'
    await fs.writeFile(path.join(root, invalidName), 'local')
    const result = await restoreRwmod(await makeZip({ 'keep.ini': 'remote' }), root, 1)
    expect(await fs.readFile(path.join(root, invalidName), 'utf8')).toBe('local')
    expect(result.movedList).not.toContain(invalidName)
    await expect(fs.stat(path.join(root, result.backupDir, invalidName))).rejects.toThrow()
    await expect(restoreRwmod(await makeZip({ [invalidName]: 'bad-remote', 'keep.ini': 'changed' }), root, 2)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'keep.ini'), 'utf8')).toBe('remote')
  })

  it('合法 ..name 首段允许恢复并备份，仍拒绝真正的父路径', async () => {
    const root = path.join(tmp, 'dot-prefix')
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, '..name.ini'), 'old')
    const result = await restoreRwmod(await makeZip({ '..name.ini': 'new', '..assets/unit.ini': 'unit' }), root, 2)
    expect(await fs.readFile(path.join(root, '..name.ini'), 'utf8')).toBe('new')
    expect(await fs.readFile(path.join(root, '..assets/unit.ini'), 'utf8')).toBe('unit')
    expect(await fs.readFile(path.join(root, result.backupDir, '..name.ini'), 'utf8')).toBe('old')
    await expect(restoreRwmod(await makeZip({ 'C:/escape.ini': 'x' }), root, 3)).rejects.toThrow('盘符路径')
  })

  it('未登记项目根拒绝；非 ArrayBuffer/非法版本号拒绝', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    const bytes = new TextEncoder().encode('x').buffer as ArrayBuffer
    await expect(invoke(channels, 'cloudbag:restore', tmp, bytes, 1)).rejects.toThrow('未登记的项目目录')
    ctx.roots.add(normalizePath(tmp))
    await expect(invoke(channels, 'cloudbag:restore', tmp, 'not-buffer', 1)).rejects.toThrow('模组包数据无效')
    await expect(invoke(channels, 'cloudbag:restore', tmp, bytes, 0)).rejects.toThrow('版本号无效')
  })

  it('同根恢复互斥（packing 同模式 fail-fast）：占用中拒绝、完成后放行、不同根并行不受影响', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    const rootA = path.join(tmp, 'lock-a')
    const rootB = path.join(tmp, 'lock-b')
    await fs.mkdir(rootA)
    await fs.mkdir(rootB)
    ctx.roots.add(normalizePath(rootA))
    ctx.roots.add(normalizePath(rootB))
    const zip = await makeZip({ 'units/tank.ini': '[core]\nname: new\n' })
    const bytes = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
    // 手动占用 A 根恢复锁：等价于双窗口/重入场景下另一恢复正在执行
    ctx.cloudbagRestores.add(normalizePath(rootA))
    await expect(invoke(channels, 'cloudbag:restore', rootA, bytes, 1)).rejects.toThrow('该项目正在恢复云书包版本')
    // B 根与 A 根互不影响：恢复照常完成
    const resultB = await invoke<{ written: number }>(channels, 'cloudbag:restore', rootB, bytes, 1)
    expect(resultB.written).toBe(1)
    // A 根释放后放行（隐式验证 handler finally 释放锁的对称性）
    ctx.cloudbagRestores.delete(normalizePath(rootA))
    const resultA = await invoke<{ written: number }>(channels, 'cloudbag:restore', rootA, bytes, 1)
    expect(resultA.written).toBe(1)
    expect(ctx.cloudbagRestores.size).toBe(0)
  })

  it('同根真实并发：第二个恢复在第一个完成前被拒，两阶段不会交错产出混合工作树', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    const root = path.join(tmp, 'lock-race')
    await fs.mkdir(root)
    ctx.roots.add(normalizePath(root))
    const zip = await makeZip({ 'units/tank.ini': '[core]\nname: new\n', 'units/other.ini': 'y' })
    const bytes = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
    // 注入写盘延迟，让第一次恢复确定性地停留在执行中（写盘阶段每个文件各延迟一次）
    fsHooks.writeDelayMs = 60
    try {
      const first = invoke<{ written: number }>(channels, 'cloudbag:restore', root, bytes, 1)
      await new Promise((resolve) => setTimeout(resolve, 15))
      await expect(invoke(channels, 'cloudbag:restore', root, bytes, 1)).rejects.toThrow('该项目正在恢复云书包版本')
      const firstResult = await first
      expect(firstResult.written).toBe(2)
      expect(ctx.cloudbagRestores.size).toBe(0)
    } finally {
      fsHooks.writeDelayMs = 0
    }
  })

  it('覆盖写盘：被覆盖文件先备份到 .ohmytx/backup/<no>/；.ohmytx 内条目被保护跳过', async () => {
    const { channels, ipc } = createFakeIpc()
    registerCloudbagIpc(ctx, ipc)
    ctx.roots.add(normalizePath(tmp))
    await fs.writeFile(path.join(tmp, 'units', 'tank.ini'), '[core]\nname: old\n', 'utf8').catch(async () => {
      await fs.mkdir(path.join(tmp, 'units'), { recursive: true })
      await fs.writeFile(path.join(tmp, 'units', 'tank.ini'), '[core]\nname: old\n', 'utf8')
    })
    await fs.writeFile(path.join(tmp, '.ohmytx', 'cloud.json'), '{"repoSlug":"x"}', 'utf8').catch(async () => {
      await fs.mkdir(path.join(tmp, '.ohmytx'), { recursive: true })
      await fs.writeFile(path.join(tmp, '.ohmytx', 'cloud.json'), '{"repoSlug":"x"}', 'utf8')
    })
    const bytes = await makeZip({
      'units/tank.ini': '[core]\nname: new\n',
      'units/new.txt': 'hello',
      '.ohmytx/cloud.json': '{"evil":true}',
    })
    const result = await invoke<{ written: number; backedUp: number; skipped: string[] }>(channels, 'cloudbag:restore', tmp, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 5)
    expect(result).toMatchObject({ written: 2, backedUp: 1, skipped: ['.ohmytx/cloud.json'] })
    expect(await fs.readFile(path.join(tmp, 'units', 'tank.ini'), 'utf8')).toContain('name: new')
    expect(await fs.readFile(path.join(tmp, '.ohmytx', 'cloud.json'), 'utf8')).toBe('{"repoSlug":"x"}')
    expect(await fs.readFile(path.join(tmp, '.ohmytx', 'backup', '5', 'units', 'tank.ini'), 'utf8')).toContain('name: old')
  })

  it('zip-slip/盘符/设备名条目两段式校验：JSZip 加载即剥离 ../（落点仍在根内），其余拒绝', async () => {
    // JSZip loadAsync 会把 '../evil.ini' 规范化为 'evil.ini'（实测行为）：
    // 校验层再对 '..', 盘符, 设备名做纵深防御，宁可误拒不可写穿
    const sanitized = await restoreRwmod(await makeZip({ '../evil.ini': 'x' }), tmp, 1)
    expect(sanitized.written).toBe(1)
    expect(await fs.readFile(path.join(tmp, 'evil.ini'), 'utf8')).toBe('x')
    const outside = await fs.readdir(path.dirname(tmp))
    expect(outside.filter((name) => name.includes('evil'))).toEqual([])
    await expect(restoreRwmod(await makeZip({ 'C:/abs.ini': 'x' }), tmp, 1)).rejects.toThrow('盘符路径')
    await expect(restoreRwmod(await makeZip({ 'nul.ini': 'x' }), tmp, 1)).rejects.toThrow('系统保留文件名')
    await expect(restoreRwmod(Buffer.alloc(0), tmp, 1)).rejects.toThrow('模组包无效')
  })

  it('路径段级非法字符（NTFS 备用数据流 ADS 与 Win32 别名面）：整次中止，不写盘', async () => {
    const root = path.join(tmp, 'proj-ads')
    await fs.mkdir(path.join(root, 'units'), { recursive: true })
    await fs.writeFile(path.join(root, 'units', 'tank.ini'), 'safe', 'utf8')
    // `units/tank.ini:evil` 词法上在根内、设备名/危险目录/多余文件判定全部放行，
    // 但在 NTFS 上写的是 tank.ini 的备用数据流：文件内容不变、readdir 看不到，
    // 「本地树等价远端树」的不变式与备份计数会同时失真 → 必须拒绝
    await expect(restoreRwmod(await makeZip({ 'units/tank.ini:evil': 'pwned' }), root, 1)).rejects.toThrow('路径段包含非法字符')
    await expect(restoreRwmod(await makeZip({ 'units/tank.ini.': 'x' }), root, 1)).rejects.toThrow('以点或空格结尾')
    // 整条路径末尾的空格本来就被既有的 .trim() 规范掉，但中间段落的尾空格/尾点会原样落盘
    await expect(restoreRwmod(await makeZip({ 'units /tank.ini': 'x' }), root, 1)).rejects.toThrow('以点或空格结尾')
    await expect(restoreRwmod(await makeZip({ 'units/sub. /tank.ini': 'x' }), root, 1)).rejects.toThrow('以点或空格结尾')
    await expect(restoreRwmod(await makeZip({ 'un<its/tank.ini': 'x' }), root, 1)).rejects.toThrow('路径段包含非法字符')
    // 原文件内容与目录树都没有被这次中止影响
    expect(await fs.readFile(path.join(root, 'units', 'tank.ini'), 'utf8')).toBe('safe')
    expect(await fs.readdir(root)).toEqual(['units'])
    expect(await fs.readdir(path.join(root, 'units'))).toEqual(['tank.ini'])
  })

  it('树内白名单 fail-closed：白名单外扩展名条目整次中止，不写入项目根', async () => {
    const root = path.join(tmp, 'proj-whitelist')
    await fs.mkdir(root, { recursive: true })
    // 后端入库已拒白名单外扩展名（正常版本树不含这些），但写入侧必须有自己的防线：
    // 被攻陷/恶意服务端可绕过入库把任意文件写进项目根
    for (const name of ['.gitignore', 'evil.exe', '.vscode/settings.json', 'pack.rwmod']) {
      await expect(restoreRwmod(await makeZip({ [name]: 'x' }), root, 1)).rejects.toThrow('云书包不支持的条目')
    }
    expect(await fs.readdir(root)).toEqual([])
  })

  it('设备名按每个路径段判定（与后端 validateCloudBagPath 同口径）：con/aux 目录段整次中止', async () => {
    const root = path.join(tmp, 'proj-devseg')
    await fs.mkdir(root, { recursive: true })
    // 旧实现只看最后一段（tank.ini/x.ini），放行 con/tank.ini → Windows 上 fs.mkdir('con') 失败
    // → 整次恢复回滚（可用性拒绝）
    await expect(restoreRwmod(await makeZip({ 'con/tank.ini': 'x' }), root, 1)).rejects.toThrow('系统保留文件名')
    await expect(restoreRwmod(await makeZip({ 'aux/units/x.ini': 'x' }), root, 1)).rejects.toThrow('系统保留文件名')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('写盘中途失败回滚：恢复被覆盖文件、删除新建文件', async () => {
    // 构造：tank.ini 可正常备份，但 new.txt 写入时目标目录被换成文件 → mkdir/writeFile 失败
    const root = path.join(tmp, 'proj')
    await fs.mkdir(root)
    ctx.roots.add(normalizePath(root))
    await fs.writeFile(path.join(root, 'tank.ini'), 'old', 'utf8')
    await fs.writeFile(path.join(root, 'blocked'), 'x', 'utf8') // 与 new.txt 所在目录同名 → 写盘必失败
    const bytes = await makeZip({ 'tank.ini': 'new', 'blocked/new.txt': 'x' })
    await expect(restoreRwmod(bytes, root, 3)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'tank.ini'), 'utf8')).toBe('old')
    const writtenExists = await fs.access(path.join(root, 'blocked', 'new.txt')).then(() => true, () => false)
    expect(writtenExists).toBe(false)
  })

  it('删除语义（契约 §6.4）：zip 外的本地多余文件移入 backup 并计入 removed', async () => {
    const root = path.join(tmp, 'proj-del')
    await fs.mkdir(path.join(root, 'units'), { recursive: true })
    await fs.writeFile(path.join(root, 'units', 'keep.ini'), 'keep', 'utf8')
    await fs.writeFile(path.join(root, 'units', 'gone.ini'), 'gone', 'utf8')
    await fs.writeFile(path.join(root, 'stale.txt'), 'stale', 'utf8')
    await fs.mkdir(path.join(root, '.ohmytx'), { recursive: true })
    await fs.writeFile(path.join(root, '.ohmytx', 'cloud.json'), '{"repoSlug":"x"}', 'utf8')

    const bytes = await makeZip({ 'units/keep.ini': 'keep-head', 'units/fresh.ini': 'fresh' })
    const result = await restoreRwmod(bytes, root, 7)

    expect(result.removed).toBe(2)
    expect(result.written).toBe(2)
    // 被移走的文件必须逐条上报（UI 不只回显数字）
    expect([...result.movedList].sort()).toEqual(['stale.txt', 'units/gone.ini'])
    // zip 内文件已按 head 覆盖
    expect(await fs.readFile(path.join(root, 'units', 'keep.ini'), 'utf8')).toBe('keep-head')
    expect(await fs.readFile(path.join(root, 'units', 'fresh.ini'), 'utf8')).toBe('fresh')
    // zip 外的本地多余文件已从工作树移走（等效删除）
    await expect(fs.access(path.join(root, 'units', 'gone.ini'))).rejects.toThrow()
    await expect(fs.access(path.join(root, 'stale.txt'))).rejects.toThrow()
    // 移入 .ohmytx/backup/<no>/，锚点目录本身不被触碰
    expect(await fs.readFile(path.join(root, '.ohmytx', 'backup', '7', 'units', 'gone.ini'), 'utf8')).toBe('gone')
    expect(await fs.readFile(path.join(root, '.ohmytx', 'backup', '7', 'stale.txt'), 'utf8')).toBe('stale')
    expect(await fs.readFile(path.join(root, '.ohmytx', 'cloud.json'), 'utf8')).toBe('{"repoSlug":"x"}')
  })

  it('云书包无法表示的本地文件不参与覆盖语义：拉取不得把它们移走（与上传侧同口径）', async () => {
    const root = path.join(tmp, 'proj-representable')
    await fs.mkdir(path.join(root, 'units'), { recursive: true })
    await fs.writeFile(path.join(root, 'units', 'gone.ini'), 'gone', 'utf8')
    // 上传侧把下列文件判为 unsupported / oversized / 非 UTF-8（留在本地并如实上报），
    // 它们不可能出现在远端树里，因此拉取也不能把它们当成「远端已删」移走
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n', 'utf8')
    await fs.writeFile(path.join(root, 'README.md'), '# readme\n', 'utf8')
    await fs.writeFile(path.join(root, 'config.json'), '{}', 'utf8')
    await fs.writeFile(path.join(root, 'pack.rwmod'), 'zip-bytes', 'utf8')
    // 非 UTF-8 文本（GBK「测试」的前两字节）与超 50MiB 的素材
    await fs.writeFile(path.join(root, 'units', 'gbk.txt'), Buffer.from([0xcf, 0xb5, 0xca, 0xd4]))
    await fs.writeFile(path.join(root, 'units', 'huge.ogg'), Buffer.alloc(0))
    await fs.truncate(path.join(root, 'units', 'huge.ogg'), 50 * 1024 * 1024 + 1)

    const bytes = await makeZip({ 'units/tank.ini': 'head' })
    const result = await restoreRwmod(bytes, root, 9)

    // 只有可表示的 units/gone.ini 被移走
    expect(result.removed).toBe(1)
    expect(result.movedList).toEqual(['units/gone.ini'])
    for (const kept of ['.gitignore', 'README.md', 'config.json', 'pack.rwmod']) {
      expect(await fs.readFile(path.join(root, kept), 'utf8')).toBeTruthy()
    }
    expect((await fs.readFile(path.join(root, 'units', 'gbk.txt'))).byteLength).toBe(4)
    expect((await fs.stat(path.join(root, 'units', 'huge.ogg'))).size).toBe(50 * 1024 * 1024 + 1)
    await fs.rm(path.join(root, 'units', 'huge.ogg'), { force: true })
  })

  it('fail-closed：zip 含确定性危险目录条目（.git/node_modules 等）整次中止，不写入项目根', async () => {
    const root = path.join(tmp, 'proj-excl')
    await fs.mkdir(root, { recursive: true })
    await expect(restoreRwmod(await makeZip({ '.git/hooks/pre-commit': '#!/bin/sh\n' }), root, 1)).rejects.toThrow('危险目录条目')
    await expect(restoreRwmod(await makeZip({ 'node_modules/pkg/index.js': 'x' }), root, 1)).rejects.toThrow('危险目录条目')
    const leaked = await fs.access(path.join(root, '.git')).then(() => true, () => false)
    expect(leaked).toBe(false)
  })

  it('噪声排除条目（dist/out/.vite/*.tmp）改为「跳过并上报」：恢复成功且不写盘（无永久死路）', async () => {
    const root = path.join(tmp, 'proj-noise')
    await fs.mkdir(root, { recursive: true })
    const result = await restoreRwmod(await makeZip({
      'dist/units/tank.ini': 'built',
      'units/tank.ini': 'source',
      'build.tmp': 'tmp',
      'assets/.vite/deps/x.txt': 'vite',
      'Thumbs.db': 'junk',
    }), root, 4)
    expect(result.written).toBe(1)
    expect(result.skipped.sort()).toEqual(['Thumbs.db', 'assets/.vite/deps/x.txt', 'build.tmp', 'dist/units/tank.ini'])
    expect(await fs.readFile(path.join(root, 'units', 'tank.ini'), 'utf8')).toBe('source')
    expect(await fs.access(path.join(root, 'dist')).then(() => true, () => false)).toBe(false)
    // 本地已存在的 dist/ 不会被当作「zip 外多余文件」移走（listLocalFiles 同口径排除）
    await fs.mkdir(path.join(root, 'dist'), { recursive: true })
    await fs.writeFile(path.join(root, 'dist', 'local.ini'), 'local', 'utf8')
    const second = await restoreRwmod(await makeZip({ 'units/tank.ini': 'source' }), root, 4)
    expect(second.removed).toBe(0)
    expect(await fs.readFile(path.join(root, 'dist', 'local.ini'), 'utf8')).toBe('local')
  })

  it('大小写变体锚点（.OHMYTX/...）被跳过：真实 .ohmytx/cloud.json 内容不变（NTFS 不区分大小写）', async () => {
    const root = path.join(tmp, 'proj-anchor-case')
    await fs.mkdir(path.join(root, '.ohmytx'), { recursive: true })
    await fs.writeFile(path.join(root, '.ohmytx', 'cloud.json'), '{"repoSlug":"real"}', 'utf8')
    const bytes = await makeZip({
      '.OHMYTX/cloud.json': '{"evil":true}',
      '.OhMyTx/backup/3/units/tank.ini': 'pwned',
      'units/tank.ini': 'ok',
    })
    const result = await restoreRwmod(bytes, root, 3)
    expect(result.skipped).toEqual(['.OHMYTX/cloud.json', '.OhMyTx/backup/3/units/tank.ini'])
    expect(result.written).toBe(1)
    // 真实锚点在大小写不敏感文件系统上就是 `.OHMYTX` 指向的文件：内容必须原样保留
    expect(await fs.readFile(path.join(root, '.ohmytx', 'cloud.json'), 'utf8')).toBe('{"repoSlug":"real"}')
    expect(await fs.readFile(path.join(root, 'units', 'tank.ini'), 'utf8')).toBe('ok')
  })

  // NTFS/APFS 上磁盘的 `Units/Tank.ini` 与 zip 条目 `units/tank.ini` 是同一个文件：
  // 用大小写敏感比较会把刚写入的远端文件当成「zip 外多余文件」移进备份，导致工作树
  // 丢掉远端树里存在的文件、备份里的用户原始内容被远端内容覆盖（本机 NTFS 实测复现）。
  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    '大小写不敏感文件系统：磁盘大小写与 zip 条目不同时不得移走文件、不得覆盖备份',
    async () => {
      const root = path.join(tmp, 'proj-case-fold')
      await fs.mkdir(path.join(root, 'Units'), { recursive: true })
      await fs.writeFile(path.join(root, 'Units', 'Tank.ini'), 'ORIGINAL', 'utf8')

      const first = await restoreRwmod(await makeZip({ 'units/tank.ini': 'REMOTE' }), root, 11)
      expect(first.removed).toBe(0)
      expect(first.movedList).toEqual([])
      // 工作树保留远端树里的这个文件（内容为远端内容）
      expect(await fs.readFile(path.join(root, 'Units', 'Tank.ini'), 'utf8')).toBe('REMOTE')
      // 备份仍是用户原始内容，没有被刚写入的远端内容覆盖
      expect(await fs.readFile(path.join(root, '.ohmytx', 'backup', '11', 'units', 'tank.ini'), 'utf8')).toBe('ORIGINAL')

      // 本地目录 units/ 与远端条目 Units/new.ini 同理：刚写入的新文件不得被移进备份
      const root2 = path.join(tmp, 'proj-case-fold-2')
      await fs.mkdir(path.join(root2, 'units'), { recursive: true })
      const second = await restoreRwmod(await makeZip({ 'Units/new.ini': 'NEW' }), root2, 12)
      expect(second.removed).toBe(0)
      expect(second.movedList).toEqual([])
      expect(await fs.readFile(path.join(root2, 'units', 'new.ini'), 'utf8')).toBe('NEW')
      expect(await fs.access(path.join(root2, '.ohmytx', 'backup', '12')).then(() => true, () => false)).toBe(false)
    },
  )

  it('大小写变体的危险目录条目整次中止（.GIT / 嵌套 node_modules 不得写进项目根）', async () => {
    const root = path.join(tmp, 'proj-excl-case')
    await fs.mkdir(root, { recursive: true })
    await expect(restoreRwmod(await makeZip({ '.GIT/hooks/pre-commit': '#!/bin/sh\n' }), root, 1)).rejects.toThrow('危险目录条目')
    await expect(restoreRwmod(await makeZip({ 'Node_Modules/pkg/index.js': 'x' }), root, 1)).rejects.toThrow('危险目录条目')
    // 嵌套深度 >1：旧实现只看首段，这些会直接写盘
    await expect(restoreRwmod(await makeZip({ 'assets/node_modules/x.js': 'x' }), root, 1)).rejects.toThrow('危险目录条目')
    await expect(restoreRwmod(await makeZip({ 'units/.git/config': 'x' }), root, 1)).rejects.toThrow('危险目录条目')
    expect(await fs.access(path.join(root, '.git')).then(() => true, () => false)).toBe(false)
    expect(await fs.access(path.join(root, 'assets')).then(() => true, () => false)).toBe(false)
  })

  it('空 zip（无文件条目）直接拒绝：不得把整个工作树等效删除进备份', async () => {
    const root = path.join(tmp, 'proj-empty')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'tank.ini'), 'important', 'utf8')
    await expect(restoreRwmod(await makeZip({}), root, 1)).rejects.toThrow('没有文件条目')
    expect(await fs.readFile(path.join(root, 'tank.ini'), 'utf8')).toBe('important')
  })

  it('同一版本号重复拉取：不覆盖上一次备份（用户原始内容可恢复），并回报备份目录', async () => {
    const root = path.join(tmp, 'proj-repeat')
    await fs.mkdir(path.join(root, 'units'), { recursive: true })
    await fs.writeFile(path.join(root, 'units', 'tank.ini'), 'user-original', 'utf8')
    const remote = await makeZip({ 'units/tank.ini': 'remote-v3' })

    const first = await restoreRwmod(remote, root, 3)
    expect(first.backupDir).toBe('.ohmytx/backup/3')
    expect(await fs.readFile(path.join(root, '.ohmytx', 'backup', '3', 'units', 'tank.ini'), 'utf8')).toBe('user-original')
    expect(await fs.readFile(path.join(root, 'units', 'tank.ini'), 'utf8')).toBe('remote-v3')

    // 第二次对同一版本号拉取：不能把第一次的备份覆盖成「第一次拉取后的远端内容」
    const second = await restoreRwmod(remote, root, 3)
    expect(second.backupDir).not.toBe('.ohmytx/backup/3')
    expect(second.backupDir.startsWith('.ohmytx/backup/3-')).toBe(true)
    expect(await fs.readFile(path.join(root, '.ohmytx', 'backup', '3', 'units', 'tank.ini'), 'utf8')).toBe('user-original')
    expect(await fs.readFile(path.join(root, '.ohmytx', 'backup', second.backupDir.slice('.ohmytx/backup/'.length), 'units', 'tank.ini'), 'utf8')).toBe('remote-v3')
  })

  it('移走多余文件的中途失败：回滚把已移走的文件还原回工作树', async () => {
    const root = path.join(tmp, 'proj-rollback-move')
    await fs.mkdir(root)
    ctx.roots.add(normalizePath(root))
    await fs.writeFile(path.join(root, 'keep.ini'), 'keep', 'utf8')
    await fs.writeFile(path.join(root, 'extra-a.ini'), 'A', 'utf8')
    await fs.writeFile(path.join(root, 'extra-b.ini'), 'B', 'utf8')
    const bytes = await makeZip({ 'keep.ini': 'keep-head' })

    // 第一次 rename 把 extra-a 移入备份，第二次（移走 extra-b）故意失败
    // → 触发回滚的「移走文件还原」分支（第三次 rename 是还原，必须放行）
    fsHooks.renames = 0
    fsHooks.renameFailAt = 2
    try {
      await expect(restoreRwmod(bytes, root, 13)).rejects.toThrow('模拟移走失败')
    } finally {
      fsHooks.renameFailAt = 0
    }
    expect(await fs.readFile(path.join(root, 'extra-a.ini'), 'utf8')).toBe('A')
    expect(await fs.readFile(path.join(root, 'extra-b.ini'), 'utf8')).toBe('B')
    // 被覆盖文件也从备份还原
    expect(await fs.readFile(path.join(root, 'keep.ini'), 'utf8')).toBe('keep')
  })
})
