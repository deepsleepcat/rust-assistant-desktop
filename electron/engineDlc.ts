/**
 * 引擎渲染 DLC 宿主（M42）——扫描指定目录、校验清单、以子进程方式调用外部渲染程序。
 *
 * 背景：本项目是 GPL-3.0 分发，**不内置也不转发**《铁锈战争》引擎代码。
 * 本模块只提供「插座」：用户把自己准备的渲染 DLC 放进指定目录
 * （<userData>/engine-dlc/），主进程负责发现、校验并按固定协议调用它，
 * 拿回一张位图交给预览界面。引擎从哪来、怎么用，由 DLC 自己决定。
 *
 * 安全边界：DLC 是**用户自己安装的可执行程序**，以用户权限运行，本身不是沙箱对象
 * （它能读写的东西等同于用户在终端里能读写的东西）。因此这里要守住的不是「限制它」，
 * 而是四件具体的事：
 * 1) 入口必须落在该 DLC 自己的目录内——词法 + 真实路径双重校验，防链接/junction 逃逸，
 *    否则「扫描这个目录」就等于「允许执行目录外的任意程序」；
 * 2) 渲染层永远不能指定「运行哪个可执行文件」——只能由主进程按已启用的信任锚挑选，
 *    渲染层提供的一个字段都不参与可执行路径的构造；
 * 3) 一律 argv 数组 + shell:false，不经过任何 shell，参数里带空格/引号也不会被解释；
 * 4) 超时强杀 + 输入/输出体积上限，避免外部程序把界面主进程拖死或撑爆内存。
 *
 * 「允不允许跑」由 engineDlcTrust 的锚值决定（主进程独占存储键，渲染层伪造不了）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { assertNoLinkEscape, isPathInside, normalizePath } from './paths'

/** 指定目录名（位于 userData 下，由主进程拼装；渲染层无权指定） */
export const ENGINE_DLC_DIRNAME = 'engine-dlc'

/** 每个 DLC 目录内的清单文件名 */
export const ENGINE_DLC_MANIFEST_NAME = 'dlc.json'

/** 协议版本：DLC 与宿主之间的请求/响应格式版本 */
export const ENGINE_DLC_PROTOCOL_VERSION = 1 as const

/** 体积与时限上限（集中一处，便于审查与调参） */
export const ENGINE_DLC_LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxArgs: 16,
  maxArgLength: 256,
  minTimeoutMs: 1000,
  maxTimeoutMs: 120_000,
  defaultTimeoutMs: 30_000,
  maxOutputBytes: 16 * 1024 * 1024,
  maxUnitContentBytes: 2 * 1024 * 1024,
  maxStderrBytes: 8 * 1024,
})

/**
 * 允许的入口扩展名。
 * - `.exe`：Windows 原生程序（推荐，直接 CreateProcess，不经 shell）
 * - `.js/.mjs/.cjs`：Node 脚本，用宿主自带的 Electron 二进制以 ELECTRON_RUN_AS_NODE 方式运行
 *   （给不想编译的用户一条路；仍是独立子进程，不是在主进程里 eval）
 * 刻意不收 `.bat/.cmd`：那类文件在 Windows 上必须经 cmd.exe 解释，等于把 shell 放回来。
 */
const ENTRY_EXTENSIONS = new Set(['.exe', '.js', '.mjs', '.cjs'])

/** DLC 目录名/清单 id 允许的字符集（与插件 id 同款约束，避免路径与显示歧义） */
const DLC_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/

/** 清单允许出现的键（封闭集合：多一个键就拒绝，逼作者显式升级协议） */
const MANIFEST_KEYS = new Set(['dlcVersion', 'id', 'name', 'version', 'description', 'entry', 'args', 'timeoutMs'])

export interface EngineDlcManifest {
  id: string
  name: string
  version: string
  description: string
  /** DLC 目录内的相对路径（已校验：不含 `..`、不是绝对路径、落在本目录内、确实是文件） */
  entry: string
  args: string[]
  timeoutMs: number
}

/** 已解析的 DLC（含目录与入口绝对路径；只在主进程内部流转，不出 IPC） */
export interface ResolvedEngineDlc {
  id: string
  name: string
  version: string
  description: string
  dir: string
  entryPath: string
  args: string[]
  timeoutMs: number
}

/** 一次目录扫描的单条结果：要么解析成功，要么带上中文原因 */
export interface EngineDlcScanItem {
  /** 目录名（清单合法时与 id 一致） */
  dirName: string
  /** 清单与入口都合法时的解析结果 */
  dlc: ResolvedEngineDlc | null
  /** 不合法时的原因（此时 dlc 为 null） */
  problem?: string
}

/** 给界面看的列表项（enabled/runnable 由授权判定合并而来） */
export interface EngineDlcListEntry {
  id: string
  name: string
  version: string
  description: string
  /** 用户是否已授权运行（授权记录存在且入口指纹仍匹配） */
  enabled: boolean
  /** 是否可直接用于渲染（清单合法 + 入口存在 + 已授权） */
  runnable: boolean
  /** 不可用原因（仅当 runnable=false） */
  problem?: string
}

export type ManifestParseResult = { ok: true; manifest: EngineDlcManifest } | { ok: false; problem: string }

/** 指定目录的绝对路径（userData 由调用方提供，渲染层无法影响） */
export function engineDlcDir(userDataDir: string): string {
  return path.join(userDataDir, ENGINE_DLC_DIRNAME)
}

// eslint-disable-next-line no-control-regex -- 控制字符在清单里不可见，必须拒绝
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/

function isSafeText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !CONTROL_CHARS_RE.test(value)
}

/** 清单 JSON 的解析与校验（纯函数；dirName 用于强制 id 与目录名一致，避免别名撞车） */
export function parseEngineDlcManifest(raw: unknown, dirName: string): ManifestParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: '清单必须是 JSON 对象' }
  const value = raw as Record<string, unknown>

  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) return { ok: false, problem: `清单含未知字段：${key}` }
  }
  if (value.dlcVersion !== ENGINE_DLC_PROTOCOL_VERSION) {
    return { ok: false, problem: `dlcVersion 必须是 ${ENGINE_DLC_PROTOCOL_VERSION}` }
  }

  const id = value.id
  if (!isSafeText(id, 1, 64) || !DLC_ID_RE.test(id)) return { ok: false, problem: 'id 必须是 1-64 位字母数字标识' }
  // id 必须等于目录名：否则同一份程序能用两个名字出现，授权指纹与启用列表会错位
  if (id !== dirName) return { ok: false, problem: `id 必须与目录名一致（目录名：${dirName}）` }

  const name = value.name
  if (!isSafeText(name, 1, 128)) return { ok: false, problem: 'name 必须是 1-128 字符' }

  const version = value.version
  if (!isSafeText(version, 1, 64)) return { ok: false, problem: 'version 必须是 1-64 字符' }

  const description = value.description ?? ''
  if (description !== '' && !isSafeText(description, 0, 512)) return { ok: false, problem: 'description 最长 512 字符' }

  const entry = value.entry
  if (!isSafeText(entry, 1, 240)) return { ok: false, problem: 'entry 必须是 1-240 字符的相对路径' }
  if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) return { ok: false, problem: 'entry 必须是相对路径' }
  if (entry.split(/[\\/]/).some((seg) => seg === '..')) return { ok: false, problem: 'entry 不允许包含 ..' }
  if (path.extname(entry).toLowerCase() === '.bat' || path.extname(entry).toLowerCase() === '.cmd') {
    return { ok: false, problem: 'entry 不支持 .bat/.cmd（需经 shell 解释）；请用 .exe 或 .js' }
  }
  if (!ENTRY_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
    return { ok: false, problem: `entry 扩展名必须是 ${[...ENTRY_EXTENSIONS].join(' / ')} 之一` }
  }

  const rawArgs = value.args ?? []
  if (!Array.isArray(rawArgs)) return { ok: false, problem: 'args 必须是字符串数组' }
  if (rawArgs.length > ENGINE_DLC_LIMITS.maxArgs) return { ok: false, problem: `args 最多 ${ENGINE_DLC_LIMITS.maxArgs} 项` }
  const args: string[] = []
  for (const item of rawArgs) {
    if (!isSafeText(item, 1, ENGINE_DLC_LIMITS.maxArgLength)) {
      return { ok: false, problem: `args 每项必须是 1-${ENGINE_DLC_LIMITS.maxArgLength} 字符` }
    }
    args.push(item)
  }

  const rawTimeout = value.timeoutMs ?? ENGINE_DLC_LIMITS.defaultTimeoutMs
  if (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout)) return { ok: false, problem: 'timeoutMs 必须是整数' }
  if (rawTimeout < ENGINE_DLC_LIMITS.minTimeoutMs || rawTimeout > ENGINE_DLC_LIMITS.maxTimeoutMs) {
    return { ok: false, problem: `timeoutMs 必须在 ${ENGINE_DLC_LIMITS.minTimeoutMs}-${ENGINE_DLC_LIMITS.maxTimeoutMs} 之间` }
  }

  return { ok: true, manifest: { id, name, version, description, entry, args, timeoutMs: rawTimeout } }
}

/** 读取一个 DLC 目录：清单 + 入口落盘校验（不合格返回中文原因，不抛错） */
export async function readEngineDlcDir(dir: string, dirName: string): Promise<{ ok: true; dlc: ResolvedEngineDlc } | { ok: false; problem: string }> {
  const manifestPath = path.join(dir, ENGINE_DLC_MANIFEST_NAME)
  let text: string
  try {
    const st = await fs.stat(manifestPath)
    if (!st.isFile()) return { ok: false, problem: `缺少 ${ENGINE_DLC_MANIFEST_NAME}` }
    if (st.size > ENGINE_DLC_LIMITS.maxManifestBytes) return { ok: false, problem: '清单文件过大' }
    text = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return { ok: false, problem: `缺少 ${ENGINE_DLC_MANIFEST_NAME}` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: `${ENGINE_DLC_MANIFEST_NAME} 不是合法 JSON` }
  }

  const parsed = parseEngineDlcManifest(raw, dirName)
  if (!parsed.ok) return parsed

  // 入口落盘校验：词法在目录内 → 确实是文件 → 真实路径仍在目录内（防链接逃逸）
  const entryPath = path.resolve(dir, parsed.manifest.entry)
  if (!isPathInside(dir, entryPath)) return { ok: false, problem: 'entry 超出 DLC 目录范围' }
  try {
    const st = await fs.stat(entryPath)
    if (!st.isFile()) return { ok: false, problem: `entry 不是文件：${parsed.manifest.entry}` }
  } catch {
    return { ok: false, problem: `entry 不存在：${parsed.manifest.entry}` }
  }
  try {
    await assertNoLinkEscape(dir, entryPath)
  } catch {
    return { ok: false, problem: 'entry 是指向 DLC 目录外的链接，已拒绝' }
  }

  return {
    ok: true,
    dlc: {
      id: parsed.manifest.id,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      description: parsed.manifest.description,
      dir: normalizePath(dir),
      entryPath: normalizePath(entryPath),
      args: parsed.manifest.args,
      timeoutMs: parsed.manifest.timeoutMs,
    },
  }
}

/** 扫描指定目录下的全部 DLC（目录不存在返回空表；不做授权判定——那是信任锚的事） */
export async function scanEngineDlcDir(root: string): Promise<{ dir: string; items: EngineDlcScanItem[] }> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { dir: normalizePath(root), items: [] }
  }

  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const items: EngineDlcScanItem[] = []
  for (const name of names) {
    const read = await readEngineDlcDir(path.join(root, name), name)
    // 不合规的目录仍然列出，让用户看到「放错了」而不是「什么都没发生」
    items.push(read.ok ? { dirName: name, dlc: read.dlc } : { dirName: name, dlc: null, problem: read.problem })
  }
  return { dir: normalizePath(root), items }
}

/**
 * 把扫描结果与授权判定合并成界面列表（纯函数，便于单测）。
 * allowed 为「该 DLC 当前是否被授权运行」，由调用方（信任锚）异步算出。
 */
export function toEngineDlcList(
  items: ReadonlyArray<EngineDlcScanItem>,
  allowed: ReadonlySet<string>,
): EngineDlcListEntry[] {
  return items.map((item) => {
    if (!item.dlc) {
      return {
        id: item.dirName,
        name: item.dirName,
        version: '',
        description: '',
        enabled: false,
        runnable: false,
        problem: item.problem ?? '清单不合法',
      }
    }
    const { id, name, version, description } = item.dlc
    const enabled = allowed.has(id)
    return {
      id,
      name,
      version,
      description,
      enabled,
      runnable: enabled,
      ...(enabled ? {} : { problem: '尚未启用（需在设置里授权运行）' }),
    }
  })
}

/** 渲染请求（写成 request.json 交给 DLC；字段只含用户数据，不含任何可执行路径） */
export interface EngineDlcRenderRequest {
  unitFile: string
  unitContent: string
  projectRoot: string
  gamePath: string
  frame: number
  direction: number
  animationState: string
  showWreck: boolean
  width: number
  height: number
}

/** 渲染结果：判别联合，成功必有 dataUrl、失败必有 reason（调用方无需再防 undefined） */
export type EngineDlcRenderResult = { ok: true; dataUrl: string } | { ok: false; reason: string }

/** 调用可执行文件时的依赖（测试注入用；生产走真实值） */
export interface EngineDlcRunDeps {
  execPath?: string
  platform?: NodeJS.Platform
  tmpRoot?: string
}

/** PNG 文件头（8 字节）：输出必须是真 PNG，拒绝任意字节流当图片 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(buffer: Buffer): boolean {
  return buffer.length > PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/** 首尾去空白 + 截断：stderr 只用来给用户看线索，不能无限塞进对话框 */
function trimDetail(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

/** 超时杀进程：Windows 下只杀直接子进程会留下 JVM 之类的孙进程，用 taskkill /T 连带整棵树 */
function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid
  if (!pid) return
  if (platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined)
    return
  }
  child.kill('SIGKILL')
}

/**
 * 执行一次引擎渲染。
 *
 * 协议（写进文档 11）：宿主创建临时工作目录并写入 request.json，然后执行
 *   <entry> [清单 args...] --request <request.json 绝对路径> --output <preview.png 绝对路径>
 * DLC 读 request.json、把 PNG 写到 --output 指定位置、以退出码 0 表示成功。
 * 约定用文件而不是 stdout：二进制经管道在 Windows 上会被按文本处理，换行会损坏图片。
 */
export async function runEngineDlcRender(
  dlc: ResolvedEngineDlc,
  request: EngineDlcRenderRequest,
  deps: EngineDlcRunDeps = {},
): Promise<EngineDlcRenderResult> {
  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const tmpRoot = deps.tmpRoot ?? os.tmpdir()

  const contentBytes = Buffer.byteLength(request.unitContent, 'utf8')
  if (contentBytes > ENGINE_DLC_LIMITS.maxUnitContentBytes) {
    return { ok: false, reason: `单位文件过大（${Math.round(contentBytes / 1024)} KB），已拒绝引擎渲染` }
  }

  let workDir: string
  try {
    workDir = await fs.mkdtemp(path.join(tmpRoot, 'ra-dlc-'))
  } catch (err) {
    return { ok: false, reason: `无法创建临时目录：${err instanceof Error ? err.message : String(err)}` }
  }

  const requestPath = path.join(workDir, 'request.json')
  const outputPath = path.join(workDir, 'preview.png')

  try {
    const payload = {
      protocolVersion: ENGINE_DLC_PROTOCOL_VERSION,
      unitFile: request.unitFile,
      unitContent: request.unitContent,
      projectRoot: request.projectRoot,
      gamePath: request.gamePath,
      view: {
        frame: request.frame,
        direction: request.direction,
        animationState: request.animationState,
        showWreck: request.showWreck,
      },
      size: { width: request.width, height: request.height },
      outputPath,
    }
    await fs.writeFile(requestPath, JSON.stringify(payload), 'utf8')

    // 脚本入口用宿主自带的 Electron 二进制以「纯 Node」模式运行：
    // 仍是独立子进程，不能碰主进程内存，只是省掉用户装 Node 的麻烦。
    const isScript = ['.js', '.mjs', '.cjs'].includes(path.extname(dlc.entryPath).toLowerCase())
    const command = isScript ? execPath : dlc.entryPath
    const argv = [
      ...(isScript ? [dlc.entryPath] : []),
      ...dlc.args,
      '--request',
      requestPath,
      '--output',
      outputPath,
    ]

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stderr: string }>(
      (resolve) => {
        let stderr = ''
        let settled = false
        const finish = (value: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ...value, stderr })
        }

        let child: ChildProcess
        try {
          child = spawn(command, argv, {
            cwd: dlc.dir,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            ...(isScript ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
          })
        } catch (err) {
          resolve({ code: null, signal: null, timedOut: false, stderr: err instanceof Error ? err.message : String(err) })
          return
        }

        const timer = setTimeout(() => {
          killTree(child, platform)
          finish({ code: null, signal: null, timedOut: true })
        }, dlc.timeoutMs)

        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < ENGINE_DLC_LIMITS.maxStderrBytes) stderr += chunk.toString('utf8')
        })
        child.on('error', (err) => {
          stderr += err.message
          finish({ code: null, signal: null, timedOut: false })
        })
        child.on('close', (code, signal) => finish({ code, signal, timedOut: false }))
      },
    )

    if (outcome.timedOut) return { ok: false, reason: `引擎渲染超时（${Math.round(dlc.timeoutMs / 1000)} 秒），已终止` }
    if (outcome.code !== 0) {
      const detail = trimDetail(outcome.stderr)
      return {
        ok: false,
        reason: `引擎渲染程序退出码 ${outcome.code ?? 'null'}${detail ? `：${detail}` : ''}`,
      }
    }

    let buffer: Buffer
    try {
      const st = await fs.stat(outputPath)
      if (!st.isFile()) return { ok: false, reason: '引擎渲染未产出图片文件' }
      if (st.size === 0) return { ok: false, reason: '引擎渲染产出的图片为空' }
      if (st.size > ENGINE_DLC_LIMITS.maxOutputBytes) {
        return { ok: false, reason: `引擎渲染结果过大（${Math.round(st.size / 1024 / 1024)} MB），已拒绝` }
      }
      buffer = await fs.readFile(outputPath)
    } catch {
      return { ok: false, reason: '引擎渲染未产出图片文件（DLC 需把 PNG 写到 --output 指定路径）' }
    }

    if (!isPng(buffer)) return { ok: false, reason: '引擎渲染的输出不是 PNG 图片' }

    return { ok: true, dataUrl: `data:image/png;base64,${buffer.toString('base64')}` }
  } catch (err) {
    return { ok: false, reason: `引擎渲染失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
