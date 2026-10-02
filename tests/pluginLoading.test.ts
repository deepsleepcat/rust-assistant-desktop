/**
 * 插件加载逻辑测试（M41）：
 *
 * 覆盖「插件能不能被安全地装载并取到资源」这条链，四层各测一层：
 * 1. 信任锚（pluginTrust）——登记/恢复/注销/锚值异常；
 * 2. 资源读取（plugin:readResource）——只读已登记目录，且拒绝穿越/绝对路径/链接逃逸/
 *    超限/不支持格式；图片给 data URL、文本给原文；
 * 3. 声明暴露（loadEnabledPluginData）——渲染器声明只在插件**已启用**且形状合法时产出；
 * 4. 适配器挑选（selectRendererAdapter）——必须同时「插件声明了」且「宿主注册了实现」。
 *
 * 安全边界是本文件的主角：插件目录锚值若可被渲染层伪造，就等于任意文件读取通道，
 * 所以第 1、2 层要覆盖到拒绝路径而不是只测成功路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../electron/store'
import { initAiHistory, getHistory } from '../electron/aiHistory'
import { createKnowledgePack } from '../electron/knowledgePack'
// 刻意不 import '../electron/ipc'：那个聚合入口会拉起 registerGameIpc → game.ts 的
// `import { shell } from 'electron'`（运行时值导入），在没有 Electron 二进制的环境里
// 整个套件会在收集期挂掉（项目里 ipc.test.ts / game.test.ts 共 83 个用例就是这么丢的）。
// 按具体模块导入可让本文件零 Electron 依赖，任何环境都能跑。
import { createIpcContext, type IpcContext } from '../electron/ipcContext'
import type { RegisterHandler } from '../electron/ipcTypes'
import { normalizePath } from '../electron/paths'
import { registerStoreIpc } from '../electron/storeIpc'
import { registerPluginIpc } from '../electron/pluginIpc'
import { PLUGIN_DIRS_KEY, registerPluginDir, restorePluginDirs, pluginDirOf, unregisterPluginDir } from '../electron/pluginTrust'
import { loadEnabledPluginData, selectRendererAdapter } from '../src/features/plugins/runtimeData'
import type { PluginResourcePayload } from '../src/types/bridge'

/** 假 ipc：把通道名 → 处理器记录进 Map（与 tests/ipc.test.ts 同款，按约定复用写法） */
function createFakeIpc(): { channels: Map<string, (...args: never[]) => unknown>; ipc: RegisterHandler } {
  const channels = new Map<string, (...args: never[]) => unknown>()
  const ipc: RegisterHandler = (channel, handler) => {
    channels.set(channel, handler)
  }
  return { channels, ipc }
}

async function invoke<T>(channels: Map<string, (...args: never[]) => unknown>, channel: string, ...args: unknown[]): Promise<T> {
  const h = channels.get(channel)
  if (!h) throw new Error(`通道未注册：${channel}`)
  return (h as (...a: unknown[]) => unknown)(undefined, ...args) as Promise<T>
}

/** 1×1 透明 PNG（与 tests/ipc.test.ts 同款基准图） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let tmp: string
let pluginDir: string
let ctx: IpcContext
let cleanup: () => Promise<void>

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-plugin-'))
  // 插件根单独一层，便于验证「逃逸到父目录」被拒
  pluginDir = path.join(tmp, 'plugin-root')
  await fs.mkdir(pluginDir, { recursive: true })
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
    await store.flush().catch(() => undefined)
    await getHistory().flush().catch(() => undefined)
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined)
  }
})

afterEach(async () => {
  await cleanup()
})

describe('M41 插件目录信任锚（pluginTrust）', () => {
  it('登记后可查到，且 id 大小写不敏感', async () => {
    await registerPluginDir(ctx, 'Demo.Atlas', pluginDir)
    expect(pluginDirOf(ctx, 'demo.atlas')).toBe(normalizePath(pluginDir))
    expect(pluginDirOf(ctx, 'DEMO.ATLAS')).not.toBeNull()
  })

  it('未登记的插件返回 null（不抛错，交给调用方给中文提示）', () => {
    expect(pluginDirOf(ctx, 'never.imported')).toBe(null)
  })

  it('登记会持久化锚值，重启后 restorePluginDirs 能恢复', async () => {
    await registerPluginDir(ctx, 'demo.atlas', pluginDir, ['atlas.png', 'data.json', 'big.png', 'link.png', 'nope.png', 'evil.exe'])
    await ctx.store.flush()
    // 模拟重启：新建一个空上下文，从同一份 store 恢复
    const fresh = { ...ctx, pluginDirs: new Map<string, string>() }
    restorePluginDirs(fresh)
    expect(fresh.pluginDirs.get('demo.atlas')).toBe(normalizePath(pluginDir))
  })

  it('注销后不再可查（插件卸载路径）', async () => {
    await registerPluginDir(ctx, 'demo.atlas', pluginDir, ['atlas.png', 'data.json', 'big.png', 'link.png', 'nope.png', 'evil.exe'])
    await unregisterPluginDir(ctx, 'demo.atlas')
    expect(pluginDirOf(ctx, 'demo.atlas')).toBe(null)
  })

  it('注销未登记的 id 是幂等的', async () => {
    await expect(unregisterPluginDir(ctx, 'ghost.plugin')).resolves.toBeUndefined()
  })

  it('锚值异常（非对象）时按「无插件」处理，不抛错', async () => {
    const broken = { ...ctx, pluginDirs: new Map<string, string>() }
    await ctx.store.set(PLUGIN_DIRS_KEY, 'not-an-object')
    expect(() => restorePluginDirs(broken)).not.toThrow()
    expect(broken.pluginDirs.size).toBe(0)
  })
})

describe('M41 插件资源读取（plugin:readResource）', () => {
  let channels: Map<string, (...args: never[]) => unknown>

  beforeEach(async () => {
    const fake = createFakeIpc()
    registerPluginIpc(ctx, fake.ipc)
    channels = fake.channels
    await registerPluginDir(ctx, 'demo.atlas', pluginDir, ['atlas.png', 'data.json', 'big.png', 'link.png', 'nope.png', 'evil.exe'])
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), TINY_PNG)
    await fs.writeFile(path.join(pluginDir, 'data.json'), '{"a":1}', 'utf8')
  })

  it('图片资源返回 data URL，且 MIME 按扩展名判定', async () => {
    const payload = await invoke<PluginResourcePayload>(channels, 'plugin:readResource', 'demo.atlas', 'atlas.png')
    expect(payload.kind).toBe('image')
    if (payload.kind !== 'image') throw new Error('unreachable')
    expect(payload.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(payload.dataUrl).toContain(TINY_PNG.toString('base64'))
  })

  it('文本资源返回原文', async () => {
    const payload = await invoke<PluginResourcePayload>(channels, 'plugin:readResource', 'demo.atlas', 'data.json')
    expect(payload).toEqual({ kind: 'text', text: '{"a":1}' })
  })

  it('未登记的插件 id 被拒绝（不能凭空指定目录）', async () => {
    await expect(invoke(channels, 'plugin:readResource', 'ghost.plugin', 'atlas.png'))
      .rejects.toThrow('该插件未登记来源目录')
  })

  it('插件标识为空被拒绝', async () => {
    await expect(invoke(channels, 'plugin:readResource', '', 'atlas.png')).rejects.toThrow('插件标识无效')
  })

  it('路径穿越被拒绝（不能读插件目录之外）', async () => {
    await fs.writeFile(path.join(tmp, 'outside.png'), TINY_PNG)
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', '../outside.png'))
      .rejects.toThrow('安全相对路径')
  })

  it('绝对路径被拒绝', async () => {
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', path.join(tmp, 'outside.png')))
      .rejects.toThrow('安全相对路径')
  })

  it('不支持的扩展名被拒绝', async () => {
    await fs.writeFile(path.join(pluginDir, 'evil.exe'), 'MZ', 'utf8')
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', 'evil.exe'))
      .rejects.toThrow('不支持读取该类型的插件资源')
  })

  it('不存在的资源给出中文提示', async () => {
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', 'nope.png'))
      .rejects.toThrow('插件资源不存在')
  })

  it('超过 8MB 的资源被拒绝', async () => {
    const big = path.join(pluginDir, 'big.png')
    await fs.writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', 'big.png'))
      .rejects.toThrow('超过 8MB 上限')
  })

  it('插件目录内指向外部的符号链接被拒绝（链接逃逸）', async () => {
    const outside = path.join(tmp, 'outside-secret.png')
    await fs.writeFile(outside, TINY_PNG)
    const link = path.join(pluginDir, 'link.png')
    try {
      await fs.symlink(outside, link)
    } catch (error) {
      throw new Error('环境无法创建符号链接，测试未覆盖', { cause: error })
    }
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', 'link.png')).rejects.toThrow()
  })
})

describe('M41 插件导入入口（plugin:importLocal）', () => {
  const MANIFEST = {
    manifestVersion: 1,
    id: 'import.demo',
    version: '1.0.0',
    name: '导入演示插件',
    capabilities: ['rendererAdapter'],
    resources: [{ id: 'atlas', path: 'atlas.png', kind: 'image' }],
    rendererAdapter: {
      formatVersion: 1,
      kind: 'canvas-2d',
      allowedCommands: ['drawTile'],
      resourceIds: ['atlas'],
      maxCommands: 32,
      maxResponseBytes: 32768,
    },
  }

  /** 让对话框「选中」某个路径；canceled 模拟用户取消 */
  function stubDialog(filePaths: string[], canceled = false): void {
    ctx.dialog.showOpenDialog = (async () => ({ canceled, filePaths })) as typeof ctx.dialog.showOpenDialog
  }

  let channels: Map<string, (...args: never[]) => unknown>

  beforeEach(async () => {
    const fake = createFakeIpc()
    registerPluginIpc(ctx, fake.ipc)
    channels = fake.channels
  })

  it('导入插件目录：校验通过、登记信任锚、返回清单与文件清单', async () => {
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST), 'utf8')
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), TINY_PNG)
    stubDialog([pluginDir])

    const selection = await invoke<{ source: string; manifest: { id: string }; files: unknown[] }>(
      channels, 'plugin:importLocal',
    )
    expect(selection).not.toBeNull()
    expect(selection.source).toBe('directory')
    expect(selection.manifest.id).toBe('import.demo')
    expect(selection.files.length).toBeGreaterThanOrEqual(2)
    // 关键：导入即登记锚值——后续 readResource 才有基准
    expect(pluginDirOf(ctx, 'import.demo')).toBe(normalizePath(pluginDir))
  })

  it('用户取消对话框 → 返回 null，不登记任何锚值', async () => {
    stubDialog([], true)
    const selection = await invoke(channels, 'plugin:importLocal')
    expect(selection).toBe(null)
    expect(ctx.pluginDirs.size).toBe(0)
  })

  it('目录根下缺少 manifest.json → 拒绝，且不登记锚值', async () => {
    stubDialog([pluginDir])
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow('插件目录根下必须有 manifest.json')
    expect(ctx.pluginDirs.size).toBe(0)
  })

  it('manifest 不合法（缺 name）→ 拒绝并给出中文原因，且不登记锚值', async () => {
    const bad = { ...MANIFEST, name: undefined }
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(bad), 'utf8')
    stubDialog([pluginDir])
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow()
    expect(ctx.pluginDirs.size).toBe(0)
  })

  it('manifest 含禁用字段（script）→ 拒绝（沿用既有的禁用键检查）', async () => {
    const evil = { ...MANIFEST, script: 'rm -rf /' }
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(evil), 'utf8')
    stubDialog([pluginDir])
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow()
    expect(ctx.pluginDirs.size).toBe(0)
  })

  it('插件目录含脚本/可执行文件 → 拒绝（目录收集阶段就拦住）', async () => {
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST), 'utf8')
    await fs.writeFile(path.join(pluginDir, 'payload.js'), 'alert(1)', 'utf8')
    stubDialog([pluginDir])
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow()
    expect(ctx.pluginDirs.size).toBe(0)
  })

  it('导入单个 manifest.json 文件：以其同级目录为插件根登记锚值', async () => {
    const manifestPath = path.join(pluginDir, 'manifest.json')
    await fs.writeFile(manifestPath, JSON.stringify(MANIFEST), 'utf8')
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), TINY_PNG)
    stubDialog([manifestPath])
    const selection = await invoke<{ source: string }>(channels, 'plugin:importLocal')
    expect(selection.source).toBe('json')
    expect(pluginDirOf(ctx, 'import.demo')).toBe(normalizePath(pluginDir))
  })

  async function importFixture(root = pluginDir, single = true) {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(MANIFEST))
    await fs.writeFile(path.join(root, 'atlas.png'), TINY_PNG)
    stubDialog([single ? path.join(root, 'manifest.json') : root])
    return invoke(channels, 'plugin:importLocal')
  }

  it.each([true, false])('只允许已声明资源，导入模式 single=%s', async (single) => {
    await fs.writeFile(path.join(pluginDir, 'unrelated.txt'), 'private')
    await importFixture(pluginDir, single)
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'unrelated.txt')).rejects.toThrow('白名单')
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'manifest.json')).rejects.toThrow('白名单')
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).resolves.toMatchObject({ kind: 'image' })
  })

  it('单清单缺资源或资源超限时拒绝，不安装也不登记', async () => {
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST))
    stubDialog([path.join(pluginDir, 'manifest.json')])
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow()
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow()
    expect(ctx.store.get(PLUGIN_DIRS_KEY)).toBeUndefined()
    expect(ctx.pluginDirs.size).toBe(0)
  })

  it('同 ID 冲突与存储失败均不污染 A 的持久授权', async () => {
    await importFixture()
    const original = ctx.store.get(PLUGIN_DIRS_KEY)
    await expect(importFixture(path.join(tmp, 'plugin-b'))).rejects.toThrow('冲突')
    expect(ctx.store.get(PLUGIN_DIRS_KEY)).toEqual(original)
    expect(pluginDirOf(ctx, 'import.demo')).toBe(normalizePath(pluginDir))
    const failing = vi.spyOn(ctx.store, 'setDurable').mockRejectedValueOnce(new Error('disk failure'))
    registerStoreIpc(ctx, (name, handler) => channels.set(name, handler))
    await expect(invoke(channels, 'store:set', 'plugins', { plugins: [] })).rejects.toThrow('disk failure')
    failing.mockRestore()
    expect(ctx.store.get(PLUGIN_DIRS_KEY)).toEqual(original)
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).resolves.toMatchObject({ kind: 'image' })
    await ctx.store.flush()
    const reopened = createStore(path.join(tmp, 'state.json'))
    await reopened.ready()
    const fresh = { ...ctx, store: reopened, pluginDirs: new Map<string, string>() }
    restorePluginDirs(fresh)
    expect(pluginDirOf(fresh, 'import.demo')).toBe(normalizePath(pluginDir))
    expect(reopened.get(PLUGIN_DIRS_KEY)).toEqual(original)
  })

  it('旧目录级授权不恢复，重新验证同一已安装声明后可恢复白名单', async () => {
    await importFixture()
    registerStoreIpc(ctx, (name, handler) => channels.set(name, handler))
    const state = await invoke(channels, 'store:get', 'plugins')
    await ctx.store.set('plugins', state)
    await ctx.store.set(PLUGIN_DIRS_KEY, { 'import.demo': pluginDir })
    restorePluginDirs(ctx)
    expect(ctx.pluginDirs.size).toBe(0)
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).rejects.toThrow('未登记')
    await expect(importFixture()).resolves.toBeTruthy()
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).resolves.toMatchObject({ kind: 'image' })
  })

  it('无效持久化配置与声明变更不保留资源授权', async () => {
    await importFixture()
    registerStoreIpc(ctx, (name, handler) => channels.set(name, handler))
    const original = ctx.store.get(PLUGIN_DIRS_KEY)
    await expect(invoke(channels, 'store:set', 'plugins', { plugins: [{ enabled: true, manifest: { ...MANIFEST, capabilities: ['rules'] } }] })).rejects.toThrow('无效')
    expect(ctx.store.get(PLUGIN_DIRS_KEY)).toEqual(original)
    await invoke(channels, 'store:set', 'plugins', { plugins: [{ enabled: false, manifest: MANIFEST }] })
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).resolves.toMatchObject({ kind: 'image' })
    await invoke(channels, 'store:set', 'plugins', { plugins: [{ enabled: true, manifest: { ...MANIFEST, version: '2.0.0' } }] })
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).rejects.toThrow('未登记')
  })

  it('资源父目录被 junction 替换后拒绝外部文件', async () => {
    const sub = path.join(pluginDir, 'images')
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(sub)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(sub, 'atlas.png'), TINY_PNG)
    await fs.writeFile(path.join(outside, 'atlas.png'), TINY_PNG)
    const manifest = { ...MANIFEST, resources: [{ id: 'atlas', path: 'images/atlas.png', kind: 'image' }] }
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest))
    stubDialog([pluginDir])
    await invoke(channels, 'plugin:importLocal')
    await fs.rm(sub, { recursive: true })
    await fs.symlink(outside, sub, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'images/atlas.png')).rejects.toThrow('真实路径逃逸')
  })

  it('安装提交失败不留下新插件或授权，失败后可重试', async () => {
    const failing = vi.spyOn(ctx.store, 'setDurable').mockRejectedValueOnce(new Error('disk failure'))
    await expect(importFixture()).rejects.toThrow('disk failure')
    failing.mockRestore()
    expect(ctx.pluginDirs.size).toBe(0)
    expect(ctx.store.get(PLUGIN_DIRS_KEY)).toBeUndefined()
    await expect(importFixture()).resolves.toBeTruthy()
  })

  it('真实磁盘 rename 失败不改变已安装授权与原磁盘快照，恢复后可继续提交', async () => {
    await importFixture()
    registerStoreIpc(ctx, (name, handler) => channels.set(name, handler))
    const original = ctx.store.get(PLUGIN_DIRS_KEY)
    const diskPath = path.join(tmp, 'state.json')
    const backupPath = path.join(tmp, 'backup.json')
    await ctx.store.flush()
    await fs.rename(diskPath, backupPath)
    await fs.mkdir(diskPath) // rename of the temporary JSON over a directory must fail.
    await expect(invoke(channels, 'store:set', 'plugins', { plugins: [] })).rejects.toThrow()
    expect(ctx.store.get(PLUGIN_DIRS_KEY)).toEqual(original)
    expect(pluginDirOf(ctx, 'import.demo')).toBe(normalizePath(pluginDir))
    expect(JSON.parse(await fs.readFile(backupPath, 'utf8'))[PLUGIN_DIRS_KEY]).toEqual(original)
    await fs.rmdir(diskPath)
    await fs.rename(backupPath, diskPath)
    await invoke(channels, 'store:set', 'plugins', { plugins: [] })
    expect(pluginDirOf(ctx, 'import.demo')).toBeNull()
    expect(JSON.parse(await fs.readFile(diskPath, 'utf8'))[PLUGIN_DIRS_KEY].state.plugins).toEqual([])
  })

  it('串行化并发同 ID 安装，只有一个成功', async () => {
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST))
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), TINY_PNG)
    stubDialog([pluginDir])
    const results = await Promise.allSettled([invoke(channels, 'plugin:importLocal'), invoke(channels, 'plugin:importLocal')])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('卸载状态提交同时撤销资源授权，renderer 不能伪造保留键', async () => {
    await importFixture()
    registerStoreIpc(ctx, (name, handler) => channels.set(name, handler))
    await expect(invoke(channels, 'store:set', PLUGIN_DIRS_KEY, {})).rejects.toThrow('保留键')
    await expect(invoke(channels, 'store:get', PLUGIN_DIRS_KEY)).rejects.toThrow('保留键')
    await invoke(channels, 'store:set', 'plugins', { plugins: [] })
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).rejects.toThrow('未登记')
    await invoke(channels, 'plugin:forgetLocal', 'import.demo')
    await expect(invoke(channels, 'plugin:forgetLocal', '')).rejects.toThrow('标识无效')
  })

  it('真实 junction 替换资源祖先和根目录均拒绝', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'atlas.png'), TINY_PNG)
    await importFixture()
    await fs.rename(pluginDir, path.join(tmp, 'original'))
    await fs.symlink(outside, pluginDir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png')).rejects.toThrow('真实路径逃逸')
  })

  it('导入非 manifest.json 的单文件 → 拒绝', async () => {
    const other = path.join(pluginDir, 'other.json')
    await fs.writeFile(other, JSON.stringify(MANIFEST), 'utf8')
    stubDialog([other])
    await expect(invoke(channels, 'plugin:importLocal')).rejects.toThrow('只能导入名为 manifest.json 的插件清单')
  })

  it('导入后的插件可以立即读到资源（导入 → 读取闭环）', async () => {
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST), 'utf8')
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), TINY_PNG)
    stubDialog([pluginDir])
    await invoke(channels, 'plugin:importLocal')

    const payload = await invoke<PluginResourcePayload>(channels, 'plugin:readResource', 'import.demo', 'atlas.png')
    expect(payload.kind).toBe('image')
  })

  it('卸载（forgetLocal）后不再能读该插件资源', async () => {
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST), 'utf8')
    await fs.writeFile(path.join(pluginDir, 'atlas.png'), TINY_PNG)
    stubDialog([pluginDir])
    await invoke(channels, 'plugin:importLocal')
    await invoke(channels, 'plugin:forgetLocal', 'import.demo')

    await expect(invoke(channels, 'plugin:readResource', 'import.demo', 'atlas.png'))
      .rejects.toThrow('该插件未登记来源目录')
  })
})

describe('M41 渲染器声明暴露（loadEnabledPluginData.rendererAdapters）', () => {
  const validManifest = {
    manifestVersion: 1,
    id: 'demo.atlas',
    version: '1.0.0',
    name: '演示图集插件',
    capabilities: ['rendererAdapter'],
    resources: [
      { id: 'atlas', path: 'atlas.png', kind: 'image' },
      { id: 'notes', path: 'data.json', kind: 'data' },
    ],
    rendererAdapter: {
      formatVersion: 1,
      kind: 'canvas-2d',
      allowedCommands: ['drawTile', 'fillRect'],
      resourceIds: ['atlas'],
      maxCommands: 64,
      maxResponseBytes: 65536,
    },
  }
  const wrap = (enabled: boolean, manifest: unknown) => ({ plugins: [{ enabled, manifest }] })

  it('已启用插件产出渲染器声明，含图像资源与预算', () => {
    const data = loadEnabledPluginData(wrap(true, validManifest))
    expect(data.rendererAdapters).toHaveLength(1)
    const adapter = data.rendererAdapters[0]
    expect(adapter.pluginId).toBe('demo.atlas')
    expect(adapter.pluginName).toBe('演示图集插件')
    expect(adapter.allowedCommands).toEqual(['drawTile', 'fillRect'])
    expect(adapter.maxCommands).toBe(64)
    expect(adapter.maxResponseBytes).toBe(65536)
    // 只暴露图片资源，kind=data 的不进渲染器资源表
    expect(adapter.resources).toEqual([{ id: 'atlas', path: 'atlas.png' }])
    expect(adapter.resourceIds).toEqual(['atlas'])
  })

  it('未启用的插件不产出（enabled 必须为 true）', () => {
    expect(loadEnabledPluginData(wrap(false, validManifest)).rendererAdapters).toHaveLength(0)
  })

  it('无渲染器声明的插件不产出', () => {
    const noAdapter = { ...validManifest, capabilities: ['rules'], rendererAdapter: undefined }
    expect(loadEnabledPluginData(wrap(true, noAdapter)).rendererAdapters).toHaveLength(0)
  })

  it('allowedCommands 全为未知指令时视为无效声明（不能画任何东西）', () => {
    const bad = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, allowedCommands: ['runShell'] } }
    expect(loadEnabledPluginData(wrap(true, bad)).rendererAdapters).toHaveLength(0)
  })

  it('formatVersion / kind 不符时视为无效声明', () => {
    const wrongVersion = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, formatVersion: 2 } }
    const wrongKind = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, kind: 'webgl' } }
    expect(loadEnabledPluginData(wrap(true, wrongVersion)).rendererAdapters).toHaveLength(0)
    expect(loadEnabledPluginData(wrap(true, wrongKind)).rendererAdapters).toHaveLength(0)
  })

  it('maxCommands / maxResponseBytes 非正整数时视为无效声明', () => {
    const zero = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, maxCommands: 0 } }
    const float = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, maxResponseBytes: 1.5 } }
    expect(loadEnabledPluginData(wrap(true, zero)).rendererAdapters).toHaveLength(0)
    expect(loadEnabledPluginData(wrap(true, float)).rendererAdapters).toHaveLength(0)
  })

  it('resourceIds 引用了未声明的资源时整体拒绝', () => {
    const bad = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, resourceIds: ['atlas', 'ghost'] } }
    const data = loadEnabledPluginData(wrap(true, bad))
    expect(data.rendererAdapters).toEqual([])
  })

  it.each([
    { ...validManifest, capabilities: ['rules'] },
    { ...validManifest, resources: [{ id: 'atlas', path: '../atlas.png', kind: 'image' }] },
    { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, allowedCommands: ['drawTile', 'runShell'] } },
    { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, maxCommands: 999999 } },
    { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, maxResponseBytes: 999999999 } },
  ])('无效持久化声明不能暴露或选中 %#', (manifest) => {
    const data = loadEnabledPluginData(wrap(true, manifest))
    expect(data.rendererAdapters).toEqual([])
    expect(selectRendererAdapter(data.rendererAdapters, ['demo.atlas'], 'builtin')).toBeNull()
  })

  it('含禁用字段的 manifest 整体被拒（沿用既有的禁用键检查）', () => {
    const evil = { ...validManifest, script: 'rm -rf /' }
    expect(loadEnabledPluginData(wrap(true, evil)).rendererAdapters).toHaveLength(0)
  })

  it('空/异常输入返回空数组而不是抛错', () => {
    for (const raw of [null, undefined, 42, 'x', {}, { plugins: 'nope' }]) {
      expect(loadEnabledPluginData(raw).rendererAdapters).toEqual([])
    }
  })
})

describe('M41 适配器挑选（selectRendererAdapter）', () => {
  const adapter = {
    pluginId: 'demo.atlas',
    pluginName: '演示图集插件',
    resources: [],
    allowedCommands: ['drawTile'],
    resourceIds: [],
    maxCommands: 64,
    maxResponseBytes: 65536,
  }

  it('插件声明了且宿主注册了实现 → 选中', () => {
    const picked = selectRendererAdapter([adapter], ['demo.atlas'], 'builtin.unitpreview')
    expect(picked?.pluginId).toBe('demo.atlas')
  })

  it('插件声明了但宿主没有实现 → 不选（声明只是「想接管」，实现才是「能接管」）', () => {
    expect(selectRendererAdapter([adapter], [], 'builtin.unitpreview')).toBe(null)
  })

  it('内置适配器 id 永远不会被当成插件选中', () => {
    const builtinLike = { ...adapter, pluginId: 'builtin.unitpreview' }
    expect(selectRendererAdapter([builtinLike], ['builtin.unitpreview'], 'builtin.unitpreview')).toBe(null)
  })

  it('比较时大小写不敏感（注册表内部按小写归一）', () => {
    const picked = selectRendererAdapter([{ ...adapter, pluginId: 'demo.atlas' }], ['DEMO.ATLAS'], 'builtin.unitpreview')
    expect(picked?.pluginId).toBe('demo.atlas')
  })

  it('无插件时返回 null（调用方据此回退本地合成）', () => {
    expect(selectRendererAdapter([], ['builtin.unitpreview'], 'builtin.unitpreview')).toBe(null)
  })

  it('多个候选时取第一个可用的', () => {
    const second = { ...adapter, pluginId: 'other.one' }
    const picked = selectRendererAdapter([adapter, second], ['other.one'], 'builtin.unitpreview')
    expect(picked?.pluginId).toBe('other.one')
  })
})
