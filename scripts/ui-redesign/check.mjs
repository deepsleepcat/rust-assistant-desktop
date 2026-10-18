import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { verifyOperation } from './verify-operation.mjs'

let activeRunDir = null

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const backend = 'W:/mao/tx/ohmytx后端/ohmytx-ui-redesign-backend'
const community = path.join(backend, 'community')
const gateway = path.join(backend, 'new-api')
const evidence = path.join(backend, 'docs/ui-redesign-evidence')
const go = 'C:/Program Files/Go/bin/go.exe'
const baseline = { desktop: 'c18a992fdd461a080fab701812e96f0be887cbb2', backend: 'e7ce358642bc78090f2ab4e800131b40c65d1dd5' }
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')
const hashFile = (file) => hash(fs.readFileSync(file))
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const minute = 60_000
const modes = new Set(['fast', 'full', 'evidence'])
const mode = process.argv[2]
let printedBytes = 0
function summary(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (printedBytes + Buffer.byteLength(text) <= 20 * 1024) { console.log(text); printedBytes += Buffer.byteLength(text) }
}

// Do not inherit service credentials, DSNs, NODE_OPTIONS, npm hooks or user database paths.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|GOPATH|GOMODCACHE|GOCACHE|GOTOOLCHAIN|GOPROXY|GOSUMDB|GONOSUMDB|GONOPROXY|GOPRIVATE)$/i.test(key)))
Object.assign(env, { CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', CGO_ENABLED: '0', GOFLAGS: '-mod=readonly', GIN_MODE: 'test', VITE_REACT_APP_VERSION: 'local-ui-redesign', npm_config_update_notifier: 'false' })

function walk(root, prefix = '', result = [], exclude = () => false) {
  if (!fs.existsSync(root)) return result
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const file = path.join(root, entry.name)
    if (exclude(rel, entry) || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(file, rel, result, exclude)
    else if (entry.isFile()) result.push({ path: rel, sha256: hashFile(file), size: fs.statSync(file).size })
  }
  return result
}

export function fingerprint() {
  const files = []
  const excludes = (rel, entry) => entry.isDirectory() && /(^|\/)(node_modules|dist|dist-electron|target|\.git|\.vite|\.vite-temp|\.cache|coverage|__pycache__)(\/|$)/.test(rel)
  const sources = {
    desktop: { root: desktop, dirs: ['src', 'electron', 'tests', 'scripts', 'public', 'assets', '.github/workflows', 'mobile/src', 'mobile/tests', 'mobile/public', 'vendor/pi/packages'], rootFiles: ['package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.base.json', 'vite.config.ts', 'vitest.config.ts', 'eslint.config.mjs', 'index.html', 'mobile/package.json', 'mobile/package-lock.json', 'mobile/index.html', 'mobile/tsconfig.json', 'mobile/tsconfig.node.json', 'mobile/vite.config.ts', 'mobile/vitest.config.ts'] },
    backend: { root: backend, dirs: ['community/internal', 'community/cmd', 'community/web/src', 'community/web/tests', 'community/web/public', 'new-api/common', 'new-api/constant', 'new-api/controller', 'new-api/dto', 'new-api/i18n', 'new-api/middleware', 'new-api/model', 'new-api/relay', 'new-api/router', 'new-api/service', 'new-api/setting', 'new-api/types', 'new-api/web/src', 'new-api/web/tests', 'new-api/web/public'], rootFiles: ['community/go.mod', 'community/go.sum', 'community/web/package.json', 'community/web/package-lock.json', 'community/web/vite.config.js', 'community/web/postcss.config.js', 'community/web/tailwind.config.js', 'community/web/index.html', 'new-api/go.mod', 'new-api/go.sum', 'new-api/main.go', 'new-api/web/package.json', 'new-api/web/bun.lockb', 'new-api/web/vite.config.js', 'new-api/web/postcss.config.js', 'new-api/web/tailwind.config.js', 'new-api/web/index.html'] },
  }
  for (const [repo, config] of Object.entries(sources)) {
    for (const dir of config.dirs) {
      for (const item of walk(path.join(config.root, dir), '', [], excludes)) {
        if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|json|go|mod|sum|py|yml|yaml|css|html|txt|svg|png|jpe?g|gif|ico|avif|webp|bmp|woff2?|ttf|otf|lockb)$/.test(item.path)) continue
        files.push({ repo, path: `${dir}/${item.path}`, sha256: item.sha256 })
      }
    }
    for (const rel of config.rootFiles) if (fs.existsSync(path.join(config.root, rel))) files.push({ repo, path: rel, sha256: hashFile(path.join(config.root, rel)) })
  }
  files.sort((a, b) => `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`))
  return { schemaVersion: 1, baseline, digest: hash(JSON.stringify(files)), files }
}

function command(id, executable, args, cwd, timeoutMs) { return { id, executable, args, cwd, timeoutMs } }
function nodeCommand(id, root, relative, args, timeoutMs = 30 * minute) { return command(id, process.execPath, [path.join(root, relative), ...args], root, timeoutMs) }
function goCommand(id, root, args, timeoutMs = 60 * minute) { return command(id, go, ['-C', root, ...args], root, timeoutMs) }
function allNodeTests(root) {
  const tests = walk(path.join(root, 'tests')).filter((entry) => /\.test\.(js|cjs|mjs)$/.test(entry.path)).map((entry) => path.join(root, 'tests', entry.path))
  if (!tests.length) throw new Error(`Required Node tests are missing: ${root}`)
  return tests
}

async function run(spec, runDir) {
  const logPath = path.join(runDir, `${spec.id}.log`)
  const stream = fs.createWriteStream(logPath, { flags: 'wx' })
  stream.write(`${JSON.stringify({ ...spec, startedAt: new Date().toISOString() })}\n`)
  const started = Date.now()
  const result = await new Promise((resolve) => {
    let timedOut = false
    let spawnError = null
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, spec.timeoutMs)
    child.stdout.pipe(stream, { end: false })
    child.stderr.pipe(stream, { end: false })
    child.on('error', (error) => { spawnError = error.message })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ ...spec, exitCode: timedOut ? 124 : (code ?? 1), signal, timedOut, spawnError, elapsedMs: Date.now() - started, logPath }) })
  })
  await new Promise((resolve) => stream.end(`\n${JSON.stringify(result)}\n`, resolve))
  result.logSha256 = hashFile(logPath)
  summary(`${result.id}: exit=${result.exitCode}; ${Math.round(result.elapsedMs / 1000)}s; ${logPath}`)
  return result
}

async function internal(id, runDir, action) {
  const logPath = path.join(runDir, `${id}.log`)
  let details
  let exitCode = 0
  try { details = await action() } catch (error) { exitCode = 1; details = { error: error.message, stack: error.stack } }
  json(logPath, details)
  summary(`${id}: exit=${exitCode}; ${logPath}`)
  return { id, exitCode, internal: true, details, logPath, logSha256: hashFile(logPath) }
}

function verifyHtml(root, prefix) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]).filter((value) => !/^(https?:|data:|#)/i.test(value))
  const scripts = refs.filter((value) => /\.js(?:\?|$)/.test(value))
  if (!scripts.length) throw new Error(`No production JS assets in ${root}/index.html`)
  for (const value of refs) {
    const rel = value.split(/[?#]/)[0].replace(prefix, '').replace(/^\.?\//, '')
    const full = path.resolve(root, rel)
    if (!full.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(full)) throw new Error(`Missing/escaping HTML asset: ${value}`)
  }
  return { indexSha256: hashFile(path.join(root, 'index.html')), refs }
}

function syncCommunityEmbed() {
  const src = path.join(community, 'web/dist')
  const dest = path.join(community, 'internal/webapp/dist')
  if (!fs.readFileSync(path.join(community, 'internal/webapp/webapp.go'), 'utf8').includes('//go:embed all:dist')) throw new Error('Community Go embed declaration changed; review the fixed check')
  const html = verifyHtml(src, /^\/community\//)
  // Exact mirror only generated assets; no removal of baseline source files.
  fs.mkdirSync(dest, { recursive: true })
  const files = walk(src)
  for (const entry of files) { const out = path.join(dest, entry.path); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(src, entry.path), out) }
  const known = new Set(files.map((entry) => entry.path))
  for (const entry of walk(dest)) if (!known.has(entry.path)) fs.unlinkSync(path.join(dest, entry.path))
  const embedded = walk(dest)
  if (JSON.stringify(files) !== JSON.stringify(embedded)) throw new Error('Community web output differs from Go embed output')
  verifyHtml(dest, /^\/community\//)
  return { src, dest, html, digest: hash(JSON.stringify(files)), files }
}
function gatewayEmbed() {
  if (!fs.readFileSync(path.join(gateway, 'main.go'), 'utf8').includes('//go:embed all:web/dist')) throw new Error('Gateway Go embed declaration changed; review the fixed check')
  const dir = path.join(gateway, 'web/dist')
  return { dir, html: verifyHtml(dir, /^\//), files: walk(dir) }
}

async function main() {
  if (process.argv.length !== 3 || !modes.has(mode)) { console.log(JSON.stringify({ error: 'Exactly one fixed argument required: fast | full | evidence', exitCode: 64 })); process.exitCode = 64; return }
  fs.mkdirSync(path.join(evidence, 'checks'), { recursive: true })
  const runDir = path.join(evidence, 'checks', `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-${crypto.randomBytes(3).toString('hex')}`)
  fs.mkdirSync(runDir)
  activeRunDir = runDir
  const tempRoot = fs.mkdtempSync(path.join(evidence, 'test-temp-'))
  Object.assign(env, { GOTMPDIR: tempRoot })
  json(path.join(runDir, 'test-environment.json'), { tempRoot })
  const startedAt = new Date().toISOString()
  const before = fingerprint()
  json(path.join(runDir, 'source-start.json'), before)
  const results = []
  const execute = async (spec) => { const result = await run(spec, runDir); results.push(result); return result.exitCode === 0 }
  const assert = async (id, fn) => { const result = await internal(id, runDir, fn); results.push(result); return result.exitCode === 0 }
  const required = []
  function add(spec) { required.push(spec.id); return spec }
  if (mode === 'evidence') {
    required.push('independent-operation-evidence')
    await assert('independent-operation-evidence', () => verifyOperation({ evidence, desktop, backend, source: before }))
  } else {
    const base = [
      nodeCommand('desktop-types-app', desktop, 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.app.json', '--noEmit']),
      nodeCommand('desktop-types-electron', desktop, 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.node.json', '--noEmit']),
      nodeCommand('desktop-lint', desktop, 'node_modules/eslint/bin/eslint.js', ['.']),
    ]
    for (const spec of base) await execute(add(spec))
    if (mode === 'full') {
      await execute(add(nodeCommand('desktop-vitest-all', desktop, 'node_modules/vitest/vitest.mjs', ['run', '--maxWorkers=4'], 60 * minute)))
      await execute(add(nodeCommand('desktop-renderer-build', desktop, 'node_modules/vite/bin/vite.js', ['build'])))
      await execute(add(nodeCommand('desktop-electron-build', desktop, 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.node.json'])))
      const cw = path.join(community, 'web')
      await execute(add(command('community-web-tests-all', process.execPath, ['--test', ...allNodeTests(cw)], cw, 30 * minute)))
      const webBuilt = await execute(add(nodeCommand('community-web-build', cw, 'node_modules/vite/bin/vite.js', ['build'])))
      required.push('community-go-embed')
      await assert('community-go-embed', () => { if (!webBuilt) throw new Error('Community build failed; stale embed cannot pass'); return syncCommunityEmbed() })
      await execute(add(goCommand('community-go-test-all', community, ['test', './...', '-count=1', '-timeout=60m'])))
      await execute(add(goCommand('community-go-vet-all', community, ['vet', './...'])))
      const gw = path.join(gateway, 'web')
      await execute(add(command('gateway-web-tests-all', process.execPath, ['--test', ...allNodeTests(gw)], gw, 30 * minute)))
      const gatewayBuilt = await execute(add(nodeCommand('gateway-web-build', gw, 'node_modules/vite/bin/vite.js', ['build'])))
      required.push('gateway-go-embed')
      await assert('gateway-go-embed', () => { if (!gatewayBuilt) throw new Error('Gateway build failed; stale embed cannot pass'); return gatewayEmbed() })
      await execute(add(goCommand('gateway-go-test-all', gateway, ['test', './...', '-count=1', '-timeout=60m'])))
      await execute(add(goCommand('gateway-go-vet-all', gateway, ['vet', './...'])))
      const mobile = path.join(desktop, 'mobile')
      await execute(add(nodeCommand('mobile-types', mobile, 'node_modules/typescript/bin/tsc', ['--noEmit'])))
      await execute(add(nodeCommand('mobile-vitest-all', mobile, 'node_modules/vitest/vitest.mjs', ['run', '--maxWorkers=4'], 60 * minute)))
      await execute(add(nodeCommand('mobile-build-types', mobile, 'node_modules/typescript/bin/tsc', [])))
      await execute(add(nodeCommand('mobile-build', mobile, 'node_modules/vite/bin/vite.js', ['build'])))
    }
    await execute(add(goCommand('community-go-build', community, ['build', '-o', path.join(runDir, 'community-server.exe'), './cmd/server'])))
    await execute(add(goCommand('gateway-go-build', gateway, ['build', '-o', path.join(runDir, 'gateway.exe'), '.'])))
  }
  const after = fingerprint()
  json(path.join(runDir, 'source-end.json'), after)
  required.push('source-stable')
  await assert('source-stable', () => { if (before.digest !== after.digest) throw new Error('Source changed while checks were running; this result does not validate current source'); return { digest: after.digest, files: after.files.length } })
  const outputs = []
  if (mode === 'full') {
    for (const [id, dir] of [['desktop-renderer', path.join(desktop, 'dist')], ['desktop-electron', path.join(desktop, 'dist-electron')], ['community-web', path.join(community, 'web/dist')], ['community-embed', path.join(community, 'internal/webapp/dist')], ['gateway-web', path.join(gateway, 'web/dist')], ['mobile', path.join(desktop, 'mobile/dist')]]) outputs.push({ id, root: dir, files: walk(dir) })
    for (const file of ['community-server.exe', 'gateway.exe']) if (fs.existsSync(path.join(runDir, file))) outputs.push({ id: file, root: runDir, files: [{ path: file, sha256: hashFile(path.join(runDir, file)), size: fs.statSync(path.join(runDir, file)).size }] })
  }
  json(path.join(runDir, 'artifacts.json'), outputs)
  const result = { schemaVersion: 1, kind: 'fixed-local-check', mode, startedAt, completedAt: new Date().toISOString(), runDir, sourceDigest: after.digest, sourceStable: before.digest === after.digest, required, results, artifacts: path.join(runDir, 'artifacts.json'), exitCode: results.find((entry) => entry.exitCode !== 0)?.exitCode ?? 0 }
  json(path.join(runDir, 'result.json'), result)
  summary({ mode, exitCode: result.exitCode, completed: results.length, failed: results.filter((entry) => entry.exitCode !== 0).map((entry) => entry.id), result: path.join(runDir, 'result.json'), evidenceDir: evidence })
  process.exitCode = result.exitCode
}

// No configurable command execution is exposed to evidence JSON.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    if (activeRunDir) {
      json(path.join(activeRunDir, 'fatal.log'), { error: error.message, stack: error.stack })
      json(path.join(activeRunDir, 'result.json'), { schemaVersion: 1, kind: 'fixed-local-check', mode, runDir: activeRunDir, completedAt: new Date().toISOString(), error: error.message, exitCode: 1 })
    }
    summary({ error: error.message, exitCode: 1, result: activeRunDir ? path.join(activeRunDir, 'result.json') : null })
    process.exitCode = 1
  })
}
