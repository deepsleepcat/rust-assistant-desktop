/**
 * 本地知识包更新器（M18，P2 任务 2）：
 * 官方数据（code/section/value_type/translations/vocabulary/logicboolean/units/
 * game_version 等）可检测更新、增量下载、sha256 校验、失败自动回滚。
 *
 * 目录结构（userData/knowledge-pack/）：
 *   current.json            指针：{ version, updatedAt }（指向当前生效版本目录）
 *   v<版本>/manifest.json   该版本清单（files: [{path, sha256, size}]）
 *   v<版本>/<数据文件>       该版本的数据文件（每个版本目录都是「全量快照」：
 *                           增量更新会把上一版本未变更的文件复制进来，保证
 *                           任意时刻当前目录 = 完整数据，读取无需回退链）
 * 只保留当前版本 + 上一个版本目录（回滚用），更早的自动清理。
 *
 * 更新流程（原子切换，天然回滚）：
 *   1. 校验数据源 URL（只允许 http/https，防 file:// 读本地文件）
 *   2. 拉取远端 manifest，与本地区块对比 → changedFiles（增量）
 *   3. 逐个下载到 .pending 目录，校验 size + sha256；任一失败 → 删除 pending，
 *      指针不动（旧版继续生效）
 *   4. 从上一版本目录复制未变更文件（全量快照）→ pending 改名为 v<版本> →
 *      原子写 current.json → 清理旧目录
 *
 * 安全边界：
 *   - 文件名白名单（只允许已知数据文件名，manifest 无法指定任意路径）
 *   - 版本字符串消毒（只保留 [A-Za-z0-9._-]，防路径穿越）
 *   - manifest/文件大小上限 + 流式读取中途截断（防恶意源撑爆内存/磁盘）
 *   - fetch 带超时（失联镜像不永久挂起）
 *   - update/rollback 互斥（防双触发交错）
 *   - 无网络 / 未配置源时抛错，本地包照常可用（离线兜底）
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** 允许更新的数据文件名（manifest 只能声明这些文件；migrate.json 为版本迁移表预留） */
export const DATA_FILE_NAMES: readonly string[] = [
  'code.json',
  'section.json',
  'value_type.json',
  'translations.json',
  'vocabulary.json',
  'logicboolean.json',
  'units.json',
  'game_version.json',
  'migrate.json',
]

/** 远端 manifest 大小上限（1MB，恶意源塞超大清单直接拒绝） */
const MAX_MANIFEST_BYTES = 1024 * 1024
/** 单个数据文件大小上限（20MB） */
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** 清单拉取超时（毫秒） */
const MANIFEST_TIMEOUT_MS = 30_000
/** 文件下载超时（毫秒） */
const FILE_TIMEOUT_MS = 60_000

export interface KnowledgeManifestFile {
  path: string
  sha256: string
  size: number
}

export interface KnowledgeManifest {
  version: string
  files: KnowledgeManifestFile[]
}

export interface KnowledgePackInfo {
  /** 当前生效版本（null = 从未更新，全部用内置包） */
  currentVersion: string | null
  updatedAt: number
  /** 已下载的版本目录（含当前与上一个，供回滚） */
  availableVersions: string[]
  /** 数据文件数量（内置包） */
  builtinFileCount: number
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  latestVersion: string
  currentVersion: string | null
  changedFiles: string[]
  /** 更新失败/无法检查时的说明（无网络、未配置源等）；有值时 hasUpdate=false */
  error?: string
}

export interface UpdateResult {
  ok: boolean
  version?: string
  /** 本次更新的文件数（增量） */
  updatedFiles?: number
  error?: string
}

export interface RollbackResult {
  ok: boolean
  version?: string
  error?: string
}

/** 数据源 URL 校验：只允许 http/https（file:// 可读任意本地文件，拒绝） */
export function validateSourceUrl(url: string): string | null {
  const trimmed = String(url ?? '').trim()
  if (!trimmed) return '未配置数据源'
  if (!/^https?:\/\//i.test(trimmed)) return '数据源必须以 http:// 或 https:// 开头'
  if (trimmed.length > 500) return '数据源地址过长'
  return null
}

/** 版本字符串消毒：只保留安全字符，防路径穿越（'..'、'/' 等全部替换） */
export function sanitizeVersion(version: string): string {
  const cleaned = String(version ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80)
  return cleaned || 'unknown'
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 版本号数值化比较（用于清理/回滚的「最新优先」排序）：
 * 按「数字段 + 字母段」切 token（1.15-p10 → [1,15,'p',10]），数字段按数值比较、
 * 字母段按字典序；缺段视为更旧。字典序在这里是错的（'1.9' > '1.15'、'p9' > 'p10'）。
 * 注意不能用 split 切分隔符——分隔符被吞掉后 'p9' 会变成原子段，无法再比较数值。
 */
export function compareVersions(a: string, b: string): number {
  const tokens = (s: string): Array<number | string> =>
    (String(s).match(/\d+|[A-Za-z]+/g) ?? []).map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  const pa = tokens(a)
  const pb = tokens(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else if (typeof x === 'number') {
      return 1 // 同位置数字段 > 字母段（'1.15' 比 '1.15-p' 更基础）
    } else if (typeof y === 'number') {
      return -1
    } else if (x !== y) {
      const c = x.localeCompare(y)
      if (c !== 0) return c
    }
  }
  return 0
}

export interface KnowledgePackApi {
  readDataFile(name: string): Promise<{ content: string; source: 'builtin' | 'updated'; version: string | null }>
  info(): Promise<KnowledgePackInfo>
  checkUpdate(sourceUrl: string): Promise<UpdateCheckResult>
  update(sourceUrl: string): Promise<UpdateResult>
  rollback(): Promise<RollbackResult>
}

/** 带超时 + 流式字节上限的拉取（防失联源永久挂起、恶意源撑爆内存） */
async function fetchLimited(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    // AbortSignal.timeout 中止抛 DOMException（英文）；转成可读提示（保留原因为排查留痕）
    if (err instanceof Error && err.name === 'TimeoutError') throw new Error('连接超时，已中止（检查网络或数据源地址）', { cause: err })
    throw err
  }
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  if (!res.body) {
    // 无流式体（极端情况）：退化为全量读取后校验
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('内容超过大小上限，拒绝加载')
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('内容超过大小上限，已中止下载')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** 创建知识包管理器（pure Node：不依赖 electron，便于测试注入目录） */
export function createKnowledgePack(packDir: string, builtinDir: string): KnowledgePackApi {
  const CURRENT_FILE = path.join(packDir, 'current.json')
  /** update/rollback 互斥（防双触发交错导致指针与目录不一致） */
  let mutating = false

  async function readCurrent(): Promise<{ version: string; updatedAt: number } | null> {
    try {
      const raw = await fs.readFile(CURRENT_FILE, 'utf8')
      const parsed = JSON.parse(raw) as { version?: unknown; updatedAt?: unknown }
      if (typeof parsed.version === 'string' && parsed.version) {
        return { version: parsed.version, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0 }
      }
      return null
    } catch {
      return null
    }
  }

  async function writeCurrent(version: string): Promise<void> {
    await fs.mkdir(packDir, { recursive: true })
    const tmp = `${CURRENT_FILE}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ version, updatedAt: Date.now() }, null, 2), 'utf8')
    await fs.rename(tmp, CURRENT_FILE)
  }

  function versionDir(version: string): string {
    return path.join(packDir, `v${sanitizeVersion(version)}`)
  }

  /** 读版本清单（不存在/损坏返回 null） */
  async function readManifest(dir: string): Promise<KnowledgeManifest | null> {
    try {
      const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as { version?: unknown; files?: unknown }
      if (typeof parsed.version !== 'string' || !Array.isArray(parsed.files)) return null
      const files: KnowledgeManifestFile[] = []
      for (const f of parsed.files) {
        if (f && typeof f === 'object' && typeof (f as KnowledgeManifestFile).path === 'string') {
          files.push({
            path: (f as KnowledgeManifestFile).path,
            sha256: typeof (f as KnowledgeManifestFile).sha256 === 'string' ? (f as KnowledgeManifestFile).sha256 : '',
            size: typeof (f as KnowledgeManifestFile).size === 'number' ? (f as KnowledgeManifestFile).size : -1,
          })
        }
      }
      return { version: parsed.version, files }
    } catch {
      return null
    }
  }

  /** 已下载的版本目录（含当前与上一个；按版本数值序升序） */
  async function listVersionDirs(): Promise<Array<{ dir: string; version: string }>> {
    try {
      const entries = await fs.readdir(packDir, { withFileTypes: true })
      const out: Array<{ dir: string; version: string }> = []
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith('v')) continue
        const m = await readManifest(path.join(packDir, e.name))
        if (m) out.push({ dir: path.join(packDir, e.name), version: m.version })
      }
      return out.sort((a, b) => compareVersions(a.version, b.version))
    } catch {
      return []
    }
  }

  /** 清理：保留最新 2 个版本目录 + 删除 manifest 损坏的孤儿目录 + 崩溃残留的 .pending 半成品 */
  async function cleanupOldDirs(): Promise<void> {
    try {
      const entries = await fs.readdir(packDir, { withFileTypes: true })
      const valid: Array<{ dir: string; version: string }> = []
      const orphans: string[] = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const full = path.join(packDir, e.name)
        if (!e.name.startsWith('v')) {
          // .pending-* 等非版本目录 = 上次更新中途崩溃的残留，直接清理
          if (e.name.startsWith('.pending')) orphans.push(full)
          continue
        }
        const m = await readManifest(full)
        if (m) valid.push({ dir: full, version: m.version })
        else orphans.push(full) // 无有效清单 = 不可用数据（可能半成品），删除
      }
      valid.sort((a, b) => compareVersions(b.version, a.version))
      for (const d of valid.slice(2)) await fs.rm(d.dir, { recursive: true, force: true }).catch(() => undefined)
      for (const o of orphans) await fs.rm(o, { recursive: true, force: true }).catch(() => undefined)
    } catch {
      // 清理失败不影响主流程（下次更新再试）
    }
  }

  async function readDataFile(name: string): Promise<{ content: string; source: 'builtin' | 'updated'; version: string | null }> {
    if (!DATA_FILE_NAMES.includes(name)) throw new Error(`未知的数据文件名：${name}`)
    // 当前版本目录是全量快照（增量更新会复制上一版本未变更文件）：
    // 找到文件直接返回；找不到（异常情况）回退内置包
    const current = await readCurrent()
    if (current) {
      try {
        const buf = await fs.readFile(path.join(versionDir(current.version), name))
        return { content: buf.toString('utf8'), source: 'updated', version: current.version }
      } catch {
        // 该文件不在当前快照（磁盘异常）→ 落到内置包
      }
    }
    const builtin = await fs.readFile(path.join(builtinDir, name))
    return { content: builtin.toString('utf8'), source: 'builtin', version: null }
  }

  async function info(): Promise<KnowledgePackInfo> {
    const current = await readCurrent()
    const dirs = await listVersionDirs()
    let builtinFileCount = 0
    try {
      builtinFileCount = (await fs.readdir(builtinDir)).filter((f) => DATA_FILE_NAMES.includes(f)).length
    } catch {
      // 内置目录缺失（异常安装）：计数为 0，不抛错
    }
    return {
      currentVersion: current?.version ?? null,
      updatedAt: current?.updatedAt ?? 0,
      availableVersions: dirs.map((d) => d.version),
      builtinFileCount,
    }
  }

  /** 拉取远端 manifest（带超时与大小上限） */
  async function fetchManifest(sourceUrl: string): Promise<KnowledgeManifest> {
    const err = validateSourceUrl(sourceUrl)
    if (err) throw new Error(err)
    const buf = await fetchLimited(`${sourceUrl}/manifest.json`, MAX_MANIFEST_BYTES, MANIFEST_TIMEOUT_MS)
    let manifest: { version?: unknown; files?: unknown }
    try {
      manifest = JSON.parse(buf.toString('utf8')) as { version?: unknown; files?: unknown }
    } catch {
      throw new Error('清单不是合法 JSON（数据源地址可能不对，或该地址不是知识包仓库）')
    }
    if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('清单缺少 version')
    if (!Array.isArray(manifest.files)) throw new Error('清单缺少 files 列表')
    const files: KnowledgeManifestFile[] = []
    for (const f of manifest.files) {
      if (!f || typeof f !== 'object') continue
      const item = f as KnowledgeManifestFile
      if (typeof item.path !== 'string' || !DATA_FILE_NAMES.includes(item.path)) continue // 白名单外忽略
      if (typeof item.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(item.sha256)) continue // 非法哈希忽略
      files.push({ path: item.path, sha256: item.sha256.toLowerCase(), size: typeof item.size === 'number' ? item.size : -1 })
    }
    return { version: manifest.version, files }
  }

  async function checkUpdate(sourceUrl: string): Promise<UpdateCheckResult> {
    let remote: KnowledgeManifest
    try {
      remote = await fetchManifest(sourceUrl)
    } catch (err) {
      return { hasUpdate: false, latestVersion: '', currentVersion: null, changedFiles: [], error: err instanceof Error ? err.message : String(err) }
    }
    const current = await readCurrent()
    const currentVersion = current?.version ?? null
    const localManifest = current ? await readManifest(versionDir(current.version)) : null
    const localHashes = new Map<string, string>()
    if (localManifest) {
      for (const f of localManifest.files) localHashes.set(f.path, f.sha256)
    }
    const changedFiles = remote.files.filter((f) => localHashes.get(f.path) !== f.sha256).map((f) => f.path)
    return {
      hasUpdate: changedFiles.length > 0,
      latestVersion: remote.version,
      currentVersion,
      changedFiles,
    }
  }

  async function update(sourceUrl: string): Promise<UpdateResult> {
    if (mutating) return { ok: false, error: '已有更新/回滚正在进行，请稍候' }
    mutating = true
    try {
      let remote: KnowledgeManifest
      try {
        remote = await fetchManifest(sourceUrl)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      const current = await readCurrent()
      const previousDir = current ? versionDir(current.version) : null
      const localManifest = previousDir ? await readManifest(previousDir) : null
      const localHashes = new Map<string, string>()
      if (localManifest) {
        for (const f of localManifest.files) localHashes.set(f.path, f.sha256)
      }
      const changed = remote.files.filter((f) => localHashes.get(f.path) !== f.sha256)
      if (changed.length === 0) {
        return { ok: true, version: remote.version, updatedFiles: 0, error: '已是最新版本' }
      }

      const pendingDir = path.join(packDir, `.pending-${Date.now()}`)
      const targetDir = versionDir(remote.version)
      try {
        await fs.mkdir(pendingDir, { recursive: true })
        // 逐个下载 + 校验：任一失败抛错 → 外层清理 pending，指针不动（旧版继续生效）
        for (const f of changed) {
          const buf = await fetchLimited(`${sourceUrl}/${f.path}`, MAX_FILE_BYTES, FILE_TIMEOUT_MS)
          if (f.size >= 0 && buf.length !== f.size) throw new Error(`「${f.path}」大小不符（期望 ${f.size}，实际 ${buf.length}）`)
          const hash = sha256Hex(buf)
          if (hash !== f.sha256) throw new Error(`「${f.path}」哈希校验失败，已中止更新（旧版不受影响）`)
          await fs.writeFile(path.join(pendingDir, f.path), buf)
        }
        // 全量快照：把上一版本目录中「未变更」的文件复制进新目录——
        // 否则增量更新只含变更文件，后续版本切换后旧更新内容会静默丢失
        if (previousDir && localManifest) {
          const changedSet = new Set(changed.map((c) => c.path))
          for (const f of localManifest.files) {
            if (changedSet.has(f.path)) continue
            try {
              await fs.copyFile(path.join(previousDir, f.path), path.join(pendingDir, f.path))
            } catch {
              // 上一版本缺该文件：跳过（该版本可能也没有）
            }
          }
        }
        // 写版本清单（与下载内容一致，供下次增量对比）
        await fs.writeFile(path.join(pendingDir, 'manifest.json'), JSON.stringify(remote, null, 2), 'utf8')
        // 目标目录已存在（同版本强制刷新）：先移除再切换
        await fs.rm(targetDir, { recursive: true, force: true })
        await fs.rename(pendingDir, targetDir)
        // 最后写指针：指针只指向「已就绪」的目录（失败时旧指针不动）
        await writeCurrent(remote.version)
        await cleanupOldDirs()
        return { ok: true, version: remote.version, updatedFiles: changed.length }
      } catch (err) {
        await fs.rm(pendingDir, { recursive: true, force: true }).catch(() => undefined)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    } finally {
      mutating = false
    }
  }

  async function rollback(): Promise<RollbackResult> {
    if (mutating) return { ok: false, error: '已有更新/回滚正在进行，请稍候' }
    mutating = true
    try {
      const current = await readCurrent()
      if (!current) return { ok: false, error: '没有可回滚的更新（当前使用内置包）' }
      const dirs = await listVersionDirs()
      const others = dirs.filter((d) => d.version !== current.version)
      if (others.length === 0) return { ok: false, error: '没有保留上一版本，无法回滚' }
      // 取版本数值序最大的其他版本 = 真正的上一版本（字典序在 1.9/1.15 场景会选错）
      const target = others.sort((a, b) => compareVersions(b.version, a.version))[0]
      await writeCurrent(target.version)
      await cleanupOldDirs()
      return { ok: true, version: target.version }
    } finally {
      mutating = false
    }
  }

  return { readDataFile, info, checkUpdate, update, rollback }
}
