/**
 * 中文翻译损坏恢复（M40 巨型文件拆分批次 A3）：
 * 先扫描预览（只读），再按 SHA-256 摘要确认写回；
 * 每个候选都做真实路径/链接逃逸校验，写回用临时文件 + 原子替换。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { assertNoLinkEscape } from './paths'
import { repairIniContent, type TranslationRepairChange, type TranslationRepairDictionary } from '../src/services/translationRepair'
import { MAX_SCAN_READ_SIZE, resolveInside } from './modShared'
import { isExcluded } from './modScan'

const MAX_TRANSLATION_REPAIR_FILES = 10000
const MAX_TRANSLATION_REPAIR_RESULTS = 1000
const MAX_TRANSLATION_REPAIR_DEPTH = 64
const MAX_PREVIEW_CHANGES_PER_FILE = 120

export interface TranslationRepairPreview {
  path: string
  digest: string
  changeCount: number
  changes: TranslationRepairChange[]
}

export interface TranslationRepairScanResult {
  files: TranslationRepairPreview[]
  scanned: number
  skipped: number
  truncated: boolean
}

export interface TranslationRepairSelection {
  path: string
  digest: string
}

export interface TranslationRepairApplyResult {
  done: number
  skipped: number
  failed: number
  changedPaths: string[]
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function isRepairSourceFile(name: string): boolean {
  return /\.(ini|template)$/i.test(name)
}

export function normalizeRepairRelativePath(value: string): string {
  if (!value || value.length > 1024 || value.includes('\0') || path.isAbsolute(value)) throw new Error('修复文件路径无效')
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('修复文件路径无效')
  return normalized
}

async function readRepairText(file: string): Promise<{ content: string; digest: string } | null> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || !stat.isFile() || stat.size > MAX_SCAN_READ_SIZE) return null
  const buffer = await fs.readFile(file).catch(() => null)
  if (!buffer) return null
  const content = buffer.toString('utf8')
  // 只改写可无损往返 UTF-8 的文本，避免把旧编码文件错误转码。
  if (!Buffer.from(content, 'utf8').equals(buffer)) return null
  return { content, digest: sha256(buffer) }
}

/**
 * 扫描项目中的 .ini/.template，生成只读预览。目录链接和隐藏目录不跟随，
 * 每个候选都做真实路径校验；达到扫描预算时显式返回 truncated。
 */
export async function scanTranslationRepair(projectRoot: string, dict: TranslationRepairDictionary): Promise<TranslationRepairScanResult> {
  const root = resolveInside(projectRoot, '.')
  const files: TranslationRepairPreview[] = []
  let scanned = 0
  let skipped = 0
  let truncated = false

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (truncated) return
    if (depth > MAX_TRANSLATION_REPAIR_DEPTH) {
      truncated = true
      return
    }
    const dirStat = await fs.lstat(dir).catch(() => null)
    if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      skipped++
      return
    }
    try {
      await assertNoLinkEscape(root, dir)
    } catch {
      skipped++
      return
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) {
      skipped++
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.name.startsWith('.') || isExcluded(rel)) continue
      if (++scanned > MAX_TRANSLATION_REPAIR_FILES || files.length >= MAX_TRANSLATION_REPAIR_RESULTS) {
        truncated = true
        return
      }
      const abs = resolveInside(root, rel)
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat || stat.isSymbolicLink()) {
        skipped++
        continue
      }
      try {
        await assertNoLinkEscape(root, abs)
      } catch {
        skipped++
        continue
      }
      if (stat.isDirectory()) {
        await walk(abs, rel, depth + 1)
        continue
      }
      if (!stat.isFile() || !isRepairSourceFile(entry.name)) continue
      const source = await readRepairText(abs)
      if (!source) {
        skipped++
        continue
      }
      const repaired = repairIniContent(source.content, dict)
      if (repaired.changes.length === 0) continue
      files.push({
        path: rel,
        digest: source.digest,
        changeCount: repaired.changes.length,
        changes: repaired.changes.slice(0, MAX_PREVIEW_CHANGES_PER_FILE),
      })
    }
  }

  await walk(root, '', 0)
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
  return { files, scanned, skipped, truncated }
}

/**
 * 对用户从扫描预览中选定的文件执行恢复。每项写入前都重新读取并核对 SHA-256，
 * 扫描后被其它工具修改的文件会跳过，不会覆盖新内容。
 */
export interface TrustedProjectRoot {
  readonly rootPath: string
  resolve(relativePath: string): string
}

export function makeTrustedProjectRoot(projectRoot: string): TrustedProjectRoot {
  const root = resolveInside(projectRoot, '.')
  return Object.freeze({
    rootPath: root,
    resolve(relativePath: string) {
      const normalized = normalizeRepairRelativePath(relativePath)
      return resolveInside(root, normalized)
    },
  })
}

export async function processRepairSelections(
  projectRoot: TrustedProjectRoot,
  dict: TranslationRepairDictionary,
  selections: TranslationRepairSelection[],
): Promise<TranslationRepairApplyResult> {
  if (!projectRoot || typeof projectRoot.resolve !== 'function') throw new Error('项目目录信任凭据无效')
  if (!Array.isArray(selections) || selections.length > MAX_TRANSLATION_REPAIR_RESULTS) throw new Error('修复选择无效')
  const picked = new Map<string, string>()
  for (const selection of selections) {
    if (!selection || typeof selection.path !== 'string' || typeof selection.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(selection.digest)) {
      throw new Error('修复选择无效')
    }
    const rel = normalizeRepairRelativePath(selection.path)
    if (!isRepairSourceFile(rel)) throw new Error('修复文件类型无效')
    picked.set(rel, selection.digest.toLowerCase())
  }

  let done = 0
  let skipped = 0
  let failed = 0
  const changedPaths: string[] = []
  for (const [rel, digest] of [...picked.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
    let temp = ''
    try {
      const abs = projectRoot.resolve(rel)
      const stat = await fs.lstat(abs)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        skipped++
        continue
      }
      await assertNoLinkEscape(projectRoot.rootPath, abs)
      const source = await readRepairText(abs)
      if (!source || source.digest !== digest) {
        skipped++
        continue
      }
      const repaired = repairIniContent(source.content, dict)
      if (repaired.changes.length === 0) {
        skipped++
        continue
      }
      // 写前再读取一次，将外部修改窗口缩小到原子 rename 前的最小范围。
      const verified = await readRepairText(abs)
      if (!verified || verified.digest !== digest) {
        skipped++
        continue
      }
      await assertNoLinkEscape(projectRoot.rootPath, path.dirname(abs))
      temp = path.join(path.dirname(abs), `.${path.basename(abs)}.ra-${randomUUID()}.tmp`)
      await fs.writeFile(temp, repaired.content, 'utf8')
      await fs.rename(temp, abs)
      done++
      changedPaths.push(rel)
    } catch {
      failed++
    } finally {
      if (temp) await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }
  return { done, skipped, failed, changedPaths }
}
