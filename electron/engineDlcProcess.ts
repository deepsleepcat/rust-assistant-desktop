import path from 'node:path'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { windowsJobCommand, SYSTEM_POWERSHELL } from './engineDlcWindowsJob'
import { isAnyPlatformAbsolute } from './paths'

interface ProcessOptions {
  command: string
  argv: string[]
  cwd: string
  script: boolean
  timeoutMs: number
  platform: NodeJS.Platform
  workDir: string
  /** 非 Windows 下 DLC 入口所在根目录：spawn 边界用它做包含校验（脚本入口用宿主 execPath，不受此限） */
  execRoot?: string
  signal?: AbortSignal
}

/**
 * 追踪非 Windows 平台上 child 进程的所有子孙 PID（包括 detached/unref 的）。
 * DLC 脚本内部可以 spawn detached 子进程创建独立进程组，kill(-pid, SIGKILL)
 * 杀不到它们——必须在 child 还活着时持续采集，否则退出后子孙会被 reparent
 * 到 init，事后找不到。
 *
 * 关键时序：DLC 可能在 spawn detached 子进程后立即 exit，
 * 所以除了常规低频轮询，还要暴露 scanOnce 让调用方做启动期密集 burst 扫描。
 */
function trackDescendants(rootPid: number): { pids: Set<number>; stop: () => void; scanOnce: () => void } {
  const pids = new Set<number>([rootPid])
  const scanOnce = () => {
    try {
      const queue: number[] = [rootPid]
      const seen = new Set<number>()
      while (queue.length > 0) {
        const pid = queue.shift()!
        if (seen.has(pid)) continue
        seen.add(pid)
        let output: string
        try {
          output = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', stdio: 'pipe' })
        } catch { continue }
        for (const line of output.trim().split('\n').filter(Boolean)) {
          const childPid = Number(line)
          if (Number.isFinite(childPid) && !pids.has(childPid)) {
            pids.add(childPid)
            queue.push(childPid)
          }
        }
      }
    } catch { /* pgrep 不可用或无后代：忽略 */ }
  }
  const timer = setInterval(scanOnce, 200) // 常规轮询，200ms 足够覆盖长任务
  scanOnce()
  return {
    pids,
    scanOnce,
    stop: () => clearInterval(timer),
  }
}

/**
 * 启动期密集 burst 扫描：spawn 后立即用 5ms 间隔扫描 40 次（共 200ms），
 * 覆盖 DLC 启动后立即 spawn detached 子进程然后 exit 的时序窗口。
 */
function burstScan(tracker: { scanOnce: () => void }): void {
  let count = 0
  const iv = setInterval(() => {
    tracker.scanOnce()
    count++
    if (count >= 40) clearInterval(iv)
  }, 5)
  tracker.scanOnce()
}

async function killTree(child: ChildProcess, platform: NodeJS.Platform, trackedPids?: Set<number>): Promise<void> {
  if (!child.pid) return
  if (platform === 'win32') {
    // Windows 启动器把子进程树挂在 KILL_ON_JOB_CLOSE 的 Job 里（见 engineDlcWindowsJob）：
    // 杀掉启动器即关闭 job 句柄，由内核终止整棵树，无需外呼 taskkill。
    child.kill('SIGKILL')
  } else {
    // 1. 杀 spawn 时所属进程组（非 detached 子孙都在这里）
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 进程组可能已空 */ }
    // 2. 杀持续追踪到的所有子孙（含 detached/unref 创建新进程组的）
    if (trackedPids) {
      for (const pid of trackedPids) {
        if (pid === child.pid) continue // 进程组 kill 已覆盖
        try { process.kill(pid, 'SIGKILL') } catch { /* 已退出或无权限：忽略 */ }
      }
    }
    // 3. 兜底：直接 kill child 本身
    try { child.kill('SIGKILL') } catch { /* 已退出：忽略 */ }
  }
}

/** A slot remains occupied until process termination, not just cancellation notification. */
export async function executeEngineDlc(options: ProcessOptions): Promise<{ code: number | null; timedOut: boolean; cancelled: boolean; stderr: string }> {
  if (options.signal?.aborted) return { code: null, timedOut: false, cancelled: true, stderr: '' }
  let stderr = ''
  let stderrBytes = 0
  let timedOut = false
  let cancelled = false
  const launch = options.platform === 'win32'
    ? await windowsJobCommand(options.workDir, options.command, options.argv, options.cwd)
    : { command: options.command, argv: options.argv }
  if (options.signal?.aborted) return { code: null, timedOut: false, cancelled: true, stderr: '' }
  // spawn 边界显式白名单：系统 PowerShell（固定 SystemRoot 布局）、宿主自身 execPath（脚本入口）、
  // 或 execRoot 内的 DLC 入口（path.relative 包含校验）。其余一律拒绝启动。
  const rejected: { code: null; timedOut: false; cancelled: false; stderr: string } = {
    code: null, timedOut: false, cancelled: false, stderr: '引擎渲染程序不在允许清单内',
  }
  if (options.platform === 'win32') {
    if (!SYSTEM_POWERSHELL.test(launch.command)) return rejected
  } else if (launch.command !== process.execPath) {
    const rel = options.execRoot ? path.relative(options.execRoot, launch.command) : ''
    if (rel === '' || rel.startsWith('..') || isAnyPlatformAbsolute(rel)) return rejected
  }
  const child = spawn(launch.command, launch.argv, {
    cwd: options.cwd, shell: false, windowsHide: true,
    detached: options.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
    ...(options.script ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
  })
  // 非 Windows 平台启动子孙进程追踪，用于清理 DLC 内部 spawn 的 detached 子进程
  const tracker = options.platform !== 'win32' && child.pid
    ? trackDescendants(child.pid)
    : undefined
  if (tracker) burstScan(tracker) // spawn 后立即做密集 burst 扫描，覆盖 DLC 启动后立即 spawn detached 的时序窗口
  let killing: Promise<void> | undefined
  const stop = () => {
    tracker?.scanOnce() // 紧急扫最后一次，把尚未 reparent 的子孙抓住
    killing ??= killTree(child, options.platform, tracker?.pids)
  }
  const abort = () => { cancelled = true; stop() }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.stderr?.on('data', (chunk: Buffer) => {
        const retained = chunk.subarray(0, Math.max(0, 8192 - stderrBytes))
        stderrBytes += retained.length
        stderr += retained.toString('utf8')
      })
      child.once('error', (error) => { stderr = error.message.slice(0, 8192); resolve(null) })
      child.once('close', (exitCode) => resolve(exitCode))
    })
    if (options.platform !== 'win32') stop() // also clear the process group on ordinary exit
    await killing
    return { code, timedOut, cancelled, stderr }
  } finally {
    clearTimeout(timer)
    tracker?.stop()
    options.signal?.removeEventListener('abort', abort)
  }
}
