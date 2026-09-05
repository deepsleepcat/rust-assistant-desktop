/**
 * 优化与全局批处理工具（M40 巨型文件拆分批次 A6）：
 * - scanOptimization / applyOptimization  空文件/.bak/空行/注释清理
 * - globalOp                              整模组源文件批量替换/附加
 * 写回统一走「临时文件 + 原子重命名」，写入前做链接逃逸校验。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoLinkEscape } from './paths'
import { readTextLimited, resolveInside } from './modShared'
import { isExcluded } from './modScan'

export interface OptimizeItem {
  id: string
  kind: 'emptyFile' | 'emptyFolder' | 'backupFile' | 'emptyLine' | 'comment'
  rel: string
  /** 说明（如空行数、注释行数） */
  detail?: string
}

/** 文本文件类型（空行/注释优化只处理这些） */
const TEXT_EXT_RE = /\.(ini|template|txt|json|properties)$/i

/**
 * 扫描可优化项（纯文件逻辑，供 UI 展示与测试）：
 * - emptyFile  空 .ini/.txt 文件
 * - emptyFolder 空文件夹（递归）
 * - backupFile .bak 备份文件
 * - emptyLine  含空行的文本文件（detail 记录条数）
 * - comment    含 # 注释行的文本文件（detail 记录条数）
 *
 * id 使用「类型:相对路径」的稳定标识（不是序号），
 * 避免跨项目时两个项目的同一序号项互相误匹配。
 */
export async function scanOptimization(projectRoot: string): Promise<OptimizeItem[]> {
  const root = resolveInside(projectRoot, '.')
  const items: OptimizeItem[] = []
  const idOf = (kind: OptimizeItem['kind'], rel: string) => `${kind}:${rel}`

  async function walk(dir: string, prefix: string): Promise<number> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    let childCount = 0
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const sub = await walk(abs, rel)
        // 空文件夹 = 目录内没有任何条目（含被排除文件，与执行端判定一致）
        const realEntries = await fs.readdir(abs).catch(() => ['x'])
        if (realEntries.length === 0) {
          items.push({ id: idOf('emptyFolder', rel), kind: 'emptyFolder', rel })
        }
        childCount += sub
      } else if (entry.isFile()) {
        childCount++
        if (/\.bak$/i.test(entry.name)) {
          items.push({ id: idOf('backupFile', rel), kind: 'backupFile', rel })
          continue
        }
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat) continue // 单个文件不可读时跳过，不让整个扫描失败
        if (stat.size === 0) {
          items.push({ id: idOf('emptyFile', rel), kind: 'emptyFile', rel })
          continue
        }
        if (TEXT_EXT_RE.test(entry.name)) {
          const content = await readTextLimited(abs)
          const lines = content.split(/\r?\n/)
          const emptyLines = lines.filter((l) => !l.trim()).length
          if (emptyLines > 0) items.push({ id: idOf('emptyLine', rel), kind: 'emptyLine', rel, detail: `${emptyLines} 行` })
          const commentLines = lines.filter((l) => l.trimStart().startsWith('#')).length
          if (commentLines > 0) items.push({ id: idOf('comment', rel), kind: 'comment', rel, detail: `${commentLines} 行` })
        }
      }
    }
    return childCount
  }

  await walk(root, '')
  return items
}

/**
 * 执行优化：删除空文件/备份文件，重写文本文件去除空行与注释。
 * 只处理传入 id 对应的项（id = 「类型:相对路径」稳定标识，防跨项目误匹配）；
 * 仅当勾选了「会删除文件/文件夹」的项（空文件/备份文件/空文件夹）时，
 * 收尾才自底向上清理空目录（含因删除文件而变空的父目录）；
 * 只勾选空行/注释（纯重写，不会让目录变空）时不做目录清理。
 * 每项独立 try/catch，单项失败不阻断。
 */
export async function applyOptimization(projectRoot: string, ids: string[]): Promise<{ done: number; failed: number }> {
  const root = resolveInside(projectRoot, '.')
  const all = await scanOptimization(root)
  const picked = all.filter((i) => ids.includes(i.id))
  const wantPrune = picked.some((i) => i.kind === 'emptyFile' || i.kind === 'backupFile' || i.kind === 'emptyFolder')
  let done = 0
  let failed = 0

  for (const item of picked) {
    try {
      const abs = resolveInside(root, item.rel)
      // M1：链接逃逸校验（优化涉及删除/重写，junction 目录下的文件不能越界操作）
      await assertNoLinkEscape(projectRoot, abs)
      if (item.kind === 'emptyFile' || item.kind === 'backupFile') {
        await fs.rm(abs, { force: true })
        done++
      } else if (item.kind === 'emptyFolder') {
        // 目录为空才删（扫描时已确认；防执行前被写入内容）
        const rest = await fs.readdir(abs).catch(() => ['x'])
        if (rest.length === 0) {
          await fs.rmdir(abs)
          done++
        }
      } else if (item.kind === 'emptyLine' || item.kind === 'comment') {
        // 执行端同样限 64MB（扫描后文件可能被外部改大；超限跳过该项，绝不空写截断）
        const content = await readTextLimited(abs)
        if (!content) {
          failed++
          continue
        }
        const lines = content.split(/\r?\n/)
        const out = item.kind === 'emptyLine' ? lines.filter((l) => l.trim() !== '') : lines.filter((l) => !l.trimStart().startsWith('#'))
        // L9：临时文件 + 原子替换，避免中途崩溃留下半截文件（与 fs:writeFile 一致）
        const tmp = `${abs}.ra-${Date.now()}.tmp`
        try {
          await fs.writeFile(tmp, out.join('\n'), 'utf8')
          await fs.rename(tmp, abs)
        } catch (err) {
          await fs.rm(tmp, { force: true }).catch(() => undefined)
          throw err
        }
        done++
      }
    } catch {
      failed++
    }
  }

  // 勾选了删除类项时：自底向上删除所有空目录（含因删文件而变空的父目录）
  if (wantPrune) {
    async function prune(dir: string): Promise<boolean> {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (isExcluded(entry.name)) continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory() && (await prune(abs))) {
          await fs.rmdir(abs).catch(() => {})
        }
      }
      const rest = await fs.readdir(dir).catch(() => ['x'])
      return rest.length === 0
    }
    await prune(root)
  }

  return { done, failed }
}

/** 全局操作（对整个模组的源文件批量处理）：替换文本 / 头部附加 / 尾部附加 */
export type GlobalOpKind = 'replace' | 'prepend' | 'append'
export interface GlobalOpParams {
  kind: GlobalOpKind
  /** replace：被替换的文本（必填） */
  find?: string
  /** replace：替换为的文本；prepend/append：附加的文本（必填） */
  text?: string
}
export interface GlobalOpResult {
  files: number
  changed: number
  skipped: number
}

/** 全局操作：递归处理全部 .ini/.template 源文件，每文件独立失败不阻断。
 * 只替换/附加文本内容，不改变文件结构；单文件超 64MB 跳过计数（防 OOM）。 */
export async function globalOp(projectRoot: string, params: GlobalOpParams): Promise<GlobalOpResult> {
  const root = resolveInside(projectRoot, '.')
  const kind = params.kind
  if (kind !== 'replace' && kind !== 'prepend' && kind !== 'append') throw new Error('不支持的操作类型')
  const find = params.find ?? ''
  const text = params.text ?? ''
  if (kind === 'replace' && !find) throw new Error('替换操作需要提供被替换的文本')
  if (kind !== 'replace' && !text) throw new Error('附加操作需要提供文本内容')

  let files = 0
  let changed = 0
  let skipped = 0

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue
      const abs = path.join(dir, entry.name)
      // 链接目录不跟随（与扫描一致）：避免越界写入
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!/\.(ini|template)$/i.test(entry.name)) continue
      files++
      try {
        // 写入前链接逃逸校验（junction 目录内的文件不能越界操作）
        await assertNoLinkEscape(projectRoot, abs)
        const content = await readTextLimited(abs)
        if (!content) {
          // 空文件/超限：超限（stat > 64MB）跳过；空文件对附加操作等于直接写入 text
          if (kind === 'prepend' || kind === 'append') {
            const next = kind === 'prepend' ? text : text
            const tmp = `${abs}.ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
            try {
              await fs.writeFile(tmp, next, 'utf8')
              await fs.rename(tmp, abs)
              changed++
            } catch {
              await fs.rm(tmp, { force: true }).catch(() => undefined)
              skipped++
            }
          } else {
            skipped++
          }
          continue
        }
        const next = kind === 'replace'
          ? content.split(find).join(text) // 全局替换（split/join 比 replaceAll 更稳，无正则转义问题）
          : kind === 'prepend'
            ? text + content
            : content + text
        if (next === content) continue // 无变化：不写盘
        // 原子写：临时文件 + 重命名（与 fs:writeFile 一致）
        const tmp = `${abs}.ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
        try {
          await fs.writeFile(tmp, next, 'utf8')
          await fs.rename(tmp, abs)
          changed++
        } catch (err) {
          await fs.rm(tmp, { force: true }).catch(() => undefined)
          throw err
        }
      } catch {
        skipped++
      }
    }
  }
  await walk(root)
  return { files, changed, skipped }
}
