import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PNG } from 'pngjs'
import { deflateSync } from 'node:zlib'
import { createIpcContext, type IpcContext } from '../electron/ipcContext'
import { createStore } from '../electron/store'
import { createKnowledgePack } from '../electron/knowledgePack'
import { normalizePath } from '../electron/paths'
import { registerEngineDlcIpc } from '../electron/engineDlcIpc'
import { EngineDlcHost } from '../electron/engineDlcHost'
import { isPng } from '../electron/engineDlc'
import { ENGINE_DLC_ENABLED_KEY, fingerprintEntry } from '../electron/engineDlcTrust'

let tmp: string
let ctx: IpcContext
let handlers: Map<string, (...args: never[]) => unknown>
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel) as unknown as (...values: unknown[]) => unknown
  return handler(undefined, ...args)
}

/**
 * 真实渲染用例的固定预算：Windows 上每次 render 都要新起 PowerShell 并现场编译 C# launcher，
 * 实测启动长尾可达 15s；与同文件/engineDlc.test.ts 现有 15–20s 的真子进程用例保持一致。
 * 内部等待必须早于外部 deadline 失败，才能走完 finally 的取消+drain 再进 afterEach 删目录。
 */
const REAL_RENDER_BUDGET_MS = 20_000
const REAL_RENDER_READY_TIMEOUT_MS = REAL_RENDER_BUDGET_MS - 2_000

/** 失败路径也要能回收仍在跑的真实渲染：render 只在 kill 完成后 resolve，await 它即完成 drain。 */
const inFlightRenders = new Set<Promise<unknown>>()
function trackRender<T>(promise: Promise<T>): Promise<T> {
  const tracked = promise.then(() => undefined, () => undefined)
  inFlightRenders.add(tracked)
  void tracked.finally(() => { inFlightRenders.delete(tracked) })
  return promise
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-security-'))
  const store = createStore(path.join(tmp, 'state.json'))
  await store.ready()
  ctx = createIpcContext({
    store, knowledgePack: createKnowledgePack(path.join(tmp, 'kp'), path.join(tmp, 'builtin')),
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    },
    shell: { trashItem: async () => undefined, openPath: async () => '' },
    app: { getVersion: () => 'test', getPath: () => tmp },
    updater: { checkForUpdates: async () => undefined, downloadUpdate: async () => undefined, quitAndInstall: () => undefined, isPackaged: () => false },
    windows: { getAllWindows: () => [] }, nodeRuntime: process.execPath,
  })
  handlers = new Map()
  registerEngineDlcIpc(ctx, (channel, handler) => { handlers.set(channel, handler) })
})
afterEach(async () => {
  // 被超时截断的用例可能留下仍在跑的真实渲染：先请求取消（owner 0 的 legacy 请求），
  // 再等 render 真正结束（kill 完成后才 resolve），最后才删 tmp——活进程持有 cwd 时 rm 只会 EBUSY。
  await invoke('dlc:render', { cancel: true, requestId: 'legacy' }).catch(() => undefined)
  await Promise.allSettled([...inFlightRenders])
  await ctx.store.flush()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

async function fixture(script = 'process.exit(0)', grant = true) {
  // 锚点在本文件内推导；每个落盘路径都单独做根锚定包含校验后再写入
  const dlcRoot = path.join(tmp, 'engine-dlc')
  const dir = path.resolve(dlcRoot, 'demo')
  const manifestPath = path.resolve(dlcRoot, 'demo', 'dlc.json')
  const entryPath = path.resolve(dlcRoot, 'demo', 'render.cjs')
  if (!dir.startsWith(dlcRoot + path.sep)) throw new Error('DLC 目录越界')
  if (!manifestPath.startsWith(dlcRoot + path.sep)) throw new Error('DLC 清单路径越界')
  if (!entryPath.startsWith(dlcRoot + path.sep)) throw new Error('DLC 入口路径越界')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify({ dlcVersion: 1, id: 'demo', name: 'Demo', version: '1', entry: 'render.cjs' }))
  await fs.writeFile(entryPath, script)
  if (grant) expect(await invoke('dlc:grant', 'demo', true)).toMatchObject({ ok: true })
  const root = path.join(tmp, 'project')
  const tankIni = path.resolve(root, 'tank.ini')
  if (!tankIni.startsWith(root + path.sep)) throw new Error('单位文件路径越界')
  await fs.mkdir(root)
  await fs.writeFile(tankIni, '[graphics]')
  ctx.roots.add(normalizePath(root))
  const request = { unitFile: tankIni, unitContent: '[graphics]', projectRoot: root,
    gamePath: '', frame: 0, direction: 0, animationState: 'idle', showWreck: false, width: 560, height: 420 }
  return { dir, root, request }
}

describe('PR4 authorization regressions', () => {
  it('hashes >64MB bytes even when replacement preserves size and mtime', async () => {
    const entry = path.join(tmp, 'large.exe')
    const handle = await fs.open(entry, 'w')
    await handle.truncate(65 * 1024 * 1024)
    await handle.close()
    const stat = await fs.stat(entry)
    const first = await fingerprintEntry(entry)
    const writer = await fs.open(entry, 'r+')
    await writer.write(Buffer.from('changed'), 0, 7, 64 * 1024 * 1024 + 100)
    await writer.close()
    await fs.utimes(entry, stat.atime, stat.mtime)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await fingerprintEntry(entry)).not.toBe(first)
    expect((await fs.stat(entry)).size).toBe(stat.size)
    expect(Math.round((await fs.stat(entry)).mtimeMs)).toBe(Math.round(stat.mtimeMs))
  })

  it.each(['args', 'timeoutMs'])('invalidates trust after changing %s only', async (field) => {
    const { dir } = await fixture()
    const manifestPath = path.join(dir, 'dlc.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest[field] = field === 'args' ? ['--require', 'other.cjs'] : 1000
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    expect(await invoke('dlc:list')).toMatchObject({ dlcs: [{ runnable: false }] })
  })

  it.each(['entry', 'args'])('refuses mutations during confirmation: %s', async (what) => {
    const { dir } = await fixture(undefined, false)
    ctx.dialog.showMessageBox = async (options) => {
      expect((options as Electron.MessageBoxOptions).detail).toContain('参数（JSON）：[]')
      expect((options as Electron.MessageBoxOptions).detail).toContain('SHA256：sha256:')
      if (what === 'entry') await fs.writeFile(path.join(dir, 'render.cjs'), '// replacement')
      else {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, 'dlc.json'), 'utf8'))
        await fs.writeFile(path.join(dir, 'dlc.json'), JSON.stringify({ ...manifest, args: ['new-argument'] }))
      }
      return { response: 1, checkboxChecked: false }
    }
    expect(await invoke('dlc:grant', 'demo', true)).toMatchObject({ ok: false })
    expect(ctx.engineDlc.enabled.size).toBe(0)
  })

  it('revoke supersedes an open confirmation dialog', async () => {
    await fixture(undefined, false)
    ctx.dialog.showMessageBox = async () => {
      await invoke('dlc:grant', 'demo', false)
      return { response: 1, checkboxChecked: false }
    }
    expect(await invoke('dlc:grant', 'demo', true)).toMatchObject({ ok: false })
    expect(ctx.engineDlc.enabled.size).toBe(0)
  })

  it('lists a removed installation so settings can still revoke its stale grant', async () => {
    const { dir } = await fixture()
    await fs.rm(dir, { recursive: true })
    expect(await invoke('dlc:list')).toMatchObject({ dlcs: [{ id: 'demo', granted: true, runnable: false, enabled: false }] })
    expect(await invoke('dlc:grant', 'demo', false)).toMatchObject({ ok: true })
    expect(await invoke('dlc:list')).toMatchObject({ dlcs: [] })
  })

  it.each(['dlc.json', 'render.cjs'])('revokes despite missing %s without resurrecting on restore', async (file) => {
    const { dir } = await fixture()
    const target = path.resolve(dir, file)
    if (!target.startsWith(dir + path.sep)) throw new Error(`越界：${file}`)
    const contents = await fs.readFile(target)
    await fs.unlink(target)
    expect(await invoke('dlc:grant', 'demo', false)).toMatchObject({ ok: true, enabled: false })
    await fs.writeFile(target, contents)
    expect(await invoke('dlc:list')).toMatchObject({ dlcs: [{ runnable: false }] })
    expect(ctx.store.get(ENGINE_DLC_ENABLED_KEY)).toEqual({})
    expect(await invoke('dlc:grant', '../demo', false)).toMatchObject({ ok: false })
  })
})

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

describe('PR4 path, PNG and lifecycle regressions', () => {
  it.each(['inflate', 'duplicateHeader', 'palette'])('rejects valid-CRC PNG allocation attacks: %s', (kind) => {
    const valid = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    const header = Buffer.from(valid.subarray(16, 29))
    if (kind === 'inflate') header[12] = 1
    const middle = kind === 'duplicateHeader' ? pngChunk('IHDR', header)
      : kind === 'palette' ? pngChunk('PLTE', Buffer.alloc(769)) : Buffer.alloc(0)
    const malicious = Buffer.concat([valid.subarray(0, 8), pngChunk('IHDR', header), middle,
      pngChunk('IDAT', deflateSync(Buffer.alloc(kind === 'inflate' ? 1024 * 1024 : 5))), pngChunk('IEND', Buffer.alloc(0))])
    expect(isPng(malicious)).toBe(false)
    expect(isPng(valid)).toBe(true)
  })
  it('rejects a real project junction pointing outside (creation failure fails)', async () => {
    const { root, request } = await fixture()
    const external = path.join(tmp, 'external')
    await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'tank.ini'), 'outside')
    const linked = path.join(root, 'linked')
    await fs.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await fs.realpath(linked)).toBe(await fs.realpath(external))
    expect(await trackRender(invoke('dlc:render', { ...request, unitFile: path.join(linked, 'tank.ini') }))).toMatchObject({ ok: false, reason: expect.stringContaining('目录外') })
  })

  it.each(['header', 'truncated', 'crc', 'dimensions'])('rejects corrupt PNG from a real child: %s', async (kind) => {
    const png = new PNG({ width: 1, height: 1 })
    let bytes = PNG.sync.write(png)
    if (kind === 'header') bytes = bytes.subarray(0, 9)
    if (kind === 'truncated') bytes = bytes.subarray(0, bytes.length - 5)
    if (kind === 'crc') bytes[29] ^= 0xff
    if (kind === 'dimensions') bytes.writeUInt32BE(100000, 16)
    const script = `const fs=require('node:fs'); const a=process["argv"]; fs.writeFileSync(a[a.indexOf('--output')+1], Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'))`
    const { request } = await fixture(script)
    expect(await trackRender(invoke('dlc:render', request))).toMatchObject({ ok: false, reason: expect.stringContaining('PNG') })
  }, REAL_RENDER_BUDGET_MS)

  it('accepts a complete Adam7 PNG and rejects a missing final pass row', () => {
    const valid = PNG.sync.write(new PNG({ width: 2, height: 2 }))
    const header = Buffer.from(valid.subarray(16, 29))
    header[12] = 1
    const make = (length: number) => Buffer.concat([valid.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(length))), pngChunk('IEND', Buffer.alloc(0))])
    expect(isPng(make(19))).toBe(true)
    expect(isPng(make(18))).toBe(false)
  })

  it.each(['shortPixels', 'rgbDepth1', 'rgbaDepth4'])('rejects legal-CRC malformed pixel payloads: %s', async (kind) => {
    const valid = PNG.sync.write(new PNG({ width: 2, height: 2 }))
    const header = Buffer.from(valid.subarray(16, 29))
    let length = 5
    if (kind !== 'shortPixels') {
      header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4)
      header[8] = kind === 'rgbDepth1' ? 1 : 4
      header[9] = kind === 'rgbDepth1' ? 2 : 6
      length = kind === 'rgbDepth1' ? 2 : 3
    }
    const malformed = Buffer.concat([valid.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(length))), pngChunk('IEND', Buffer.alloc(0))])
    expect(isPng(malformed)).toBe(false)
    const { request } = await fixture(`const a=process["argv"];require('node:fs').writeFileSync(a[a.indexOf('--output')+1],Buffer.from(${JSON.stringify(malformed.toString('base64'))},'base64'))`)
    expect(await trackRender(invoke('dlc:render', request))).toMatchObject({ ok: false, reason: expect.stringContaining('PNG') })
  }, REAL_RENDER_BUDGET_MS)

  it('normal parent exit cleans a real detached unref worker before returning success', async () => {
    const pidFile = path.join(tmp, 'detached.pid')
    const valid = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process["execPath"],['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));const a=process["argv"];fs.writeFileSync(a[a.indexOf('--output')+1],Buffer.from(${JSON.stringify(valid.toString('base64'))},'base64'))`
    const { request } = await fixture(script)
    const result = await trackRender(invoke('dlc:render', request))
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    try {
      expect(result).toMatchObject({ ok: true })
      await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() }, { timeout: REAL_RENDER_READY_TIMEOUT_MS })
    } finally {
      try { process.kill(pid, 'SIGKILL') } catch { /* already terminated */ }
    }
  }, REAL_RENDER_BUDGET_MS)

  it.each(['cancel', 'revoke', 'destroy', 'foreignCancel'])('stops a real process tree on %s and cleans temp files', async (action) => {
    const pidFile = path.join(tmp, 'grandchild.pid')
    const workDirFile = path.join(tmp, 'render-work-dir.json')
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const a=process["argv"]; const workDir=require('node:path').dirname(a[a.indexOf('--output')+1]); const child=spawn(process["execPath"],['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(workDirFile)},JSON.stringify({workDir,parentPid:process.pid})); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000)`
    const { request } = await fixture(script)
    const sender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false })
    const handler = handlers.get('dlc:render') as unknown as (event: unknown, payload: unknown) => Promise<unknown>
    const running = trackRender(handler({ sender }, { ...request, requestId: 'in-flight' }))
    try {
      await vi.waitFor(async () => { expect(await fs.readFile(pidFile, 'utf8')).toMatch(/^[0-9]+$/) }, { timeout: REAL_RENDER_READY_TIMEOUT_MS })
      const pid = Number(await fs.readFile(pidFile, 'utf8'))
      const { workDir, parentPid } = JSON.parse(await fs.readFile(workDirFile, 'utf8')) as { workDir: string; parentPid: number }
      expect(path.basename(workDir)).toMatch(/^ra-dlc-/)
      expect((await fs.stat(workDir)).isDirectory()).toBe(true)
      expect(JSON.parse(await fs.readFile(path.join(workDir, 'request.json'), 'utf8')).unitFile).toBe(request.unitFile)
      if (action === 'foreignCancel') {
        const stranger = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false })
        await handler({ sender: stranger }, { cancel: true, requestId: 'in-flight' })
        expect(() => process.kill(pid, 0)).not.toThrow()
        await handler({ sender }, { cancel: true, requestId: 'in-flight' })
      }
      if (action === 'cancel') await handler({ sender }, { cancel: true, requestId: 'in-flight' })
      if (action === 'revoke') await invoke('dlc:grant', 'demo', false)
      if (action === 'destroy') sender.emit('destroyed')
      expect(await running).toMatchObject({ ok: false, reason: expect.stringContaining('取消') })
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow()
        expect(() => process.kill(parentPid, 0)).toThrow()
      }, { timeout: REAL_RENDER_READY_TIMEOUT_MS })
      await expect(fs.stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      // 任何失败（含等待超时）都先取消 owner 42 的在飞渲染，再等它真正 resolve——
      // executeEngineDlc 只在进程树 kill 完成后才 resolve，await 它即保证 afterEach 删 tmp 前已无 cwd 持有者。
      try { await handler({ sender }, { cancel: true, requestId: 'in-flight' }) } catch { /* 已结束 */ }
      await running.catch(() => undefined)
    }
  }, REAL_RENDER_BUDGET_MS)

  it('bounds concurrency and starts only the latest queued request for an owner', async () => {
    const host = new EngineDlcHost(2)
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const work = (name: string) => async () => {
      started.push(name)
      await new Promise<void>((resolve) => releases.set(name, resolve))
      return { ok: true as const, dataUrl: name }
    }
    const first = host.run(1, 'first', work('first'))
    const second = host.run(2, 'second', work('second'))
    const stale = host.run(1, 'stale', work('stale'))
    const newest = host.run(1, 'newest', work('newest'))
    const third = host.run(3, 'third', work('third'))
    expect(started).toEqual(['first', 'second'])
    expect(await stale).toMatchObject({ ok: false })
    releases.get('first')!()
    expect(await first).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(started).toContain('newest'))
    expect(started).not.toContain('stale')
    expect(started).not.toContain('third')
    releases.get('second')!()
    await second
    await vi.waitFor(() => expect(started).toContain('third'))
    releases.get('newest')!()
    releases.get('third')!()
    await Promise.all([newest, third])
  })
})
