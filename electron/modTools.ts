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
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import JSZip from 'jszip'
import { isPathInside } from './paths'
import type { TemplateAction, TemplateMeta } from '../src/types/mod'

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
  /** M6.5 背景音乐：用户选择的源音频绝对路径列表（任意格式，转 ogg 后进 music/） */
  musicFiles?: string[]
  /** M6.5 使用本模组单位时独占播放（写入 [music] 节） */
  musicExclusive?: boolean
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

/**
 * 把任意音频转成 ogg（背景音乐用）。优先用 ffmpeg-static（随应用打包），
 * 找不到时退回系统 PATH 的 ffmpeg。失败抛错，由调用方降级提示。
 */
export async function transcodeToOgg(srcPath: string, destDir: string): Promise<string> {
  const ext = path.extname(srcPath).toLowerCase()
  const base = path.basename(srcPath, ext)
  const dest = path.join(destDir, `${base}.ogg`)
  if (ext === '.ogg') {
    // 本来就是 ogg：直接复制
    await fs.copyFile(srcPath, dest)
    return dest
  }
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法转换音频（可自行安装 ffmpeg 后重试）')
  await new Promise<void>((resolve, reject) => {
    execFile(ffmpeg, ['-y', '-i', srcPath, '-c:a', 'libvorbis', '-q:a', '5', dest], (err) => {
      if (err) reject(new Error(`音频转换失败：${err.message}`))
      else resolve()
    })
  })
  return dest
}

function findFfmpeg(): Promise<string | null> {
  return new Promise((resolve) => {
    // 1) ffmpeg-static（随应用打包）
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const staticPath = require('ffmpeg-static') as string | null
      if (staticPath && existsSync(staticPath)) return resolve(staticPath)
    } catch {
      /* 未安装 ffmpeg-static */
    }
    // 2) 系统 PATH
    execFile('ffmpeg', ['-version'], (err) => resolve(err ? null : 'ffmpeg'))
  })
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

  // M6.5 背景音乐：任意格式转 ogg 进 music/（转换失败时跳过并继续，不影响建模组）
  if (params.musicFiles && params.musicFiles.length > 0) {
    const musicDir = path.join(root, 'music')
    await fs.mkdir(musicDir, { recursive: true })
    for (const src of params.musicFiles) {
      try {
        const dest = await transcodeToOgg(src, musicDir)
        created.push(`music/${path.basename(dest)}`)
      } catch {
        // 单曲失败不阻断整个模组创建，文件列表里不包含即可
      }
    }
  }

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

// ── M6.5 模板系统（移植手机版 baseTemplate_v2.0）────────────────

/** 原始模板 JSON 结构（public/data/templates/*.json） */
export interface RawTemplate {
  name?: string
  name_en?: string
  data?: string
  action?: Array<{ name?: string; key?: string; section?: string; tag?: string; type?: string }>
}

function templatesDir(): string {
  // 编译后 __dirname = dist-electron/electron（两级到项目根）；
  // vitest 直跑源码 __dirname = electron/（一级到项目根）。两个都试。
  const candidates = [
    path.join(__dirname, '..', '..', 'public', 'data', 'templates'),
    path.join(__dirname, '..', 'public', 'data', 'templates'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

async function loadTemplateRaw(key: string): Promise<RawTemplate | null> {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '')
  const file = path.join(templatesDir(), `${safe}.json`)
  if (!isPathInside(templatesDir(), file)) return null
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as RawTemplate
  } catch {
    return null
  }
}

/** 从模板 data 文本提取 [section] 节的 key 当前值 */
function extractDefaults(data: string | undefined, actions: TemplateAction[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!data) return out
  let current = ''
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      current = sectionMatch[1]
      continue
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/)
    if (kv) {
      const key = kv[1].trim()
      const action = actions.find((a) => a.key === key && a.section === current)
      if (action && out[action.tag] === undefined) out[action.tag] = kv[2].trim()
    }
  }
  return out
}

function toTemplateMeta(key: string, raw: RawTemplate): TemplateMeta {
  const actions: TemplateAction[] = (raw.action ?? []).map((a) => ({
    label: a.name ?? a.key ?? '',
    key: a.key ?? '',
    section: a.section ?? '',
    tag: a.tag ?? '',
    type: a.type ?? 'input',
  }))
  return {
    key,
    name: raw.name ?? key,
    nameEn: raw.name_en ?? '',
    actions,
    defaults: extractDefaults(raw.data, actions),
  }
}

/** 列出全部模板元数据（主进程读 public/data/templates/*.json） */
export async function listTemplates(): Promise<TemplateMeta[]> {
  const dir = templatesDir()
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const metas: TemplateMeta[] = []
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as RawTemplate
    metas.push(toTemplateMeta(path.basename(f, '.json'), raw))
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/** 用用户输入替换模板 data 中对应 [section] 节的 key 值（未填的保留默认） */
export function buildFileFromTemplate(raw: RawTemplate, values: Record<string, string>): string {
  const data = raw.data ?? ''
  let current = ''
  return data
    .split(/\r?\n/)
    .map((line) => {
      const sectionMatch = line.match(/^\[(.+)\]$/)
      if (sectionMatch) {
        current = sectionMatch[1]
        return line
      }
      // 跳过注释/节外行；只替换模板声明的字段
      if (line.trim().startsWith('#') || !line.trim()) return line
      const kv = line.match(/^(\s*)([^#:]+?)\s*:\s*(.*)$/)
      if (!kv) return line
      const key = kv[2].trim()
      const action = (raw.action ?? []).find((a) => a.key === key && a.section === current)
      const input = action?.tag ? values[action.tag] : undefined
      if (action && input !== undefined && String(input).trim() !== '') {
        return `${kv[1]}${key}: ${String(input).trim()}`
      }
      return line
    })
    .join('\n')
}

/** 基于模板创建单位：units/<英文名>/<英文名>.ini（已存在报错） */
export async function createUnitFromTemplate(
  projectRoot: string,
  params: { name: string; folder?: string; templateKey: string; values: Record<string, string> },
): Promise<{ path: string }> {
  const root = resolveInside(projectRoot, '.')
  const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
  const folder = (params.folder ?? 'units').replace(/^\/+|\/+$/g, '')
  const rel = path.posix.join(folder, safeName, `${safeName}.ini`)
  const file = resolveInside(root, rel)
  if (await exists(file)) {
    throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
  }
  const raw = await loadTemplateRaw(params.templateKey)
  if (!raw) throw new Error(`模板不存在：${params.templateKey}`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buildFileFromTemplate(raw, params.values ?? {}), 'utf8')
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

