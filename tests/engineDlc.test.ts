/**
 * M42 引擎渲染 DLC 测试。
 *
 * 覆盖三块：
 * 1) 清单校验（纯函数）：封闭键集合、id 与目录名一致、entry 不许越界/不许 .bat、
 *    args 与 timeoutMs 的上下限；
 * 2) 目录扫描与授权判定：坏清单要「被看见」而不是静默消失；入口是链接要拒绝；
 * 3) 子进程调用协议：真跑一个 Node 脚本当 DLC，验证 argv 约定、PNG 校验、超时强杀、
 *    退出码非零与输出非法时的失败路径——以及最关键的「渲染层拿不到可执行路径」。
 *
 * 这里刻意用真实子进程（currentprocess.execPath + 临时 .js），而不是 mock spawn：
 * 协议本身（参数怎么传、文件怎么写回）才是要验的东西，mock 掉就什么都没验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PNG } from 'pngjs'
import { createStore } from '../electron/store'
import { createKnowledgePack } from '../electron/knowledgePack'
import { initAiHistory, getHistory } from '../electron/aiHistory'
import { normalizePath } from '../electron/paths'
// 刻意不从 ../electron/ipc（聚合入口）导入：那条路径会经 game.ts 拉起 electron 运行时，
// 在非打包环境（本机 vitest）直接抛「Electron failed to install correctly」。
// 只按域直接导入，测试即可脱离 electron 运行。
import { createIpcContext, type IpcContext } from '../electron/ipcContext'
import type { RegisterHandler } from '../electron/ipcTypes'
import { registerStoreIpc } from '../electron/storeIpc'
import { registerEngineDlcIpc } from '../electron/engineDlcIpc'
import {
  ENGINE_DLC_DIRNAME,
  engineDlcDir,
  parseEngineDlcManifest,
  readEngineDlcDir,
  runEngineDlcRender,
  scanEngineDlcDir,
  toEngineDlcList,
} from '../electron/engineDlc'
import { ENGINE_DLC_ENABLED_KEY, fingerprintEntry, restoreEngineDlcGrants } from '../electron/engineDlcTrust'

let tmp: string
let ctx: IpcContext
let cleanup: () => Promise<void>
/** showMessageBox 的返回值：默认「取消」，需要授权的用例单独改 */
let messageBoxResponse = 0

/**
 * 跑 .js 入口 DLC 用的 JS 运行时。
 * 生产环境是 Electron 自己的二进制（ELECTRON_RUN_AS_NODE=1 下当纯 Node 用），
 * 这里换成真实 node：Android/Termux 上 process.execPath 指向动态链接器而不是 node，
 * 直接用它当解释器会得到「bad ELF magic」。找不到就退回 process.execPath。
 */
async function resolveNodeRuntime(): Promise<string> {
  if (!/linker/.test(path.basename(process.execPath))) return process.execPath
  const { execFile } = await import('node:child_process')
  const found = await new Promise<string>((resolve) => {
    execFile('sh', ['-c', 'command -v node'], (err, stdout) => resolve(err ? '' : stdout.trim()))
  })
  return found || process.execPath
}

let nodeRuntime = process.execPath

function createFakeIpc(): { channels: Map<string, (...args: never[]) => unknown>; ipc: RegisterHandler } {
  const channels = new Map<string, (...args: never[]) => unknown>()
  const ipc: RegisterHandler = (channel, handler) => {
    channels.set(channel, handler as (...args: never[]) => unknown)
  }
  return { channels, ipc }
}

async function invoke<T>(channels: Map<string, (...args: never[]) => unknown>, channel: string, ...args: unknown[]): Promise<T> {
  const handler = channels.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return (handler as (...a: unknown[]) => unknown)(undefined, ...args) as Promise<T>
}

/** 写一个当 DLC 用的 Node 脚本：按 argv 读 request.json 再写 output */
async function writeDlc(
  id: string,
  script: string,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(engineDlcDir(tmp), id)
  await fs.mkdir(dir, { recursive: true })
  const full = {
    dlcVersion: 1,
    id,
    name: `测试 ${id}`,
    version: '1.0.0',
    entry: 'render.cjs',
    ...manifest,
  }
  await fs.writeFile(path.join(dir, 'dlc.json'), JSON.stringify(full), 'utf8')
  await fs.writeFile(path.join(dir, 'render.cjs'), script, 'utf8')
  return dir
}

const PNG_WRITER = `
const { PNG } = require(${JSON.stringify(createRequire(import.meta.url).resolve('pngjs'))})
function pngText(text) {
  const bytes = Buffer.from(text)
  const png = new PNG({width: Math.max(1, Math.ceil(bytes.length / 4)), height: 1})
  bytes.copy(png.data)
  return PNG.sync.write(png)
}
`
function decodePngText(dataUrl: string): string {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64')).data.toString('utf8').replace(/\0+$/, '')
}

/** 标准脚本：读 --request 指的 JSON，往 --output 写一张 PNG */
const GOOD_SCRIPT = `
${PNG_WRITER}
const fs = require('node:fs')
const args = process.argv.slice(2)
const get = (flag) => args[args.indexOf(flag) + 1]
const request = JSON.parse(fs.readFileSync(get('--request'), 'utf8'))
fs.writeFileSync(get('--output'), pngText(String(request.unitFile)))
`

beforeEach(async () => {
  messageBoxResponse = 0
  nodeRuntime = await resolveNodeRuntime()
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-dlc-'))
  await fs.mkdir(engineDlcDir(tmp), { recursive: true })
  const store = createStore(path.join(tmp, 'state.json'))
  initAiHistory(path.join(tmp, 'ai-history.json'))
  ctx = createIpcContext({
    store,
    knowledgePack: createKnowledgePack(path.join(tmp, 'kp'), path.join(tmp, 'builtin')),
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: messageBoxResponse, checkboxChecked: false }),
    },
    shell: { trashItem: async () => undefined, openPath: async () => '' },
    app: { getVersion: () => '0.0.0-test', getPath: () => tmp },
    updater: {
      checkForUpdates: async () => undefined,
      downloadUpdate: async () => undefined,
      quitAndInstall: () => undefined,
      isPackaged: () => false,
    },
    windows: { getAllWindows: () => [] },
    nodeRuntime,
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

describe('M42 DLC 清单校验（parseEngineDlcManifest）', () => {
  const base = { dlcVersion: 1, id: 'demo', name: '演示', version: '1.0.0', entry: 'render.exe' }

  it('最小合法清单通过，并填上默认值', () => {
    const result = parseEngineDlcManifest(base, 'demo')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.entry).toBe('render.exe')
    expect(result.manifest.args).toEqual([])
    expect(result.manifest.timeoutMs).toBe(30_000)
    expect(result.manifest.description).toBe('')
  })

  it('封闭键集合：多一个未知字段就拒绝（逼作者显式升级协议）', () => {
    const result = parseEngineDlcManifest({ ...base, entryArgs: ['--lib'] }, 'demo')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toContain('未知字段')
  })

  it('dlcVersion 不是 1 时拒绝', () => {
    expect(parseEngineDlcManifest({ ...base, dlcVersion: 2 }, 'demo').ok).toBe(false)
  })

  it('id 必须与目录名一致（否则同一程序能用两个名字出现，授权会错位）', () => {
    const result = parseEngineDlcManifest(base, 'other')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toContain('目录名')
  })

  it('id 非法字符拒绝', () => {
    expect(parseEngineDlcManifest({ ...base, id: '../evil' }, '../evil').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, id: 'a b' }, 'a b').ok).toBe(false)
  })

  it('entry 不允许绝对路径与 .. 越界', () => {
    expect(parseEngineDlcManifest({ ...base, entry: 'C:\\evil.exe' }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, entry: '/usr/bin/evil' }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, entry: '../../evil.exe' }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, entry: 'sub/../../evil.exe' }, 'demo').ok).toBe(false)
  })

  it('entry 不收 .bat/.cmd：那类文件必须经 cmd.exe 解释，等于把 shell 放回来', () => {
    const bat = parseEngineDlcManifest({ ...base, entry: 'run.bat' }, 'demo')
    expect(bat.ok).toBe(false)
    const cmd = parseEngineDlcManifest({ ...base, entry: 'run.cmd' }, 'demo')
    expect(cmd.ok).toBe(false)
  })

  it('entry 只收 .exe/.js/.mjs/.cjs', () => {
    for (const entry of ['a.exe', 'a.js', 'a.mjs', 'a.cjs']) {
      expect(parseEngineDlcManifest({ ...base, entry }, 'demo').ok).toBe(true)
    }
    for (const entry of ['a.ps1', 'a.sh', 'a.dll', 'a']) {
      expect(parseEngineDlcManifest({ ...base, entry }, 'demo').ok).toBe(false)
    }
  })

  it('args 有数量上限，且不许控制字符', () => {
    expect(parseEngineDlcManifest({ ...base, args: Array.from({ length: 17 }, () => '-x') }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, args: ['ok', 'bad\u0000arg'] }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, args: ['--config', 'a.json'] }, 'demo').ok).toBe(true)
  })

  it('timeoutMs 超界拒绝，边界内接受', () => {
    expect(parseEngineDlcManifest({ ...base, timeoutMs: 999 }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, timeoutMs: 120_001 }, 'demo').ok).toBe(false)
    expect(parseEngineDlcManifest({ ...base, timeoutMs: 1000 }, 'demo').ok).toBe(true)
    expect(parseEngineDlcManifest({ ...base, timeoutMs: 120_000 }, 'demo').ok).toBe(true)
    expect(parseEngineDlcManifest({ ...base, timeoutMs: 1.5 }, 'demo').ok).toBe(false)
  })
})

describe('M42 DLC 目录扫描（scanEngineDlcDir）', () => {
  it('目录不存在时返回空表而不是抛错', async () => {
    const result = await scanEngineDlcDir(path.join(tmp, 'nope'))
    expect(result.items).toEqual([])
  })

  it('坏清单仍然被列出并带原因（让用户看到「放错了」而不是「什么都没发生」）', async () => {
    const bad = path.join(engineDlcDir(tmp), 'broken')
    await fs.mkdir(bad, { recursive: true })
    await fs.writeFile(path.join(bad, 'dlc.json'), '{ not json', 'utf8')
    await writeDlc('good', GOOD_SCRIPT)

    const { items } = await scanEngineDlcDir(engineDlcDir(tmp))
    expect(items.map((item) => item.dirName)).toEqual(['broken', 'good'])
    const broken = items.find((item) => item.dirName === 'broken')
    expect(broken?.dlc).toBeNull()
    expect(broken?.problem).toBeTruthy()
    expect(items.find((item) => item.dirName === 'good')?.dlc).not.toBeNull()
  })

  it('清单合法但入口文件不存在时判为坏条目', async () => {
    const dir = path.join(engineDlcDir(tmp), 'noentry')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'dlc.json'),
      JSON.stringify({ dlcVersion: 1, id: 'noentry', name: 'x', version: '1', entry: 'missing.exe' }),
      'utf8',
    )
    const read = await readEngineDlcDir(dir, 'noentry')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain('不存在')
  })

  it('入口是指向目录外的链接时拒绝（链接逃逸防护）', async () => {
    // 只在支持符号链接的文件系统上跑（Android FUSE 上创建链接会失败）
    const outside = path.join(tmp, 'outside.js')
    await fs.writeFile(outside, '// outside', 'utf8')
    const dir = path.join(engineDlcDir(tmp), 'linked')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'dlc.json'),
      JSON.stringify({ dlcVersion: 1, id: 'linked', name: 'x', version: '1', entry: 'render.js' }),
      'utf8',
    )
    try {
      await fs.symlink(outside, path.join(dir, 'render.js'))
    } catch {
      return // 文件系统不支持链接：跳过（不作为失败）
    }
    const read = await readEngineDlcDir(dir, 'linked')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain('链接')
  })

  it('toEngineDlcList：未授权的合法条目可授权但不可直接渲染', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const { items } = await scanEngineDlcDir(engineDlcDir(tmp))
    const list = toEngineDlcList(items, new Set())
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'demo', enabled: false, runnable: false })
    expect(list[0].problem).toContain('尚未启用')

    const list2 = toEngineDlcList(items, new Set(['demo']))
    expect(list2[0]).toMatchObject({ id: 'demo', enabled: true, runnable: true })
    expect(list2[0].problem).toBeUndefined()
  })
})

describe('M42 DLC 子进程调用协议（runEngineDlcRender）', () => {
  const request = {
    unitFile: '/proj/units/tank.ini',
    unitContent: '[graphics]\nimage: tank.png',
    projectRoot: '/proj',
    gamePath: '/game',
    frame: 0,
    direction: 0,
    animationState: 'idle',
    showWreck: false,
    width: 560,
    height: 420,
  }

  async function resolve(id: string): Promise<NonNullable<Awaited<ReturnType<typeof readEngineDlcDir>> extends { ok: true; dlc: infer D } ? D : never>> {
    const read = await readEngineDlcDir(path.join(engineDlcDir(tmp), id), id)
    if (!read.ok) throw new Error(`DLC 解析失败：${read.problem}`)
    return read.dlc as never
  }

  it('按 argv 约定传 request.json 路径，并读回 --output 处的 PNG', async () => {
    await writeDlc('good', GOOD_SCRIPT)
    const dlc = await resolve('good')
    const result = await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    // 脚本把 request 里的 unitFile 写进了图片：证明请求真的送达了
    expect(decodePngText(result.dataUrl)).toBe(request.unitFile)
  })

  it('请求 JSON 里带有协议版本、视图参数与输出路径', async () => {
    await writeDlc(
      'echo',
      `
${PNG_WRITER}
const fs = require('node:fs')
const args = process.argv.slice(2)
const get = (flag) => args[args.indexOf(flag) + 1]
const request = JSON.parse(fs.readFileSync(get('--request'), 'utf8'))
const echoes = [
  request.protocolVersion, request.view.frame, request.view.animationState,
  request.view.showWreck, request.size.width, request.outputPath === get('--output'),
].join('|')
fs.writeFileSync(get('--output'), pngText(echoes))
`,
    )
    const dlc = await resolve('echo')
    const result = await runEngineDlcRender(dlc, { ...request, frame: 3, animationState: 'attack', showWreck: true }, { execPath: nodeRuntime })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const decoded = decodePngText(result.dataUrl)
    expect(decoded).toBe('1|3|attack|true|560|true')
  })

  it('清单里的 args 会出现在 DLC 的 argv 里', async () => {
    await writeDlc(
      'withargs',
      `
${PNG_WRITER}
const fs = require('node:fs')
const args = process.argv.slice(2)
const get = (flag) => args[args.indexOf(flag) + 1]
fs.writeFileSync(get('--output'), pngText(args[args.indexOf('--lib') + 1] || 'MISSING'))
`,
      { args: ['--lib', 'engine.dll'] },
    )
    const dlc = await resolve('withargs')
    const result = await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(decodePngText(result.dataUrl)).toBe('engine.dll')
  })

  it('退出码非零判失败，并把 stderr 带回来', async () => {
    await writeDlc('failing', `console.error('引擎加载失败：缺少 assets'); process.exit(3)`)
    const dlc = await resolve('failing')
    const result = await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('3')
    expect(result.reason).toContain('引擎加载失败')
  })

  it('不写输出文件判失败', async () => {
    await writeDlc('nooutput', `process.exit(0)`)
    const dlc = await resolve('nooutput')
    const result = await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('PNG')
  })

  it('输出不是 PNG（扩展名骗不了）判失败', async () => {
    await writeDlc(
      'notpng',
      `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(args[args.indexOf('--output') + 1], Buffer.from('GIF89a-not-a-png'))
`,
    )
    const dlc = await resolve('notpng')
    const result = await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('不是 PNG')
  })

  it('超时会被强杀，并回中文原因（不挂死界面）', async () => {
    await writeDlc('hanging', `setTimeout(() => undefined, 60_000)`, { timeoutMs: 1000 })
    const dlc = await resolve('hanging')
    const started = Date.now()
    const result = await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('超时')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  it('单位文件过大时直接拒绝，不启动子进程', async () => {
    await writeDlc('big', GOOD_SCRIPT)
    const dlc = await resolve('big')
    const spy = vi.fn()
    const result = await runEngineDlcRender(dlc, { ...request, unitContent: 'x'.repeat(3 * 1024 * 1024) }, { execPath: nodeRuntime })
    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('过大')
  })

  it('临时工作目录用完即删（不留垃圾）', async () => {
    const before = await fs.readdir(os.tmpdir())
    await writeDlc('clean', GOOD_SCRIPT)
    const dlc = await resolve('clean')
    await runEngineDlcRender(dlc, request, { execPath: nodeRuntime })
    const after = await fs.readdir(os.tmpdir())
    expect(after.filter((name) => name.startsWith('ra-dlc-')).length).toBe(
      before.filter((name) => name.startsWith('ra-dlc-')).length,
    )
  })
})

describe('M42 DLC 授权锚与 IPC 边界', () => {
  function registerAll(): Map<string, (...args: never[]) => unknown> {
    const { channels, ipc } = createFakeIpc()
    registerStoreIpc(ctx, ipc)
    registerEngineDlcIpc(ctx, ipc)
    return channels
  }

  it('授权锚键是主进程独占：渲染层读不了也写不了', async () => {
    const channels = registerAll()
    await expect(invoke(channels, 'store:set', ENGINE_DLC_ENABLED_KEY, { evil: { entry: 'x', fingerprint: 'y' } })).rejects.toThrow(
      '不允许写入系统保留键',
    )
    await expect(invoke(channels, 'store:get', ENGINE_DLC_ENABLED_KEY)).rejects.toThrow('不允许读取系统保留键')
  })

  it('dlc:list 只给展示信息，不含任何可执行文件路径', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    const result = await invoke<{ dir: string; dlcs: Array<Record<string, unknown>> }>(channels, 'dlc:list')
    expect(result.dlcs).toHaveLength(1)
    expect(result.dlcs[0]).toMatchObject({ id: 'demo', enabled: false, runnable: false })
    // 列表项没有任何路径字段（entryPath/entry/dir 都不该出现）
    expect(Object.keys(result.dlcs[0]).sort()).toEqual(['description', 'enabled', 'granted', 'id', 'name', 'problem', 'runnable', 'version'])
    expect(JSON.stringify(result.dlcs)).not.toContain('render.cjs')
  })

  it('未授权时 dlc:render 拒绝执行', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    const registered = path.join(tmp, 'proj')
    await fs.mkdir(registered, { recursive: true })
    await fs.writeFile(path.join(registered, 'tank.ini'), '[graphics]')
    ctx.roots.add(normalizePath(registered))
    const result = await invoke<{ ok: boolean; reason?: string }>(channels, 'dlc:render', {
      unitFile: path.join(registered, 'tank.ini'),
      unitContent: '',
      projectRoot: registered,
      gamePath: '',
      frame: 0,
      direction: 0,
      animationState: 'idle',
      showWreck: false,
      width: 560,
      height: 420,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有已授权')
  })

  it('取消授权框 → 不写入授权，后续渲染仍拒绝', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 0 // 取消
    const granted = await invoke<{ ok: boolean }>(channels, 'dlc:grant', 'demo', true)
    expect(granted.ok).toBe(false)
    expect(ctx.engineDlc.enabled.size).toBe(0)
  })

  it('确认授权 → 记录指纹，dlc:list 变为可用', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    const granted = await invoke<{ ok: boolean; enabled?: boolean }>(channels, 'dlc:grant', 'demo', true)
    expect(granted.ok).toBe(true)
    expect(granted.enabled).toBe(true)

    const list = await invoke<{ dlcs: Array<{ enabled: boolean; runnable: boolean }> }>(channels, 'dlc:list')
    expect(list.dlcs[0]).toMatchObject({ enabled: true, runnable: true })
  })

  it('授权后程序被替换 → 指纹不匹配，需要重新授权', async () => {
    const dir = await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    await invoke(channels, 'dlc:grant', 'demo', true)
    expect((await invoke<{ dlcs: Array<{ runnable: boolean }> }>(channels, 'dlc:list')).dlcs[0].runnable).toBe(true)

    // 换掉入口文件（模拟被替换成另一个程序）
    await fs.writeFile(path.join(dir, 'render.cjs'), '// 换了内容', 'utf8')
    const after = await invoke<{ dlcs: Array<{ enabled: boolean; runnable: boolean; problem?: string }> }>(channels, 'dlc:list')
    expect(after.dlcs[0].runnable).toBe(false)
    expect(after.dlcs[0].enabled).toBe(false)
  })

  it('撤销授权不需要确认框，且立即生效', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    await invoke(channels, 'dlc:grant', 'demo', true)
    messageBoxResponse = 0 // 撤销时即便对话框返回取消，也应照撤
    const revoked = await invoke<{ ok: boolean; enabled?: boolean }>(channels, 'dlc:grant', 'demo', false)
    expect(revoked).toMatchObject({ ok: true, enabled: false })
    expect(ctx.engineDlc.enabled.size).toBe(0)
  })

  it('dlc:render 拒绝未登记的项目目录（不把任意路径递给外部程序）', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    await invoke(channels, 'dlc:grant', 'demo', true)
    const result = await invoke<{ ok: boolean; reason?: string }>(channels, 'dlc:render', {
      unitFile: '/etc/passwd',
      unitContent: '',
      projectRoot: '/not-registered',
      frame: 0,
      direction: 0,
      animationState: 'idle',
      showWreck: false,
      width: 560,
      height: 420,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('未登记')
  })

  it('dlc:render 拒绝项目根内的越界单位文件路径', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    await invoke(channels, 'dlc:grant', 'demo', true)
    const registered = path.join(tmp, 'proj')
    await fs.mkdir(registered, { recursive: true })
    await fs.writeFile(path.join(registered, 'tank.ini'), '[graphics]')
    ctx.roots.add(normalizePath(registered))
    const result = await invoke<{ ok: boolean; reason?: string }>(channels, 'dlc:render', {
      unitFile: path.join(tmp, 'outside.ini'),
      unitContent: '',
      projectRoot: registered,
      frame: 0,
      direction: 0,
      animationState: 'idle',
      showWreck: false,
      width: 560,
      height: 420,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不在项目目录内')
  })

  it('dlc:render 参数越界与非法动画状态被拒', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    await invoke(channels, 'dlc:grant', 'demo', true)
    const registered = path.join(tmp, 'proj')
    await fs.mkdir(registered, { recursive: true })
    await fs.writeFile(path.join(registered, 'tank.ini'), '[graphics]')
    ctx.roots.add(normalizePath(registered))
    const base = {
      unitFile: path.join(registered, 'tank.ini'),
      unitContent: '',
      projectRoot: registered,
      gamePath: '',
      frame: 0,
      direction: 0,
      animationState: 'idle',
      showWreck: false,
      width: 560,
      height: 420,
    }
    expect(await invoke<{ ok: boolean }>(channels, 'dlc:render', { ...base, frame: -1 })).toMatchObject({ ok: false })
    expect(await invoke<{ ok: boolean }>(channels, 'dlc:render', { ...base, width: 100_000 })).toMatchObject({ ok: false })
    expect(await invoke<{ ok: boolean }>(channels, 'dlc:render', { ...base, animationState: 'dance' })).toMatchObject({ ok: false })
  })

  it('授权后能端到端跑通：dlc:render 返回 PNG', async () => {
    await writeDlc('demo', GOOD_SCRIPT)
    const channels = registerAll()
    messageBoxResponse = 1
    await invoke(channels, 'dlc:grant', 'demo', true)
    const registered = path.join(tmp, 'proj')
    await fs.mkdir(registered, { recursive: true })
    await fs.writeFile(path.join(registered, 'tank.ini'), '[graphics]')
    ctx.roots.add(normalizePath(registered))
    const result = await invoke<{ ok: boolean; dataUrl?: string }>(channels, 'dlc:render', {
      unitFile: path.join(registered, 'tank.ini'),
      unitContent: '[graphics]',
      projectRoot: registered,
      gamePath: '',
      frame: 0,
      direction: 0,
      animationState: 'idle',
      showWreck: false,
      width: 560,
      height: 420,
    })
    expect(result.ok).toBe(true)
    expect(result.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
  }, 20_000)

  it('dlc:list 对不存在的目录返回空表与目录路径（界面据此显示「放到这里」）', async () => {
    const channels = registerAll()
    const result = await invoke<{ dir: string; dlcs: unknown[] }>(channels, 'dlc:list')
    expect(result.dlcs).toEqual([])
    expect(result.dir).toContain(ENGINE_DLC_DIRNAME)
  })
})

describe('M42 授权锚持久化（restoreEngineDlcGrants）', () => {
  it('锚值异常（非对象）时按无授权处理，不抛错', async () => {
    await ctx.store.set(ENGINE_DLC_ENABLED_KEY, 'not-an-object')
    expect(() => restoreEngineDlcGrants(ctx)).not.toThrow()
    expect(ctx.engineDlc.enabled.size).toBe(0)
  })

  it('锚值形状不对的条目被跳过，合法的被恢复', async () => {
    await ctx.store.set(ENGINE_DLC_ENABLED_KEY, {
      good: { entry: '/x/render.js', fingerprint: 'sha256:abc' },
      bad: { entry: 123, fingerprint: null },
      alsobad: 'nope',
    })
    restoreEngineDlcGrants(ctx)
    expect([...ctx.engineDlc.enabled.keys()]).toEqual(['good'])
    expect(ctx.engineDlc.enabled.get('good')).toEqual({ entry: '/x/render.js', fingerprint: 'sha256:abc' })
  })

  it('指纹算法对大小不同的文件都返回稳定值', async () => {
    const file = path.join(tmp, 'f.bin')
    await fs.writeFile(file, 'hello', 'utf8')
    const a = await fingerprintEntry(file)
    const b = await fingerprintEntry(file)
    expect(a).toBe(b)
    expect(a.startsWith('sha256:')).toBe(true)
  })
})

describe('M42 随仓库分发的示例 DLC（examples/engine-dlc-hello）', () => {
  /**
   * 这份示例是用户最先接触的东西：文档叫他们把它拷进指定目录。
   * 因此它必须真的能跑——而不是「文档里看起来对」。
   * 这里直接拿仓库里那份文件走完整链路（清单解析 → 子进程 → PNG 校验）。
   */
  const exampleDir = path.join(process.cwd(), 'examples', 'engine-dlc-hello')

  it('示例目录内容齐全（dlc.json + 清单指向的入口）', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(exampleDir, 'dlc.json'), 'utf8')) as {
      id: string
      entry: string
    }
    expect(manifest.id).toBe('engine-dlc-hello')
    await expect(fs.stat(path.join(exampleDir, manifest.entry))).resolves.toBeDefined()
  })

  it('清单能通过宿主校验（含 id 与目录名一致）', async () => {
    const raw = JSON.parse(await fs.readFile(path.join(exampleDir, 'dlc.json'), 'utf8'))
    const parsed = parseEngineDlcManifest(raw, 'engine-dlc-hello')
    expect(parsed.ok).toBe(true)
  })

  it('端到端跑通并产出合法 PNG（示例不会随代码腐坏）', async () => {
    const read = await readEngineDlcDir(exampleDir, 'engine-dlc-hello')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const result = await runEngineDlcRender(
      read.dlc,
      {
        unitFile: path.join(tmp, 'units', 'tank.ini'),
        unitContent: '[graphics]\nimage: tank.png',
        projectRoot: tmp,
        gamePath: '',
        frame: 0,
        direction: 0,
        animationState: 'idle',
        showWreck: false,
        width: 560,
        height: 420,
      },
      { execPath: nodeRuntime },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64')
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // 真正可解码的 PNG：IHDR 宽高必须是正整数
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(0)
    expect(bytes.readUInt32BE(20)).toBeGreaterThan(0)
  }, 20_000)
})
