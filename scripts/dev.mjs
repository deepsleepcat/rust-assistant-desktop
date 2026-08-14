/**
 * 开发模式启动器：
 * 1. 启动 Vite 开发服务器（提供 React 界面，支持热更新）
 * 2. 等 Vite 就绪后启动 Electron，并把 VITE_DEV_SERVER_URL 传给主进程
 * 3. 任意一方退出时关闭另一方
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'
import path from 'node:path'

const require = createRequire(import.meta.url)
const vitePackage = require.resolve('vite/package.json')
const viteBin = path.join(path.dirname(vitePackage), 'bin', 'vite.js')
const electronBin = require.resolve('electron/cli.js')
const port = 5173
const devUrl = `http://localhost:${port}`

async function waitForServer(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        // L14：校验响应确实是本项目的 Vite 页面（端口被恶意进程占用时不加载陌生页面进 Electron）
        const text = await res.text()
        if (text.includes('<div id="root">') && (text.includes('vite') || text.includes('/src/main.tsx'))) return
        throw new Error(`端口 ${port} 已被其它服务占用（响应内容不是本项目页面），拒绝启动 Electron`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('占用')) throw err
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

/** Electron 主进程和 preload 是 TypeScript，开发启动前必须先编译最新代码。 */
async function buildElectron() {
  const tscBin = require.resolve('typescript/bin/tsc')
  await new Promise((resolve, reject) => {
    const compiler = spawn(process.execPath, [tscBin, '-p', 'tsconfig.node.json'], { stdio: 'inherit' })
    compiler.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Electron 编译失败，退出码 ${code}`)))
  })
}

waitForServer(devUrl)
  .then(() => buildElectron())
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
