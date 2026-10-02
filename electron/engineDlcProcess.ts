import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { windowsJobCommand } from './engineDlcWindowsJob'

interface ProcessOptions {
  command: string
  argv: string[]
  cwd: string
  script: boolean
  timeoutMs: number
  platform: NodeJS.Platform
  workDir: string
  signal?: AbortSignal
}

async function killTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (!child.pid) return
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      execFile(command, ['/pid', String(child.pid), '/T', '/F'], () => {
        child.kill('SIGKILL')
        resolve()
      })
    })
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
