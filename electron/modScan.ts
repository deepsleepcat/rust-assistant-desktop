/**
 * 项目资源/单位扫描（M40 巨型文件拆分批次 A4）：
 * - PACK_EXCLUDE_PATTERNS / isExcluded  打包与扫描共用的垃圾文件排除规则
 * - scanResources  项目资源扫描（编辑器补全联想）
 * - scanUnits      单位库扫描（[core]/[graphics] 概要）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { keyMap, parseIniSections } from './modIni'
import { readTextLimited, resolveInside } from './modShared'

/** 打包时排除的垃圾文件/目录（按相对路径匹配） */
export const PACK_EXCLUDE_PATTERNS: string[] = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'dist-electron',
  'out',
  '.vite',
  'Thumbs.db',
  '.DS_Store',
  'desktop.ini',
  '*.tmp',
  '*.ai-*.tmp',
]

/** 检查单个相对路径是否应被打包排除 */
export function isExcluded(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  return parts.some((part) =>
    PACK_EXCLUDE_PATTERNS.some((pat) => pat === part || (pat.startsWith('*') && part.endsWith(pat.slice(1)))),
  )
}

/**
 * 扫描项目资源（供编辑器补全）：
 * - files：全部文件相对路径（posix 风格），按扩展名过滤用；
 * - unitNames：所有 .ini/.template 源文件 [core] 节 name: 值（单位名联想）。
 */
export async function scanResources(projectRoot: string): Promise<{ files: string[]; unitNames: string[] }> {
  const root = resolveInside(projectRoot, '.')
  const files: string[] = []
  const unitNames = new Set<string>()

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isExcluded(rel)) continue
      // L2 语义声明：junction/符号链接目录（isSymbolicLink=true、isDirectory=false）
      // 会被静默跳过——扫描类工具不跟随链接（与打包的显式跟随不同，避免链接指向
      // 根外时的信息泄漏面）；需要跟随链接内容的用户应把目录复制进项目。
      if (entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else if (entry.isFile()) {
        files.push(rel)
        if (/\.(ini|template)$/i.test(entry.name)) {
          const content = await readTextLimited(abs)
          // 单位判定与解析统一走 parseIniSections（节名小写）：
          // [core]/[CORE]/[核心] 都识别（L12 + 中文显示层），行尾注释容忍
          const sections = parseIniSections(content)
          const core = sections.find((s) => s.name === 'core' || s.name === '核心')
          if (core) {
            const nameEntry = core.keys.find((k) => k.key.toLowerCase() === 'name')
            // 去掉行内注释（骨架模板 name 后带「# 单位名…」说明）
            const raw = nameEntry?.value.replace(/\s*#.*$/, '').trim()
            if (raw) unitNames.add(raw)
          }
        }
      }
    }
  }
  await walk(root, '')
  return { files, unitNames: [...unitNames] }
}

/** 单位库条目：从源文件解析出的单位概要 */
export interface UnitEntry {
  path: string
  name: string
  description?: string
  image?: string
  modified: number
}

/** 扫描项目内全部单位（.ini/.template 源文件，解析 [core]/[graphics] 概要），供单位库浏览 */
export async function scanUnits(projectRoot: string): Promise<UnitEntry[]> {
  const root = resolveInside(projectRoot, '.')
  const units: UnitEntry[] = []

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else if (entry.isFile() && /\.(ini|template)$/i.test(entry.name)) {
        const content = await readTextLimited(abs)
        const sections = parseIniSections(content)
        const core = sections.find((s) => s.name === 'core' || s.name === '核心')
        if (!core) continue
        // 键名大小写不敏感（引擎同）：与 scanResources/checkMod 的 name 提取一致
        const name = core.keys.find((k) => k.key.toLowerCase() === 'name')?.value ?? ''
        if (!name.trim()) continue
        const km = keyMap(core)
        const graphics = sections.find((s) => s.name === 'graphics')
        const stat = await fs.stat(abs).catch(() => ({ mtimeMs: 0 }))
        units.push({
          path: rel,
          name: name.trim(),
          description: km.get('displayDescription') || km.get('description'),
          image: graphics ? keyMap(graphics).get('image') : undefined,
          modified: stat.mtimeMs,
        })
      }
    }
  }
  await walk(root, '')
  return units.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}
