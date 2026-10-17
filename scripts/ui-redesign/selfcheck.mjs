import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { evidencePath, inspectPng, parseUpstream, same } from './verify-operation.mjs'
import { fingerprint } from './check.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = 'W:/mao/tx/ohmytx后端/ohmytx-ui-redesign-backend/docs/ui-redesign-evidence'
const out = path.join(evidence, 'contract-selfcheck', new Date().toISOString().replace(/[:.]/g, '-'))
const scripts = path.join(desktop, 'scripts/ui-redesign')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)))
Object.assign(env, { CI: 'true', NO_COLOR: '1' })
const results = []
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(id, args, expectedCode = 0, cwd = desktop) {
  const result = spawnSync(process.execPath, args, { cwd, env, shell: false, windowsHide: true, timeout: 120_000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const log = path.join(out, `${id}.log`)
  fs.writeFileSync(log, `${JSON.stringify({ executable: process.execPath, args, cwd, expectedCode })}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n${JSON.stringify({ actualCode: result.status, signal: result.signal, error: result.error?.message ?? null })}\n`)
  results.push({ id, executable: process.execPath, args, cwd, expectedCode, actualCode: result.status, passed: !result.error && result.status === expectedCode, log, sha256: hash(log) })
  return result
}
function test(id, fn) {
  try { const details = fn(); results.push({ id, passed: true, details: details ?? null }) }
  catch (error) { results.push({ id, passed: false, error: error.message }) }
}

fs.mkdirSync(out, { recursive: true })
for (const file of ['check.mjs', 'verify-operation.mjs', 'prepare-dependencies.mjs', 'selfcheck.mjs']) run(`syntax-${file}`, ['--check', path.join(scripts, file)])
run('eslint-development-scripts', [path.join(desktop, 'node_modules/eslint/bin/eslint.js'), ...['check.mjs', 'verify-operation.mjs', 'prepare-dependencies.mjs', 'selfcheck.mjs'].map((name) => path.join(scripts, name)), '--no-ignore'])
run('reject-missing-mode', [path.join(scripts, 'check.mjs')], 64)
run('reject-extra-argument', [path.join(scripts, 'check.mjs'), 'fast', 'custom-command'], 64)
run('reject-unknown-mode', [path.join(scripts, 'check.mjs'), 'custom-command'], 64)
if (!fs.existsSync(path.join(evidence, 'current-operation.json'))) run('evidence-rejects-missing-real-operations', [path.join(scripts, 'check.mjs'), 'evidence'], 1)
else results.push({ id: 'evidence-rejects-missing-real-operations', passed: false, error: 'Existing operation evidence preserved; absence negative test did not run' })

test('json-object-key-order-is-ignored-arrays-keep-order', () => {
  same({ slots: ['tokens', 'balance'], version: 1 }, { version: 1, slots: ['tokens', 'balance'] }, 'Equivalent JSON objects were rejected')
  assert.throws(() => same({ slots: ['tokens', 'balance'], version: 1 }, { version: 1, slots: ['balance', 'tokens'] }, 'Array order was ignored'))
})
test('fingerprint-covers-mobile-build-inputs', () => {
  const paths = new Set(fingerprint().files.filter((entry) => entry.repo === 'desktop').map((entry) => entry.path))
  for (const file of ['mobile/index.html', 'mobile/tsconfig.json', 'mobile/tsconfig.node.json', 'mobile/vite.config.ts', 'mobile/vitest.config.ts']) assert.ok(paths.has(file), `Missing mobile fingerprint input: ${file}`)
})
test('upstream-chat-real-zero-versus-unknown', () => {
  const response = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } })
  assert.deepEqual(parseUpstream(response, 'openai-chat').counts, [10, 0, 0, null])
  assert.deepEqual(parseUpstream('{}', 'openai-chat').counts, [null, null, null, null])
})
test('upstream-responses-stream', () => {
  const response = 'event: response.completed\ndata: ' + JSON.stringify({ response: { usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } } } }) + '\n\ndata: [DONE]\n'
  assert.deepEqual(parseUpstream(response, 'openai-responses').counts, [12, 5, 3, null])
})
test('upstream-anthropic-stream-normalization', () => {
  const chunks = [{ message: { usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } }, { usage: { output_tokens: 7 } }]
  assert.deepEqual(parseUpstream(chunks.map((value) => `data: ${JSON.stringify(value)}`).join('\n'), 'anthropic').counts, [10, 7, 2, 3])
})
test('reject-path-traversal-and-missing-artifacts', () => {
  for (const candidate of ['../outside.json', 'W:/outside.json', '/outside.json', 'missing.png']) assert.throws(() => evidencePath(evidence, candidate))
})
test('reject-fake-png-extension', () => {
  const file = path.join(out, 'selftest-not-a-screenshot.png')
  fs.writeFileSync(file, 'Selfcheck invalid fixture; never real operation evidence')
  assert.throws(() => inspectPng(file))
})
test('accept-real-png-content-only-as-selftest', () => {
  const require = createRequire(path.join(desktop, 'package.json'))
  const { PNG } = require('pngjs')
  const png = new PNG({ width: 320, height: 200 })
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = (i / 4) % 251; png.data[i + 1] = (i / 16) % 239; png.data[i + 2] = (i / 64) % 227; png.data[i + 3] = 255 }
  const file = path.join(out, 'selftest-generated-png-not-product-evidence.png')
  fs.writeFileSync(file, PNG.sync.write(png))
  assert.equal(inspectPng(file).width, 320)
  return { fixture: file, kind: 'generated selfcheck only; not UI screenshot evidence' }
})
test('dependency-entry-points-ready-locks-stable', () => {
  const roots = [desktop, 'W:/mao/tx/ohmytx后端/ohmytx-ui-redesign-backend/community/web', 'W:/mao/tx/ohmytx后端/ohmytx-ui-redesign-backend/new-api/web', path.join(desktop, 'mobile')]
  for (const root of roots) assert.ok(fs.existsSync(path.join(root, 'node_modules/vite/bin/vite.js')))
  assert.equal(hash(path.join(desktop, 'package-lock.json')), 'de2429e6d25cc2f9f696c449017fd89feb02cd63f9e269bb1ab04c47a61f4ee8')
  assert.equal(hash(path.join(roots[1], 'package-lock.json')), '17cfeac3551bb7a173c48fbc1cb702fc316d267a11a887a2e13cdaa368347960')
  assert.equal(hash(path.join(roots[3], 'package-lock.json')), '1526d14a63a4d342f1e4e483fd8576422e4f0ec042ef2a12de13d67ef83e0b42')
  for (const [name, vendor] of [['pi-agent-core', 'agent'], ['pi-ai', 'ai'], ['pi-telemetry', 'telemetry']]) assert.equal(fs.realpathSync(path.join(desktop, 'node_modules/@earendil-works', name)), fs.realpathSync(path.join(desktop, 'vendor/pi/packages', vendor)))
})
const result = { schemaVersion: 1, kind: 'contract-script-selfcheck-only', createdAt: new Date().toISOString(), results, suitesNotRun: ['fast', 'full', 'real GUI/HTTP/persistence operations'], note: 'evidence mode ran only a required missing-evidence negative check; never product acceptance', exitCode: results.every((entry) => entry.passed) ? 0 : 1 }
fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ exitCode: result.exitCode, checks: results.length, failed: results.filter((entry) => !entry.passed).map((entry) => entry.id), result: path.join(out, 'result.json') }))
process.exitCode = result.exitCode
