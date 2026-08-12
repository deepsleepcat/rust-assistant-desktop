/**
 * 开发模式启动器：
 * 1. 启动 Vite 开发服务器（提供 React 界面，支持热更新）
 * 2. 等 Vite 就绪后启动 Electron，并把 VITE_DEV_SERVER_URL 传给主进程
 * 3. 任意一方退出时关闭另一方
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const viteBin = require.resolve('vite/bin/vite.js')
const electronBin = require.resolve('electron/cli.js')
const port = 5173
const devUrl = `http://localhost:${port}`

async function waitForServer(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* 服务器还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`Vite 开发服务器在 ${timeoutMs}ms 内未就绪：${url}`)
}

const vite = spawn(process.execPath, [viteBin], { stdio: 'inherit' })
vite.on('exit', (code) => {
  process.exit(code ?? 0)
})

waitForServer(devUrl)
  .then(() => {
    const electron = spawn(process.execPath, [electronBin, '.'], {
      stdio: 'inherit',
      env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
    })
    electron.on('exit', () => {
      vite.kill()
      process.exit()
    })
  })
  .catch((err) => {
    console.error(err.message)
    vite.kill()
    process.exit(1)
  })
