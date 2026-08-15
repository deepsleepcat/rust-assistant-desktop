/**
 * 本地知识包更新器（M18，P2 任务 2）：
 * 官方数据（code/section/value_type/translations/vocabulary/logicboolean/units/
 * game_version 等）可检测更新、增量下载、sha256 校验、失败自动回滚。
 *
 * 目录结构（userData/knowledge-pack/）：
 *   current.json            指针：{ version, updatedAt }（指向当前生效版本目录）
 *   v<版本>/manifest.json   该版本清单（files: [{path, sha256, size}]）
 *   v<版本>/<数据文件>       该版本的数据文件
 * 只保留当前版本 + 上一个版本目录（回滚用），更早的自动清理。
 *
 * 更新流程（原子切换，天然回滚）：
 *   1. 校验数据源 URL（只允许 http/https，防 file:// 读本地文件）
 *   2. 拉取远端 manifest，与本地区块对比 → changedFiles（增量）
 *   3. 逐个下载到 .pending 目录，校验 size + sha256；任一失败 → 删除 pending，
 *      指针不动（旧版继续生效）
 *   4. 全部成功 → pending 改名为 v<版本> → 原子写 current.json → 清理旧目录
 *
 * 安全边界：
 *   - 文件名白名单（只允许已知数据文件名，manifest 无法指定任意路径）
 *   - 版本字符串消毒（只保留 [A-Za-z0-9._-]，防路径穿越）
 *   - manifest/文件大小上限（防恶意源撑爆磁盘）
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

export interface KnowledgePackApi {
  readDataFile(name: string): Promise<{ content: string; source: 'builtin' | 'updated'; version: string | null }>
  info(): Promise<KnowledgePackInfo>
  checkUpdate(sourceUrl: string): Promise<UpdateCheckResult>
  update(sourceUrl: string): Promise<UpdateResult>
  rollback(): Promise<RollbackResult>
}

/** 创建知识包管理器（pure Node：不依赖 electron，便于测试注入目录） */
export function createKnowledgePack(packDir: string, builtinDir: string): KnowledgePackApi {
  const CURRENT_FILE = path.join(packDir, 'current.json')

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

  /** 已下载的版本目录（含当前与上一个） */
  async function listVersionDirs(): Promise<Array<{ dir: string; version: string }>> {
    try {
      const entries = await fs.readdir(packDir, { withFileTypes: true })
      const out: Array<{ dir: string; version: string }> = []
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith('v')) continue
        const m = await readManifest(path.join(packDir, e.name))
        if (m) out.push({ dir: path.join(packDir, e.name), version: m.version })
      }
      return out
    } catch {
      return []
    }
  }

  async function readDataFile(name: string): Promise<{ content: string; source: 'builtin' | 'updated'; version: string | null }> {
    if (!DATA_FILE_NAMES.includes(name)) throw new Error(`未知的数据文件名：${name}`)
    // 优先已更新的版本目录；其次内置包
    const current = await readCurrent()
    if (current) {
      try {
        const buf = await fs.readFile(path.join(versionDir(current.version), name))
        return { content: buf.toString('utf8'), source: 'updated', version: current.version }
      } catch {
        // 该文件不在更新包（增量包可能只覆盖部分文件）→ 落到内置包
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

  /** 拉取远端 manifest（带大小上限与 JSON 校验） */
  async function fetchManifest(sourceUrl: string): Promise<KnowledgeManifest> {
    const err = validateSourceUrl(sourceUrl)
    if (err) throw new Error(err)
    const res = await fetch(`${sourceUrl}/manifest.json`)
    if (!res.ok) throw new Error(`清单拉取失败：HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_MANIFEST_BYTES) throw new Error('清单文件过大，拒绝加载')
    const manifest = JSON.parse(buf.toString('utf8')) as { version?: unknown; files?: unknown }
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
    let remote: KnowledgeManifest
    try {
      remote = await fetchManifest(sourceUrl)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const current = await readCurrent()
    const localManifest = current ? await readManifest(versionDir(current.version)) : null
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
        const res = await fetch(`${sourceUrl}/${f.path}`)
        if (!res.ok) throw new Error(`「${f.path}」下载失败：HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > MAX_FILE_BYTES) throw new Error(`「${f.path}」超过大小上限，拒绝写入`)
        if (f.size >= 0 && buf.length !== f.size) throw new Error(`「${f.path}」大小不符（期望 ${f.size}，实际 ${buf.length}）`)
        const hash = sha256Hex(buf)
        if (hash !== f.sha256) throw new Error(`「${f.path}」哈希校验失败，已中止更新（旧版不受影响）`)
        await fs.writeFile(path.join(pendingDir, f.path), buf)
      }
      // 写版本清单（与下载内容一致，供下次增量对比）
      await fs.writeFile(path.join(pendingDir, 'manifest.json'), JSON.stringify(remote, null, 2), 'utf8')
      // 目标目录已存在（同版本强制刷新）：先移除再切换
      await fs.rm(targetDir, { recursive: true, force: true })
      await fs.rename(pendingDir, targetDir)
      await writeCurrent(remote.version)
      // 清理：只保留当前 + 上一个（更早的删除）
      const dirs = (await listVersionDirs()).sort((a, b) => b.version.localeCompare(a.version))
      for (const d of dirs.slice(2)) {
        await fs.rm(d.dir, { recursive: true, force: true }).catch(() => undefined)
      }
      return { ok: true, version: remote.version, updatedFiles: changed.length }
    } catch (err) {
      await fs.rm(pendingDir, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function rollback(): Promise<RollbackResult> {
    const current = await readCurrent()
    if (!current) return { ok: false, error: '没有可回滚的更新（当前使用内置包）' }
    const dirs = await listVersionDirs()
    const others = dirs.filter((d) => d.version !== current.version)
    if (others.length === 0) return { ok: false, error: '没有保留上一版本，无法回滚' }
    // 取最近一个其他版本（按版本名排序取最大——版本名一般可排序）
    const target = others.sort((a, b) => b.version.localeCompare(a.version))[0]
    await writeCurrent(target.version)
    return { ok: true, version: target.version }
  }

  return { readDataFile, info, checkUpdate, update, rollback }
}
