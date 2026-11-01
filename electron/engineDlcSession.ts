/**
 * 引擎 DLC 常驻渲染会话（0.2.2+）：炮塔拖动实时预览的主进程会话管理器。
 *
 * 每个编辑器窗口（sender）最多一个会话：主进程 spawn DLC 目录里的 session-host.cjs
 * （ELECTRON_RUN_AS_NODE 纯 Node 子进程），经 stdio 交换「长度前缀 JSON 信封」消息；
 * 像素以 base64 走 JSON，按宿主声明的 byteLength 精确取负载（不按换行扫描）。
 *
 * 生命周期与安全边界：
 * - 打开前必须再校验 DLC 仍被授权（信任锚 + 指纹链）；授权撤销 → 全部会话立即杀树；
 * - 每个请求带 60s 超时；宿主进程自身有 120s 空闲自愈；sender 销毁 → 杀会话进程树；
 * - 帧尺寸在主进程再验一次（≤4096、bytes === width*height*4），超界杀进程拒绝返回；
 * - Windows 经 KILL_ON_JOB_CLOSE 启动器包一层，保证 Java 孙进程随宿主一起终止。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { windowsJobCommand } from './engineDlcWindowsJob'

/** 会话帧中允许的最大边长与字节量（与单帧 PNG 通道一致的上限口径） */
const MAX_FRAME_SIDE = 4096
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const HEADER_PREFIX = 'SESSION_HOST '

/** 会话打开/更新请求（渲染层传入；路径与尺寸都由 IPC 层先行校验） */
export interface DlcSessionRequest {
  unitFile: string
  unitContent?: string
  projectRoot: string
  view?: { direction?: number; animationState?: string; showWreck?: boolean; team?: number; position?: { x: number; y: number } }
  size?: { width: number; height: number }
}

/** 更新请求：视图增量 + 可选炮塔位置覆盖（拖动编辑用；DLC 内部解 INI 逆映射） */
export interface DlcSessionUpdateRequest {
  view?: { direction?: number; animationState?: string; showWreck?: boolean; team?: number; position?: { x: number; y: number } }
  size?: { width: number; height: number }
  turretOverrides?: Array<{ index: number; worldX: number; worldY: number }>
  turretOverridesReset?: boolean
}

/** 校验后的会话帧（pixels 是可直接 structured-clone 的 Uint8Array） */
export interface DlcSessionFrame {
  ok: true
  status: 'rendered' | 'stale' | 'superseded'
  generation: number
  latestGeneration?: number
  size: { width: number; height: number }
  stride?: number
  pixelFormat?: string
  rowOrder?: string
  premultipliedAlpha?: boolean
  coordinateMapping?: { originX: number; originY: number; pixelsPerUnit: number; yDirection: number }
  worldBounds?: { x: number; y: number; width: number; height: number }
  turrets?: Array<{ index: number; iniX: number; iniY: number; worldX: number; worldY: number; imageX: number; imageY: number; directionDegrees: number }>
  animation?: unknown
  timing?: Record<string, number>
  pixels: Uint8Array
  bytes: number
  sha256?: string
}

export type DlcSessionResult = { ok: true; frame: DlcSessionFrame } | { ok: false; reason: string }

interface HostRecord {
  dlcId: string
  child: ChildProcess
  workDir: string
  buffer: Buffer
  expected: number
  waiters: Map<string, (message: Record<string, unknown>) => void>
  nextId: number
  idleTimer: NodeJS.Timeout | null
  closed: boolean
  stderr: string
  stderrBytes: number
  exitPromise: Promise<void>
  kill: () => void
}

const IDLE_TIMEOUT_MS = 120000
const REQUEST_TIMEOUT_MS = 60000
const CLOSE_GRACE_MS = 5000

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

export class EngineDlcSessionManager {
  private readonly hosts = new Map<number, HostRecord>()

  /** 该 owner 是否有存活会话 */
  has(owner: number): boolean {
    const host = this.hosts.get(owner)
    return !!host && !host.closed
  }

  /** 打开（若已有会话则先关旧开新；request 已由 IPC 层校验） */
  async open(owner: number, nodeRuntime: string, sessionHostPath: string, dlcDir: string, dlcId: string, request: DlcSessionRequest): Promise<DlcSessionResult> {
    await this.close(owner)
    let workDir: string
    try {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-dlc-session-'))
    } catch {
      return fail('无法创建会话临时目录')
    }
    let child: ChildProcess
    let kill: () => void
    try {
      // Windows 用 KILL_ON_JOB_CLOSE 启动器包住，Java 孙进程随宿主一起终止；
      // 其他平台用进程组 + SIGKILL。
      let command = nodeRuntime
      let argv = [sessionHostPath]
      let detached = false
      if (process.platform === 'win32') {
        const wrapped = await windowsJobCommand(workDir, nodeRuntime, argv, dlcDir)
        command = wrapped.command
        argv = wrapped.argv
      } else {
        detached = true
      }
      child = spawn(command, argv, {
        cwd: dlcDir, shell: false, windowsHide: true, detached,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      kill = () => {
        if (!child.pid) return
        if (process.platform === 'win32') child.kill('SIGKILL')
        else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
      }
    } catch (error) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      return fail(`无法启动引擎会话宿主：${error instanceof Error ? error.message : String(error)}`)
    }

    const host: HostRecord = {
      dlcId,
      child,
      workDir,
      buffer: Buffer.alloc(0),
      expected: -1,
      waiters: new Map(),
      nextId: 0,
      idleTimer: null,
      closed: false,
      stderr: '',
      stderrBytes: 0,
      exitPromise: new Promise((resolve) => child.once('close', () => resolve())),
      kill,
    }
    this.hosts.set(owner, host)
    this.touchIdle(owner)

    child.stdout?.on('data', (chunk: Buffer) => {
      host.buffer = host.buffer.length === 0 ? chunk : Buffer.concat([host.buffer, chunk])
      if (host.buffer.length > 64 * 1024 * 1024) { this.killOwner(owner, '宿主输出失控'); return }
      this.drain(owner)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const retained = chunk.subarray(0, Math.max(0, 8192 - host.stderrBytes))
      host.stderrBytes += retained.length
      host.stderr = (host.stderr + retained.toString('utf8')).slice(-8192)
    })
    child.once('close', () => {
      // 进程退出：所有等待者立即失败（正常 close 走 request('close')，不会留下等待者）
      host.closed = true
      if (host.idleTimer) clearTimeout(host.idleTimer)
      for (const [id, waiter] of host.waiters) {
        host.waiters.delete(id)
        waiter({ type: 'error', message: '引擎会话宿主已退出' })
      }
      void fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      if (this.hosts.get(owner) === host) this.hosts.delete(owner)
    })

    const opened = await this.request(owner, {
      type: 'open',
      request: {
        unitFile: request.unitFile,
        unitContent: request.unitContent,
        projectRoot: request.projectRoot,
        view: request.view,
        size: request.size,
      },
    })
    if (!opened.ok) {
      await this.close(owner)
      return opened
    }
    return opened
  }

  /** 增量更新（view/size/炮塔覆盖）。会话不存在时明确失败，不悄悄重开。 */
  async update(owner: number, request: DlcSessionUpdateRequest): Promise<DlcSessionResult> {
    const host = this.hosts.get(owner)
    if (!host || host.closed) return fail('引擎会话未打开')
    this.touchIdle(owner)
    return this.request(owner, { type: 'update', request })
  }

  /** 关闭并杀进程树（幂等） */
  async close(owner: number): Promise<void> {
    const host = this.hosts.get(owner)
    if (!host) return
    this.hosts.delete(owner)
    if (host.closed) return
    if (host.idleTimer) clearTimeout(host.idleTimer)
    host.closed = true
    const pending = new Map(host.waiters)
    host.waiters.clear()
    try {
      // 发 close 信封；宿主回 closed 后自行退出，5s 宽限后兜底杀树
      const id = `c${host.nextId++}`
      const closed = new Promise<void>((resolve) => host.waiters.set(id, () => resolve()))
      const body = Buffer.from(JSON.stringify({ type: 'close', id }), 'utf8')
      const stdin = host.child.stdin
      if (stdin && !stdin.destroyed) {
        stdin.write(`${HEADER_PREFIX}${body.length}\n`)
        stdin.write(body)
      }
      const done = closed.then(() => true).catch(() => true)
      const result = await Promise.race([
        done,
        host.exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS)),
      ])
      host.waiters.clear()
      if (!result) host.kill()
    } catch {
      host.kill()
    }
    for (const [, waiter] of pending) waiter({ type: 'error', message: '引擎会话已关闭' })
    await host.exitPromise
    await fs.rm(host.workDir, { recursive: true, force: true }).catch(() => undefined)
  }

  /** 授权撤销/全局终止：杀掉所有会话 */
  cancelAll(): void {
    for (const owner of [...this.hosts.keys()]) void this.close(owner)
  }

  private killOwner(owner: number, reason: string): void {
    const host = this.hosts.get(owner)
    if (!host || host.closed) return
    for (const [, waiter] of host.waiters) waiter({ type: 'error', message: `引擎会话已终止（${reason}）` })
    host.waiters.clear()
    host.kill()
  }

  private touchIdle(owner: number): void {
    const host = this.hosts.get(owner)
    if (!host || host.closed) return
    if (host.idleTimer) clearTimeout(host.idleTimer)
    host.idleTimer = setTimeout(() => this.killOwner(owner, '空闲超时'), IDLE_TIMEOUT_MS)
    host.idleTimer.unref?.()
  }

  /** 发送信封并等待同 id 响应（60s 超时；超时杀会话防止拖死 UI） */
  private async request(owner: number, payload: Record<string, unknown>): Promise<DlcSessionResult> {
    const host = this.hosts.get(owner)
    if (!host || host.closed) return fail('引擎会话未打开')
    const id = `r${host.nextId++}`
    const body = Buffer.from(JSON.stringify({ ...payload, id }), 'utf8')
    if (body.length > MAX_MESSAGE_BYTES) return fail('会话请求负载过大')
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        host.waiters.delete(id)
        this.killOwner(owner, `请求超时（${id}）`)
        resolve({ type: 'error', message: '引擎会话响应超时' })
      }, REQUEST_TIMEOUT_MS)
      host.waiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      const stdin = host.child.stdin
      if (host.closed || !stdin || stdin.destroyed) {
        clearTimeout(timer)
        host.waiters.delete(id)
        resolve({ type: 'error', message: '引擎会话宿主已退出' })
        return
      }
      stdin.write(`${HEADER_PREFIX}${body.length}\n`)
      stdin.write(body)
    })
    if (response.type === 'error') return fail(String(response.message ?? '引擎会话错误').slice(0, 400))
    if (response.type === 'fatal') return fail(String(response.message ?? '引擎会话致命错误').slice(0, 400))
    if (response.type === 'opened' || response.type === 'frame') {
      return this.validateFrame(response.frame)
    }
    return fail(`引擎会话返回了未知消息类型：${String(response.type)}`)
  }

  /** 信封解析（与 session-host.cjs 同款规约：头行 + 精确字节负载） */
  private drain(owner: number): void {
    const host = this.hosts.get(owner)
    if (!host) return
    for (;;) {
      if (host.expected < 0) {
        const newline = host.buffer.indexOf(0x0a)
        if (newline < 0) return
        const header = host.buffer.subarray(0, newline).toString('utf8')
        host.buffer = host.buffer.subarray(newline + 1)
        if (!header.startsWith(HEADER_PREFIX)) { this.killOwner(owner, '帧头格式错误'); return }
        const length = Number(header.slice(HEADER_PREFIX.length).trim())
        if (!Number.isInteger(length) || length <= 0 || length > MAX_MESSAGE_BYTES) { this.killOwner(owner, '帧长度无效'); return }
        host.expected = length
      }
      if (host.buffer.length < host.expected) return
      const body = host.buffer.subarray(0, host.expected)
      host.buffer = host.buffer.subarray(host.expected)
      host.expected = -1
      let message: Record<string, unknown>
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch {
        this.killOwner(owner, '帧 JSON 解析失败')
        return
      }
      const id = typeof message.id === 'string' ? message.id : ''
      const waiter = host.waiters.get(id)
      if (waiter) {
        host.waiters.delete(id)
        waiter(message)
      }
      // 无等待者的响应（如 close 后迟到的 frame）直接丢弃
    }
  }

  /** 帧再校验：尺寸/字节数越界一律拒绝并杀会话（不把可疑缓冲交给渲染层） */
  private validateFrame(raw: unknown): DlcSessionResult {
    if (!raw || typeof raw !== 'object') return fail('引擎会话帧格式无效')
    const frame = raw as Record<string, unknown>
    const size = frame.size as { width?: unknown; height?: unknown } | undefined
    const width = size && typeof size.width === 'number' ? size.width : NaN
    const height = size && typeof size.height === 'number' ? size.height : NaN
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE) {
      return fail('引擎会话帧尺寸越界')
    }
    const pixelsBase64 = frame.pixelsBase64
    if (typeof pixelsBase64 !== 'string') {
      // superseded/stale 帧没有像素：仍然回给调用方（generation 语义），pixels 置空
      if (frame.status === 'superseded' || frame.status === 'stale') {
        return { ok: true, frame: this.sanitizedFrame(frame, width, height, new Uint8Array(0)) }
      }
      return fail('引擎会话帧缺少像素数据')
    }
    let pixels: Buffer
    try {
      pixels = Buffer.from(pixelsBase64, 'base64')
    } catch {
      return fail('引擎会话像素解码失败')
    }
    const expectedBytes = width * height * 4
    if (pixels.length !== expectedBytes) {
      return fail(`引擎会话像素字节数不符：${pixels.length}，预期 ${expectedBytes}`)
    }
    return { ok: true, frame: this.sanitizedFrame(frame, width, height, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length)) }
  }

  private sanitizedFrame(frame: Record<string, unknown>, width: number, height: number, pixels: Uint8Array): DlcSessionFrame {
    const result: Record<string, unknown> = {
      ok: true,
      status: frame.status === 'superseded' || frame.status === 'stale' ? frame.status : 'rendered',
      generation: typeof frame.generation === 'number' ? frame.generation : 0,
      size: { width, height },
      pixels,
      bytes: pixels.length,
    }
    for (const key of ['latestGeneration', 'stride', 'pixelFormat', 'rowOrder', 'premultipliedAlpha', 'coordinateMapping', 'worldBounds', 'turrets', 'animation', 'timing', 'sha256'] as const) {
      if (frame[key] !== undefined && frame[key] !== null) result[key] = frame[key]
    }
    return result as unknown as DlcSessionFrame
  }
}
