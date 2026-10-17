import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const columns = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']
const sourceColumns = ['input_source', 'output_source', 'cache_read_source', 'cache_write_source']
export const requiredCases = ['shell.offline-editor', 'shell.account', 'shell.keyboard', 'shell.light', 'shell.dark', 'shell.narrow', 'shell.scaling', 'shell.long-content', 'shell.reduced-motion', 'shell.rapid-switch', 'shell.game', 'shell.bilingual', 'dashboard.usage', 'dashboard.layout', 'community.favorite', 'community.rankings', 'community.growth', 'cloudbag.types', 'cloudbag.collection-whole', 'cloudbag.collection-module', 'cloudbag.security', 'cloudbag.sync', 'auth.isolation']
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = (message) => { throw new Error(message) }
const ensure = (condition, message) => { if (!condition) fail(message) }

// JSON objects have no field order; arrays retain their order because slots, files,
// and event sequences are ordered contracts. This keeps evidence semantic rather
// than dependent on the serializer's insertion order.
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

export function same(a, b, message) {
  ensure(JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b)), message)
}
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN

export function evidencePath(root, relative) {
  ensure(nonempty(relative) && !path.isAbsolute(relative) && !/^[a-zA-Z]:/.test(relative) && !relative.includes('\\') && !relative.split('/').includes('..'), 'Evidence paths must be relative and cannot traverse directories')
  const base = fs.realpathSync(root)
  const candidate = path.resolve(base, relative)
  ensure(candidate.startsWith(`${base}${path.sep}`), `Evidence path escapes root: ${relative}`)
  ensure(fs.existsSync(candidate) && fs.statSync(candidate).isFile(), `Evidence file missing: ${relative}`)
  ensure(fs.realpathSync(candidate).startsWith(`${base}${path.sep}`), `Evidence link escapes root: ${relative}`)
  return candidate
}
function readJson(root, relative) { return JSON.parse(fs.readFileSync(evidencePath(root, relative), 'utf8')) }
function noSecrets(value, at = 'root') {
  if (Array.isArray(value)) { value.forEach((item, i) => noSecrets(item, `${at}[${i}]`)); return }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    ensure(!/^(authorization|cookie|set-cookie|password|credential|api_key|access_token|session_token|pairing_token|secret|dsn)$/i.test(key), `Credential field must be removed from evidence: ${at}.${key}`)
    noSecrets(item, `${at}.${key}`)
  }
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
export function inspectPng(file) {
  const bytes = fs.readFileSync(file)
  ensure(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Screenshot is not PNG content')
  let offset = 8
  let width = 0
  let height = 0
  let bits = 0
  let color = -1
  let interlace = -1
  let ended = false
  const compressed = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    ensure(length <= bytes.length - offset - 12, 'PNG chunk is truncated')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    same(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length), 'PNG CRC mismatch')
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); bits = body[8]; color = body[9]; interlace = body[12] }
    if (type === 'IDAT') compressed.push(body)
    if (type === 'IEND') { ended = true; offset += length + 12; break }
    offset += length + 12
  }
  ensure(ended && offset === bytes.length && width >= 320 && height >= 200 && width <= 16384 && height <= 16384, 'Screenshot is missing, too small or invalid')
  ensure(bits === 8 && [2, 6].includes(color) && interlace === 0, 'Capture RGB/RGBA 8-bit non-interlaced PNG screenshots')
  const raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: 160 * 1024 * 1024 })
  same(raw.length, (width * (color === 6 ? 4 : 3) + 1) * height, 'PNG pixel data size mismatch')
  const samples = new Set()
  const step = Math.max(1, Math.floor(raw.length / 100_000))
  for (let index = 0; index < raw.length; index += step) samples.add(raw[index])
  ensure(samples.size >= 8, 'Screenshot appears blank; capture actual product UI')
  return { width, height, sha256: digest(bytes) }
}

function numeric(value) { return integer(value) ? value : null }
function validReasoning(request) {
  if (nonempty(request.reasoning_effort)) return request.reasoning_effort
  if (nonempty(request.reasoning?.effort)) return request.reasoning.effort
  if (nonempty(request.thinking?.type)) return request.thinking.type === 'enabled' && integer(request.thinking.budget_tokens) ? `budget:${request.thinking.budget_tokens}` : request.thinking.type
  return null
}
export function parseUpstream(text, format) {
  const objects = []
  try { objects.push(JSON.parse(text)) } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const value = line.slice(5).trim()
      if (value === '[DONE]') continue
      try { objects.push(JSON.parse(value)) } catch { fail('Malformed provider SSE data in evidence') }
    }
  }
  ensure(objects.length > 0, 'No actual upstream response data')
  const usage = {}
  for (const obj of objects) {
    const next = format === 'openai-responses' ? (obj.response?.usage ?? obj.usage) : format === 'anthropic' ? (obj.message?.usage ?? obj.usage) : obj.usage
    if (next && typeof next === 'object') Object.assign(usage, next)
  }
  if (format === 'openai-chat') return { counts: [numeric(usage.prompt_tokens), numeric(usage.completion_tokens), numeric(usage.prompt_tokens_details?.cached_tokens), numeric(usage.prompt_tokens_details?.cache_creation_tokens)], reasoning: null }
  if (format === 'openai-responses') return { counts: [numeric(usage.input_tokens), numeric(usage.output_tokens), numeric(usage.input_tokens_details?.cached_tokens), numeric(usage.input_tokens_details?.cache_creation_tokens)], reasoning: null }
  ensure(format === 'anthropic', 'Unsupported upstream response format')
  const read = numeric(usage.cache_read_input_tokens)
  const write = numeric(usage.cache_creation_input_tokens)
  const base = numeric(usage.input_tokens)
  // Missing cache properties are unknown; no implicit 0 from an empty DTO.
  return { counts: [base !== null && read !== null && write !== null ? base + read + write : null, numeric(usage.output_tokens), read, write], reasoning: null }
}

function one(db, sql, values = []) { const value = db.prepare(sql).get(...values); ensure(value, 'Expected persisted row is missing'); return value }
function openSnapshot(DatabaseSync, file) {
  ensure(fs.readFileSync(file).subarray(0, 16).toString('binary') === 'SQLite format 3\u0000', 'Persistence proof must be SQLite content')
  ensure(!fs.existsSync(`${file}-wal`) || fs.statSync(`${file}-wal`).size === 0, 'Checkpoint SQLite before taking a standalone evidence snapshot')
  const db = new DatabaseSync(file, { readOnly: true })
  same(db.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'SQLite snapshot failed integrity check')
  return db
}
function envelope(entry) {
  ensure(entry && entry.status >= 200 && entry.status < 300 && entry.body?.success === true && entry.body.data != null, `HTTP operation failed: ${entry?.id}`)
  return entry.body.data
}
function checkWindow(window) {
  ensure(window?.timezone === 'UTC' && time(window.start) < time(window.end), 'API time window must be UTC [start,end)')
  return [Math.floor(time(window.start) / 1000), Math.floor(time(window.end) / 1000)]
}
function exactValue(row, index) { return row[sourceColumns[index]] === 'upstream' ? row[columns[index]] : null }
function compareSummary(summary, rows) {
  same(summary.requestCount, rows.length, 'Dashboard request count differs from persisted ledger')
  for (const row of rows) for (let i = 0; i < fields.length; i++) {
    ensure(['upstream', 'gateway_estimate', 'unavailable'].includes(row[sourceColumns[i]]), 'Persisted usage provenance is invalid')
    if (row[sourceColumns[i]] === 'upstream') ensure(integer(row[columns[i]]), 'Exact usage must be an actual nonnegative safe integer')
  }
  same(summary.exactRequestCount, rows.filter((row) => exactValue(row, 0) !== null && exactValue(row, 1) !== null).length, 'Exact request coverage differs from ledger')
  for (let i = 0; i < fields.length; i++) {
    const values = rows.map((row) => exactValue(row, i)).filter((value) => value !== null)
    const total = values.length ? values.reduce((a, b) => a + b, 0) : null
    // An empty complete sampling window may report 0, but unknown historical calls cannot.
    if (!rows.length && summary.coverage === 'complete') same(summary[fields[i]], 0, 'Complete empty window must contain actual zero')
    else same(summary[fields[i]], total, `Inaccurate dashboard aggregate: ${fields[i]}`)
    same(summary.fieldCoverage?.[fields[i]]?.exactRequestCount, values.length, `Field coverage missing: ${fields[i]}`)
  }
  if (rows.some((row) => columns.some((_, i) => exactValue(row, i) === null))) ensure(summary.coverage !== 'complete' && nonempty(summary.reason), 'Unknown usage requires partial/unavailable coverage and reason')
}

async function inspectArchive(JSZip, file) {
  ensure(fs.statSync(file).size <= 50 * 1024 * 1024, 'Evidence archive exceeds existing desktop cap')
  const zip = await JSZip.loadAsync(fs.readFileSync(file), { checkCRC32: true })
  const entries = []
  let bytes = 0
  const names = new Set()
  for (const item of Object.values(zip.files)) {
    if (item.dir) continue
    ensure(item.name === (item.unsafeOriginalName ?? item.name) && !/^(\/|[A-Za-z]:)/.test(item.name) && !item.name.includes('\\') && !item.name.split('/').some((part) => part === '..' || part === '.'), 'Archive contains path traversal or normalized unsafe entries')
    ensure(!names.has(item.name.toLowerCase()), 'Archive contains duplicate/case-colliding paths')
    names.add(item.name.toLowerCase())
    const data = await item.async('nodebuffer')
    bytes += data.length
    ensure(entries.length < 5000 && bytes <= 512 * 1024 * 1024 && data.length <= 50 * 1024 * 1024, 'Archive exceeds existing limits')
    entries.push({ path: item.name, sha256: digest(data), size: data.length })
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export async function verifyOperation({ evidence, desktop, backend, source }) {
  const operationPath = evidencePath(evidence, 'current-operation.json')
  const operation = JSON.parse(fs.readFileSync(operationPath, 'utf8'))
  noSecrets(operation)
  ensure(operation.schemaVersion === 1 && operation.kind === 'local-real-operation' && operation.environment === 'isolated-local', 'Require this round isolated real operation evidence')
  ensure(nonempty(operation.runId) && time(operation.startedAt) <= time(operation.completedAt) && time(operation.completedAt) <= Date.now() + 60_000, 'Operation timestamps invalid')
  same(operation.sourceDigest, source.digest, 'Operation evidence describes different current source')
  const full = readJson(evidence, operation.fullResult)
  ensure(full.mode === 'full' && full.kind === 'fixed-local-check' && full.exitCode === 0 && full.sourceStable === true && full.sourceDigest === source.digest, 'Current source needs an actual successful full run')
  const requiredFull = ['desktop-types-app', 'desktop-types-electron', 'desktop-lint', 'desktop-vitest-all', 'desktop-renderer-build', 'desktop-electron-build', 'community-web-tests-all', 'community-web-build', 'community-go-embed', 'community-go-test-all', 'community-go-vet-all', 'gateway-web-tests-all', 'gateway-web-build', 'gateway-go-embed', 'gateway-go-test-all', 'gateway-go-vet-all', 'mobile-types', 'mobile-vitest-all', 'mobile-build-types', 'mobile-build', 'community-go-build', 'gateway-go-build', 'source-stable']
  ensure(requiredFull.every((id) => full.required?.includes(id) && full.results?.some((entry) => entry.id === id && entry.exitCode === 0)), 'Full result omitted required checks')
  const privateFile = (absolute) => { const relative = path.relative(evidence, absolute).split(path.sep).join('/'); return evidencePath(evidence, relative) }
  for (const result of full.results) {
    ensure(nonempty(result.logSha256) && digest(fs.readFileSync(privateFile(result.logPath))) === result.logSha256, `Actual full log missing/changed: ${result.id}`)
    const text = fs.readFileSync(privateFile(result.logPath), 'utf8')
    ensure(text.length > 20, `Empty full log: ${result.id}`)
    if (result.executable) ensure(text.includes('"exitCode":0') && text.includes(result.id), `Log does not attest actual command completion: ${result.id}`)
  }
  const fullSource = JSON.parse(fs.readFileSync(path.join(path.dirname(privateFile(path.resolve(evidence, operation.fullResult))), 'source-end.json'), 'utf8'))
  same(fullSource.digest, source.digest, 'Full source manifest differs from current source')
  same(fullSource.files, source.files, 'Full source file fingerprint differs')
  const artifactList = JSON.parse(fs.readFileSync(privateFile(full.artifacts), 'utf8'))
  const allowedArtifacts = [path.join(desktop, 'dist'), path.join(desktop, 'dist-electron'), path.join(desktop, 'mobile/dist'), path.join(backend, 'community/web/dist'), path.join(backend, 'community/internal/webapp/dist'), path.join(backend, 'new-api/web/dist'), full.runDir].map((value) => path.resolve(value))
  for (const artifact of artifactList) {
    ensure(allowedArtifacts.includes(path.resolve(artifact.root)) && artifact.files.length > 0, `Invalid/missing build output: ${artifact.id}`)
    for (const item of artifact.files) {
      ensure(!item.path.split('/').includes('..') && !path.isAbsolute(item.path), 'Build artifact path escaped')
      const file = path.resolve(artifact.root, item.path)
      ensure(file.startsWith(`${path.resolve(artifact.root)}${path.sep}`) && fs.existsSync(file) && digest(fs.readFileSync(file)) === item.sha256, `Built output missing/changed: ${artifact.id}/${item.path}`)
    }
  }
  ensure(['desktop-renderer', 'desktop-electron', 'community-web', 'community-embed', 'gateway-web', 'mobile', 'community-server.exe', 'gateway.exe'].every((id) => artifactList.some((item) => item.id === id)), 'Required build artifacts missing')

  ensure(Array.isArray(operation.screenshots) && operation.screenshots.length >= 8, 'Required UI screenshots are missing')
  const screenshots = new Map()
  for (const item of operation.screenshots) {
    ensure(!screenshots.has(item.id), 'Duplicate screenshot id')
    const metadata = inspectPng(evidencePath(evidence, item.path))
    same(metadata.sha256, item.sha256, `Screenshot changed: ${item.id}`)
    screenshots.set(item.id, metadata)
  }
  ensure(new Set([...screenshots.values()].map((item) => item.sha256)).size >= 8, 'Screenshots must cover actual distinct product states')
  const cases = new Map((operation.cases ?? []).map((item) => [item.id, item]))
  for (const id of requiredCases) {
    const item = cases.get(id)
    ensure(item && item.screenshots?.length > 0 && item.screenshots.every((key) => screenshots.has(key)) && item.artifacts?.length > 0 && nonempty(item.trace), `Missing real operation coverage: ${id}`)
    for (const file of item.artifacts) evidencePath(evidence, file)
    const trace = readJson(evidence, item.trace)
    noSecrets(trace)
    ensure(Array.isArray(trace.actions) && trace.actions.length > 0 && trace.actions.every((action) => time(action.at) >= time(operation.startedAt) && time(action.at) <= time(operation.completedAt) && nonempty(action.action) && nonempty(action.target) && nonempty(action.observed)), `Actual action trace missing: ${id}`)
  }
  const proofs = operation.proofs
  ensure(proofs && integer(proofs.subjectUserId) && proofs.subjectUserId > 0 && integer(proofs.otherUserId) && proofs.otherUserId > 0 && proofs.subjectUserId !== proofs.otherUserId, 'Two isolated platform account IDs are required')
  const http = readJson(evidence, proofs.http)
  noSecrets(http)
  ensure(Array.isArray(http.entries), 'Actual HTTP response entries missing')
  const entries = new Map()
  for (const entry of http.entries) {
    ensure(!entries.has(entry.id), 'Duplicate HTTP evidence id')
    ensure(['GET', 'POST', 'PUT', 'DELETE'].includes(entry.method) && typeof entry.path === 'string' && entry.path.startsWith('/api/') && !entry.path.startsWith('//') && !/[\r\n]/.test(entry.path), 'Invalid HTTP operation record')
    entries.set(entry.id, entry)
  }
  const expectGet = (id, pathname) => { const entry = entries.get(id); ensure(entry?.method === 'GET' && entry.path.split('?')[0] === pathname, `HTTP route does not match proof: ${id}`); return envelope(entry) }
  ensure([401, 403].includes(entries.get('unauthenticated')?.status), 'Actual unauthenticated request did not deny access')
  for (const id of ['cloudbag-traversal-denied', 'cloudbag-unauthorized-denied', 'cloudbag-version-conflict', 'cloudbag-quota-denied', 'cloudbag-invalid-type-denied']) {
    const entry = entries.get(id)
    ensure(entry && entry.path.startsWith('/api/community/cloudbag/') && entry.body?.success === false && nonempty(entry.body?.message), `Actual cloud repository rejection missing: ${id}`)
    if (id === 'cloudbag-version-conflict') same(entry.body.code, 'version_conflict', 'Concurrency guard did not reject stale base version')
    if (id === 'cloudbag-quota-denied') same(entry.body.code, 'quota_exceeded', 'Quota guard did not reject upload')
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = openSnapshot(DatabaseSync, evidencePath(evidence, proofs.database))
  const ledger = openSnapshot(DatabaseSync, evidencePath(evidence, proofs.gatewayDatabase))
  const before = openSnapshot(DatabaseSync, evidencePath(evidence, proofs.beforeDatabase))
  const facts = []
  try {
    const uid = proofs.subjectUserId
    const user = one(db, 'SELECT id, quota FROM users WHERE id=? AND deleted_at IS NULL', [uid])
    one(db, 'SELECT id FROM users WHERE id=? AND deleted_at IS NULL', [proofs.otherUserId])
    for (const id of [uid, proofs.otherUserId]) one(db, 'SELECT id FROM community_sessions WHERE user_id=?', [id])
    const dashboard = expectGet('dashboard', '/api/community/dashboard')
    ensure(!('tokenQuota' in dashboard) && !('remainingTokens' in dashboard), 'Removed remaining Token field returned')
    same(dashboard.balance.amount, user.quota, 'Balance does not match authoritative account quota')
    same(dashboard.balance.unit, '计费额度', 'Balance unit must match fixed quota contract')
    same(dashboard.balance.source, 'gateway.users.quota', 'Balance source missing')
    const [start, end] = checkWindow(dashboard.window)
    const rows = ledger.prepare('SELECT * FROM dashboard_usage_events WHERE user_id=? AND created_at>=? AND created_at<? ORDER BY created_at DESC,id DESC').all(uid, start, end)
    ensure(rows.length >= 7, 'Require real new calls and unknown-usage calls persisted in ledger')
    compareSummary(dashboard.usage, rows)
    for (const day of dashboard.series) {
      const dayStart = Math.floor(Date.parse(`${day.date}T00:00:00Z`) / 1000)
      ensure(Number.isFinite(dayStart), 'Invalid daily series date')
      compareSummary(day, rows.filter((row) => row.created_at >= dayStart && row.created_at < dayStart + 86400))
    }
    ensure(Array.isArray(dashboard.series) && dashboard.series.length > 0, 'Daily series proof missing')
    const logs = expectGet('dashboard-logs', '/api/community/dashboard/logs')
    same(logs.total, rows.length, 'Log total differs from persistent ledger')
    ensure(Array.isArray(logs.items) && logs.items.length > 0, 'Actual call log response missing')
    for (const call of logs.items) {
      const row = rows.find((candidate) => String(candidate.request_id) === call.id || String(candidate.id) === call.id)
      ensure(row && row.user_id === uid, 'API log is not a current user persisted call')
      fields.forEach((field, index) => same(call[field], exactValue(row, index), `API log inaccurate: ${field}`))
      same(call.reasoningEffort, row.reasoning_effort ?? null, 'Effective reasoning metadata mismatch')
    }
    const other = expectGet('other-account-dashboard', '/api/community/dashboard')
    const otherRows = ledger.prepare('SELECT * FROM dashboard_usage_events WHERE user_id=? AND created_at>=? AND created_at<?').all(proofs.otherUserId, ...checkWindow(other.window))
    compareSummary(other.usage, otherRows)
    const formats = new Set()
    for (const call of proofs.calls ?? []) {
      const raw = fs.readFileSync(evidencePath(evidence, call.upstreamResponse), 'utf8')
      const actual = parseUpstream(raw, call.format)
      const request = readJson(evidence, call.effectiveRequest)
      noSecrets(request)
      const row = one(ledger, 'SELECT * FROM dashboard_usage_events WHERE request_id=?', [call.requestId])
      same(row.user_id, call.userId, 'Persisted gateway identity differs from actual call')
      ensure([uid, proofs.otherUserId].includes(row.user_id), 'Call proof belongs to unrelated account')
      actual.counts.forEach((value, i) => {
        same(exactValue(row, i), value, `Upstream usage did not persist accurately: ${call.format}/${fields[i]}`)
        if (value !== null) same(row[sourceColumns[i]], 'upstream', 'Missing field provenance')
      })
      same(row.reasoning_effort ?? null, validReasoning(request), 'Ledger reasoning does not match effective request')
      same(Boolean(row.is_stream), call.stream, 'Stream/nonstream proof mismatch')
      if (row.user_id === uid && actual.counts[0] !== null && actual.counts[1] !== null) formats.add(`${call.format}/${call.stream}`)
    }
    ensure(['openai-chat', 'openai-responses', 'anthropic'].every((format) => formats.has(`${format}/true`) && formats.has(`${format}/false`)), 'Need actual persisted stream and nonstream calls for three supported protocols')
    ensure(rows.some((row) => row.input_source !== 'upstream' || row.output_source !== 'upstream'), 'Missing/estimated-usage negative operation absent')
    facts.push({ id: 'dashboard.usage', persistedCalls: rows.length, balance: user.quota, protocols: [...formats] })

    const layout = one(db, 'SELECT version,slots_json FROM community_dashboard_layouts WHERE user_id=?', [uid])
    const expectedLayout = { version: layout.version, slots: JSON.parse(layout.slots_json) }
    same(expectGet('layout-after-restart', '/api/community/dashboard/layout'), expectedLayout, 'Layout did not survive actual restart')
    ensure(expectedLayout.version === 1 && [['balance', 'tokens'], ['tokens', 'balance']].some((slots) => JSON.stringify(slots) === JSON.stringify(expectedLayout.slots)), 'Persisted layout invalid')
    const favoriteEntry = entries.get('favorite-after-restart')
    const match = favoriteEntry?.path.match(/^\/api\/community\/posts\/(\d+)(?:\?.*)?$/)
    ensure(match, 'Favorite persistence needs actual post detail after restart')
    const post = envelope(favoriteEntry)
    one(db, 'SELECT id FROM community_post_favorites WHERE user_id=? AND post_id=? AND deleted_at IS NULL', [uid, Number(match[1])])
    same(post.favorited, true, 'Favorite did not survive restart')
    const count = one(db, 'SELECT COUNT(*) AS n FROM community_post_favorites WHERE post_id=? AND deleted_at IS NULL', [Number(match[1])]).n
    same(post.favorite_count, count, 'Favorite count differs from persistent relations')
    const profile = expectGet('profile-after-restart', '/api/community/account/profile')
    same(profile.nickname, one(db, 'SELECT nickname FROM community_profiles WHERE user_id=?', [uid]).nickname, 'Community nickname did not survive restart')
    const growth = expectGet('growth-after-restart', '/api/community/account/growth')
    same(growth.public, Boolean(one(db, 'SELECT public FROM community_growth_preferences WHERE user_id=?', [uid]).public), 'Growth public preference not persisted')
    if (growth.rules_source === null) ensure(growth.total === null && growth.coverage === 'unavailable' && nonempty(growth.reason) && growth.breakdown.every((part) => part.points === null), 'Growth without real rules must not invent rewards')
    facts.push({ id: 'persistence', layout: expectedLayout, favoritePost: Number(match[1]), publicGrowth: growth.public })

    for (const [id, type] of [['rankings-posts', 'posts'], ['rankings-mods', 'mods']]) {
      const rank = expectGet(id, '/api/community/rankings')
      same(rank.type, type, 'Ranking type mismatch')
      ensure(Array.isArray(rank.items) && rank.items.length > 0, 'Ranking operation needs actual events')
      const range = rank.window ? checkWindow(rank.window) : [0, Math.floor(Date.now() / 1000) + 1]
      const values = []
      for (const item of rank.items) {
        const postId = type === 'posts' ? item.id : item.post_id
        one(db, 'SELECT id FROM community_posts WHERE id=? AND status=? AND deleted_at IS NULL', [postId, 'visible'])
        const n = type === 'posts'
          ? one(db, 'SELECT COUNT(*) AS n FROM community_post_likes WHERE post_id=? AND deleted_at IS NULL AND created_at>=? AND created_at<?', [postId, ...range]).n
          : one(db, 'SELECT COUNT(*) AS n FROM community_download_events WHERE post_id=? AND created_at>=? AND created_at<?', [postId, ...range]).n
        same(type === 'posts' ? item.like_count : item.download_count, n, 'Ranking metric differs from actual persisted events')
        values.push(n)
      }
      ensure(values.every((value, index) => index === 0 || values[index - 1] >= value), 'Ranking is not sorted by confirmed metric')
      facts.push({ id, values })
    }

    const selection = proofs.collection
    ensure(selection && nonempty(selection.repoSlug) && Number.isSafeInteger(selection.versionNo) && selection.versionNo > 0 && nonempty(selection.modulePath) && !selection.modulePath.includes('/'), 'Collection selection proof missing')
    const repo = one(db, 'SELECT id,type FROM cloudbag_repositories WHERE slug=?', [selection.repoSlug])
    same(repo.type, 'collection', 'Collection repository type not persisted')
    const version = one(db, 'SELECT * FROM cloudbag_versions WHERE repo_id=? AND version_no=?', [repo.id, selection.versionNo])
    const old = one(before, 'SELECT * FROM cloudbag_versions WHERE repo_id=? AND version_no=?', [repo.id, selection.versionNo])
    same(version.manifest_json, old.manifest_json, 'Previous version manifest was mutated')
    same(version.manifest_hash, old.manifest_hash, 'Previous manifest hash was mutated')
    for (const column of ['parent_version_no', 'message', 'file_count', 'total_size', 'created_by_user_id', 'created_at', 'type']) {
      same(version[column], old[column], `Previous immutable version metadata was changed: ${column}`)
    }
    const manifest = JSON.parse(version.manifest_json)
    ensure(manifest.type === 'collection' && Array.isArray(manifest.modules) && manifest.modules.some((module) => module.path === selection.modulePath) && manifest.modules.length >= 2, 'Collection manifest missing real module units')
    const query = 'SELECT path,sha256,size FROM cloudbag_version_files WHERE version_id=? ORDER BY path'
    const fileRows = db.prepare(query).all(version.id).sort((a, b) => a.path.localeCompare(b.path))
    const oldRows = before.prepare(query).all(old.id).sort((a, b) => a.path.localeCompare(b.path))
    same(fileRows, oldRows, 'Previous version file contents were mutated')
    const require = createRequire(path.join(desktop, 'package.json'))
    const JSZip = require('jszip')
    same(await inspectArchive(JSZip, evidencePath(evidence, selection.wholeArchive)), fileRows, 'Whole collection archive differs from fixed version')
    const prefix = `${selection.modulePath}/`
    const single = fileRows.filter((row) => row.path.startsWith(prefix)).map((row) => ({ ...row, path: row.path.slice(prefix.length) }))
    ensure(single.some((row) => row.path === 'mod-info.txt'), 'Single module lacks mod-info.txt')
    same(await inspectArchive(JSZip, evidencePath(evidence, selection.moduleArchive)), single, 'Single-module export leaked neighbors or changed contents')
    const types = db.prepare('SELECT DISTINCT type FROM cloudbag_repositories').all().map((item) => item.type)
    ensure(['mod', 'collection', 'asset'].every((type) => types.includes(type)), 'Three repository types were not actually created')
    one(db, 'SELECT id FROM cloudbag_sync_ops WHERE repo_id=? AND status=?', [repo.id, 'applied'])
    facts.push({ id: 'cloudbag.collection', repo: selection.repoSlug, version: selection.versionNo, module: selection.modulePath, files: fileRows.length })
    const comparisons = proofs.fileComparisons ?? []
    ensure(comparisons.some((item) => item.relation === 'equal') && comparisons.some((item) => item.relation === 'different'), 'Actual backup and changed/pulled file comparisons required')
    for (const item of comparisons) {
      ensure(['equal', 'different'].includes(item.relation), 'Unknown file comparison relation')
      const equal = digest(fs.readFileSync(evidencePath(evidence, item.left))) === digest(fs.readFileSync(evidencePath(evidence, item.right)))
      same(equal, item.relation === 'equal', 'Actual sync/backup file content differs from evidence claim')
    }
  } finally { db.close(); ledger.close(); before.close() }
  return { schemaVersion: 1, operation: operation.runId, sourceDigest: source.digest, checkedCases: requiredCases, screenshots: [...screenshots.entries()].map(([id, metadata]) => ({ id, ...metadata })), facts, limitation: 'File/data verification does not substitute for visual review of the captured UI.' }
}
