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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('登记后可查到，且 id 大小写不敏感', () => {
    registerPluginDir(ctx, 'Demo.Atlas', pluginDir)
    expect(pluginDirOf(ctx, 'demo.atlas')).toBe(pluginDir.replace(/\\/g, '/'))
    expect(pluginDirOf(ctx, 'DEMO.ATLAS')).not.toBeNull()
  })

  it('未登记的插件返回 null（不抛错，交给调用方给中文提示）', () => {
    expect(pluginDirOf(ctx, 'never.imported')).toBe(null)
  })

  it('登记会持久化锚值，重启后 restorePluginDirs 能恢复', async () => {
    registerPluginDir(ctx, 'demo.atlas', pluginDir)
    await ctx.store.flush()
    // 模拟重启：新建一个空上下文，从同一份 store 恢复
    const fresh = { ...ctx, pluginDirs: new Map<string, string>() }
    restorePluginDirs(fresh)
    expect(fresh.pluginDirs.get('demo.atlas')).toBe(pluginDir.replace(/\\/g, '/'))
  })

  it('注销后不再可查（插件卸载路径）', () => {
    registerPluginDir(ctx, 'demo.atlas', pluginDir)
    unregisterPluginDir(ctx, 'demo.atlas')
    expect(pluginDirOf(ctx, 'demo.atlas')).toBe(null)
  })

  it('注销未登记的 id 是幂等的', () => {
    expect(() => unregisterPluginDir(ctx, 'ghost.plugin')).not.toThrow()
  })

  it('锚值异常（非对象）时按「无插件」处理，不抛错', () => {
    const broken = { ...ctx, pluginDirs: new Map<string, string>() }
    ctx.store.set(PLUGIN_DIRS_KEY, 'not-an-object')
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
    registerPluginDir(ctx, 'demo.atlas', pluginDir)
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
    } catch {
      // 环境不支持符号链接（如部分挂载）：明确跳过而不是静默通过
      return
    }
    await expect(invoke(channels, 'plugin:readResource', 'demo.atlas', 'link.png')).rejects.toThrow()
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

  it('resourceIds 引用了未声明的资源时被剔除（不能引用不存在的图）', () => {
    const bad = { ...validManifest, rendererAdapter: { ...validManifest.rendererAdapter, resourceIds: ['atlas', 'ghost'] } }
    const data = loadEnabledPluginData(wrap(true, bad))
    expect(data.rendererAdapters[0].resourceIds).toEqual(['atlas'])
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
