/**
 * M5 模组工具（主进程）：
 * - createMod    新建模组：生成 mod-info.txt + units/ 目录 + 示例单位
 * - createUnit   新建单位：生成最小可玩单位骨架（4 个节）
 * - packMod      打包模组：整目录打成 .rwmod（zip），自动排除垃圾文件
 * - checkMod     检查模组：扫描 units 下所有单位 ini 的完整性
 *
 * 设计原则：所有路径都经过 resolveInside() 校验，绝不越出项目根目录。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { isPathInside } from './paths'

/** 把相对路径解析为项目内绝对路径（越界抛错） */
function resolveInside(projectRoot: string, rel: string): string {
  const normalized = String(rel).replace(/^\/+/, '').replace(/\//g, path.sep)
  const abs = path.resolve(projectRoot, normalized)
  if (!isPathInside(projectRoot, abs)) throw new Error('路径超出项目目录范围')
  return abs
}

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

/** 新建模组的参数 */
export interface CreateModParams {
  /** 模组英文名（目录名，如 my-mod） */
  name: string
  title: string
  description?: string
  author?: string
  version?: string
  /** 缩略图相对路径（可选） */
  thumbnail?: string
}

function escapeIniComment(text: string): string {
  return text.replace(/\r?\n/g, '\\n')
}

/** 生成 mod-info.txt 内容 */
export function buildModInfo(params: CreateModParams): string {
  const lines: string[] = []
  lines.push('[mod]')
  lines.push(`title: ${params.title}`)
  if (params.description) lines.push(`description: ${escapeIniComment(params.description)}`)
  if (params.thumbnail) lines.push(`thumbnail: ${params.thumbnail}`)
  if (params.version) lines.push(`version: ${params.version}`)
  if (params.author) lines.push(`author: ${params.author}`)
  lines.push('minVersion: 1.15p9')
  lines.push('')
  lines.push('[music]')
  lines.push('# sourceFolder: music/')
  lines.push('# whenUsingUnitsFromThisMod_playExclusively: true')
  lines.push('')
  lines.push('[maps]')
  lines.push('# sourceFolder: maps/')
  lines.push('# addExtraMapsForPath: true')
  lines.push('')
  return lines.join('\n')
}

/** 最小可玩单位骨架（4 个节，注释为中文） */
export function buildUnitSkeleton(name: string, displayName?: string): string {
  const label = displayName && displayName.trim() ? displayName.trim() : name
  return `[core]
name: ${label}        # 单位名，全模组唯一！引用它就用这个名字
maxHp: 100
mass: 1
price: 100
radius: 10
tags: 示例

[graphics]
image: ${name}.png
image_wreak: ${name}_wreck.png
total_frames: 1
image_shadow: AUTO

[attack]
[projectile_1]
directDamage: 10
life: 5
speed: 200

[movement]
movementType: LAND     # NONE/LAND/BUILDING/AIR/WATER/HOVER/OVER_CLIFF...
moveSpeed: 50
`
}

/** 新建模组：在项目根目录生成标准结构；已存在内容时不覆盖 */
export async function createMod(projectRoot: string, params: CreateModParams): Promise<{ files: string[] }> {
  const root = resolveInside(projectRoot, '.')
  const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'my-mod'
  const created: string[] = []

  const modInfo = path.join(root, 'mod-info.txt')
  if (!(await exists(modInfo))) {
    await fs.writeFile(modInfo, buildModInfo({ ...params, name: safeName }), 'utf8')
    created.push('mod-info.txt')
  }

  const unitsDir = path.join(root, 'units')
  await fs.mkdir(unitsDir, { recursive: true })
  created.push('units/')

  // 示例单位：展示最小骨架（不会覆盖已有同名文件）
  const examplePath = path.join(unitsDir, safeName, `${safeName}.ini`)
  if (!(await exists(examplePath))) {
    await fs.mkdir(path.dirname(examplePath), { recursive: true })
    await fs.writeFile(examplePath, buildUnitSkeleton(safeName, params.title), 'utf8')
    created.push(`units/${safeName}/${safeName}.ini`)
  }

  return { files: created }
}

/** 新建单位：units/<英文名>/<英文名>.ini；已存在时直接报错，不覆盖 */
export async function createUnit(
  projectRoot: string,
  params: { name: string; displayName?: string; folder?: string },
): Promise<{ path: string }> {
  const root = resolveInside(projectRoot, '.')
  const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
  const folder = (params.folder ?? 'units').replace(/^\/+|\/+$/g, '')
  const rel = path.posix.join(folder, safeName, `${safeName}.ini`)
  const file = resolveInside(root, rel)
  if (await exists(file)) {
    throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buildUnitSkeleton(safeName, params.displayName), 'utf8')
  return { path: rel }
}

/** 打包模组：整目录递归写入 zip（排除垃圾文件） */
export async function packMod(projectRoot: string): Promise<{ size: number; files: number }> {
  const { buffer, files } = await packModBufferWithCount(projectRoot)
  return { size: buffer.byteLength, files }
}

/** 打包并返回 zip 二进制（供 IPC 保存用） */
export async function packModBuffer(projectRoot: string): Promise<Buffer> {
  const { buffer } = await packModBufferWithCount(projectRoot)
  return buffer
}

async function packModBufferWithCount(projectRoot: string): Promise<{ buffer: Buffer; files: number }> {
  const root = resolveInside(projectRoot, '.')
  const zip = new JSZip()
  let fileCount = 0

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isExcluded(rel)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else if (entry.isFile()) {
        zip.file(rel, await fs.readFile(abs))
        fileCount++
      }
    }
  }

  await walk(root, '')
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { buffer: Buffer.from(content), files: fileCount }
}

/** 单位检查：name 缺失 / [core] 缺失 / name 全局重复 */
export interface ModCheckIssue {
  file: string
  level: 'error' | 'warning'
  message: string
}

export interface ModCheckResult {
  issues: ModCheckIssue[]
  unitCount: number
  fileCount: number
}

export async function checkMod(projectRoot: string): Promise<ModCheckResult> {
  const root = resolveInside(projectRoot, '.')
  const issues: ModCheckIssue[] = []
  const nameCount = new Map<string, string[]>()
  let unitCount = 0
  let fileCount = 0

  const iniFiles: string[] = []
  async function collect(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await collect(path.join(dir, entry.name), rel)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ini')) {
        iniFiles.push(rel)
        fileCount++
      }
    }
  }
  await collect(root, '')

  for (const rel of iniFiles) {
    const content = await fs.readFile(path.join(root, rel), 'utf8').catch(() => '')
    const sections = parseIniSections(content)
    const isUnit = sections.some((s) => s.name === 'core' || /^\[?core\]?$/.test(s.name))
    if (!isUnit) continue

    unitCount++
    const nameValue = sections.find((s) => s.name === 'core')?.keys.find((k) => k.key === 'name')?.value
    if (!nameValue) {
      issues.push({ file: rel, level: 'error', message: `缺少 [core] name:（单位名必填）` })
      continue
    }
    const list = nameCount.get(nameValue) ?? []
    list.push(rel)
    nameCount.set(nameValue, list)
  }

  for (const [name, files] of nameCount) {
    if (files.length > 1) {
      issues.push({ file: files.join('、'), level: 'error', message: `单位名「${name}」重复（全局唯一）：${files.length} 处` })
    }
  }

  return { issues, unitCount, fileCount }
}

function parseIniSections(content: string): Array<{ name: string; keys: Array<{ key: string; value: string }> }> {
  const sections: Array<{ name: string; keys: Array<{ key: string; value: string }> }> = []
  let current: { name: string; keys: Array<{ key: string; value: string }> } | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      current = { name: sectionMatch[1], keys: [] }
      sections.push(current)
      continue
    }
    const keyMatch = line.match(/^([^:]+):\s*(.*)$/)
    if (keyMatch && current) {
      current.keys.push({ key: keyMatch[1].trim(), value: keyMatch[2].trim() })
    }
  }
  return sections
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

