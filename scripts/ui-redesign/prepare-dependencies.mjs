import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const original = 'W:/mao/tx/ohmytx项目/ohmytx'
const backend = 'W:/mao/tx/ohmytx后端/ohmytx-ui-redesign-backend'
const evidence = path.join(backend, 'docs/ui-redesign-evidence')
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const bun = 'C:/Users/mao/.bun/bin/bun.exe'
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)))
Object.assign(safeEnv, { CI: 'true', NO_COLOR: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' })

async function run(id, executable, args, cwd, out) {
  const start = Date.now()
  const logPath = path.join(out, `${id}.log`)
  const log = fs.createWriteStream(logPath, { flags: 'wx' })
  log.write(`${JSON.stringify({ executable, args, cwd, startedAt: new Date(start).toISOString() })}\n`)
  const result = await new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: safeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    let spawnError = null
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 20 * 60_000)
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.on('error', (error) => { spawnError = error.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ id, executable, args, cwd, exitCode: timedOut ? 124 : (code ?? 1), signal, timedOut, spawnError, elapsedMs: Date.now() - start, logPath })
    })
  })
  await new Promise((resolve) => log.end(`\n${JSON.stringify(result)}\n`, resolve))
  console.log(`${id}: exit=${result.exitCode}; log=${logPath}`)
  return result
}

function reuseDesktop() {
  const source = path.join(original, 'node_modules')
  const target = path.join(desktop, 'node_modules')
  if (fs.existsSync(target)) return { strategy: 'existing_dependencies_preserved', root: target }
  if (sha(path.join(desktop, 'package-lock.json')) !== sha(path.join(original, 'package-lock.json')) || !fs.existsSync(source)) return null
  // Keep the node_modules root and caches local. Only package directories are junctions.
  // This avoids writing Vite/Vitest caches through a node_modules-root junction.
  fs.mkdirSync(target)
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (item.name.startsWith('.')) {
      if (item.name === '.bin' || item.name === '.package-lock.json') fs.cpSync(path.join(source, item.name), path.join(target, item.name), { recursive: true })
      continue
    }
    if (item.name.startsWith('@')) {
      fs.mkdirSync(path.join(target, item.name))
      for (const pkg of fs.readdirSync(path.join(source, item.name))) {
        const localVendor = item.name === '@earendil-works' && ['pi-agent-core', 'pi-ai', 'pi-telemetry'].includes(pkg)
          ? path.join(desktop, 'vendor/pi/packages', { 'pi-agent-core': 'agent', 'pi-ai': 'ai', 'pi-telemetry': 'telemetry' }[pkg])
          : path.join(source, item.name, pkg)
        fs.symlinkSync(path.resolve(localVendor), path.join(target, item.name, pkg), 'junction')
      }
    } else if (item.isDirectory() || item.isSymbolicLink()) {
      fs.symlinkSync(path.resolve(source, item.name), path.join(target, item.name), 'junction')
    } else {
      fs.copyFileSync(path.join(source, item.name), path.join(target, item.name))
    }
  }
  for (const cache of ['.vite', '.vite-temp', '.cache']) fs.mkdirSync(path.join(target, cache), { recursive: true })
  return { strategy: 'package_junctions_local_caches_local_vendor', root: target, source, lockSha256: sha(path.join(desktop, 'package-lock.json')) }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('prepare-dependencies.mjs accepts no arguments')
  if (!fs.existsSync(npmCli) || !fs.existsSync(bun)) throw new Error('Verified npm CLI or Bun executable is missing')
  fs.mkdirSync(evidence, { recursive: true })
  const out = path.join(evidence, `dependencies-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(out)
  const roots = [desktop, `${backend}/community/web`, `${backend}/new-api/web`, `${desktop}/mobile`]
  const locks = roots.flatMap((root) => ['package-lock.json', 'bun.lockb'].filter((name) => fs.existsSync(path.join(root, name))).map((name) => ({ path: path.join(root, name), sha256: sha(path.join(root, name)) })))
  const desktopReuse = reuseDesktop()
  const tasks = []
  if (!desktopReuse) tasks.push(run('desktop-npm-ci', process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], desktop, out))
  for (const [id, root, isBun] of [['community-web', roots[1], false], ['gateway-web', roots[2], true], ['mobile', roots[3], false]]) {
    if (!fs.existsSync(path.join(root, 'node_modules'))) tasks.push(run(id, isBun ? bun : process.execPath, isBun ? ['install', '--frozen-lockfile'] : [npmCli, 'ci', ...(id === 'community-web' ? ['--legacy-peer-deps'] : []), '--no-audit', '--no-fund'], root, out))
  }
  const results = await Promise.all(tasks)
  const lockChanges = locks.filter((entry) => !fs.existsSync(entry.path) || sha(entry.path) !== entry.sha256)
  const result = { schemaVersion: 1, kind: 'dependency-preparation', createdAt: new Date().toISOString(), desktopReuse, locks, lockChanges, results, out, exitCode: results.find((entry) => entry.exitCode !== 0)?.exitCode ?? (lockChanges.length ? 1 : 0) }
  fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ result: path.join(out, 'result.json'), exitCode: result.exitCode, desktopReuse: desktopReuse?.strategy, installs: results.length, lockChanges: lockChanges.length }))
  process.exitCode = result.exitCode
}
main().catch((error) => { console.log(JSON.stringify({ error: error.message, exitCode: 1 })); process.exitCode = 1 })
