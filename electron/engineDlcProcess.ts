import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { windowsJobCommand, SYSTEM_POWERSHELL } from './engineDlcWindowsJob'

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

async function killTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (!child.pid) return
  if (platform === 'win32') {
    // Windows 启动器把子进程树挂在 KILL_ON_JOB_CLOSE 的 Job 里（见 engineDlcWindowsJob）：
    // 杀掉启动器即关闭 job 句柄，由内核终止整棵树，无需外呼 taskkill。
    child.kill('SIGKILL')
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
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
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return rejected
  }
  const child = spawn(launch.command, launch.argv, {
    cwd: options.cwd, shell: false, windowsHide: true,
    detached: options.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
    ...(options.script ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
  })
  let killing: Promise<void> | undefined
  const stop = () => { killing ??= killTree(child, options.platform) }
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
    options.signal?.removeEventListener('abort', abort)
  }
}
