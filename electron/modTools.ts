/**
 * 模组工具（主进程）：
 * - createMod    创建模组自述文件（mod-info.txt，可选背景音乐转 ogg）
 * - createUnit   新建单位：生成最小可玩单位骨架
 * - packMod      打包模组：整目录打成 .rwmod（zip），支持清理选项
 * - checkMod     检查模组：单位完整性 + 链式检查
 * - scanOptimization / applyOptimization  优化工具（空文件/.bak/空行/注释）
 * - readModInfo / writeModInfo  自述文件读写（mod/music/maps 节）
 * - scanResources / scanUnits   项目资源扫描（补全联想 / 单位库）
 * - saveFileAsTemplate          模板制作（当前文件存为用户模板）
 *
 * 设计原则：所有路径都经过 resolveInside() 校验，绝不越出项目根目录。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import JSZip from 'jszip'
import { assertNoLinkEscape, isPathInside, normalizePath } from './paths'
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

/** 扫描/检查类文本读取上限（与 fs:readFile 的 64MB 对称）：超过返回空，调用方跳过该文件 */
const MAX_SCAN_READ_SIZE = 64 * 1024 * 1024
async function readTextLimited(file: string): Promise<string> {
  const st = await fs.stat(file).catch(() => null)
  if (!st || st.size > MAX_SCAN_READ_SIZE) return ''
  return fs.readFile(file, 'utf8').catch(() => '')
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
          // L12：节名大小写不敏感（[CORE] 也能识别），与 scanUnits 的 parseIniSections 一致
          const m = /\[core\]\s*\n([\s\S]*?)(?:\n\[|$)/i.exec(content)
          const nameMatch = m?.[1].match(/^\s*name\s*:\s*(.+?)\s*$/im)
          if (nameMatch) {
            // 去掉行内注释（骨架模板 name 后带「# 单位名…」说明），与 scanUnits 解析保持一致
            const raw = nameMatch[1].replace(/\s*#.*$/, '').trim()
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
        const core = sections.find((s) => s.name === 'core')
        if (!core) continue
        const km = keyMap(core)
        const name = km.get('name') ?? ''
        if (!name.trim()) continue
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

// ── 优化工具：清理模组内的垃圾（空文件/空文件夹/.bak/空行/注释）────────

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
      await assertNoLinkEscape(root, abs)
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
        await assertNoLinkEscape(root, abs)
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

/** 新建模组的参数 */
export interface CreateModParams {
  /** 模组英文名（目录名，如 my-mod；仅用于展示，不写入自述文件） */
  name?: string
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
  /** M8 更新链接（http/https，写入 [mod] update: 键） */
  updateUrl?: string
}

export function escapeIniComment(text: string): string {
  // 先转义字面反斜杠再转义换行：否则用户字面输入的 \n 会被读回时误还原为换行
  return text.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n')
}

/** 校验更新链接：只接受 http/https URL（主进程侧复核，渲染层不可信） */
export function isValidUpdateUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

/** 生成 mod-info.txt 内容（所有自由文本字段统一转义换行，保证单行 INI 不损坏） */
export function buildModInfo(params: CreateModParams): string {
  const lines: string[] = []
  lines.push('[mod]')
  lines.push(`title: ${escapeIniComment(params.title)}`)
  if (params.description) lines.push(`description: ${escapeIniComment(params.description)}`)
  if (params.thumbnail) lines.push(`thumbnail: ${escapeIniComment(params.thumbnail)}`)
  if (params.version) lines.push(`version: ${escapeIniComment(params.version)}`)
  if (params.author) lines.push(`author: ${escapeIniComment(params.author)}`)
  // 主进程复核更新链接格式（渲染层不可信）；非法值静默丢弃，不写脏数据
  if (params.updateUrl && isValidUpdateUrl(params.updateUrl)) lines.push(`update: ${escapeIniComment(params.updateUrl)}`)
  lines.push('minVersion: 1.15p9')
  lines.push('')
  lines.push('[music]')
  // P2：勾选了音乐/独占播放时写真实键（与 writeModInfo 行为对齐），否则保留注释模板
  if ((params.musicFiles && params.musicFiles.length > 0) || params.musicExclusive) {
    lines.push('sourceFolder: music/')
    if (params.musicExclusive) lines.push('whenUsingUnitsFromThisMod_playExclusively: true')
  } else {
    lines.push('# sourceFolder: music/')
  }
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
 * usedNames：同批导入时记录已占用的目标文件名（a.mp3 与 a.wav 都转 a.ogg 会互相覆盖，
 * 后者自动改为 a-2.ogg）。
 */
export async function transcodeToOgg(srcPath: string, destDir: string, usedNames: Set<string> = new Set()): Promise<string> {
  // 用原始大小写扩展名剥离（path.basename 的 ext 匹配区分大小写：
  // a.OGG 配 '.ogg' 会剥离失败 → base='a.OGG' → 产出 a.OGG.ogg 双后缀），
  // base 统一小写参与冲突判断与目标命名
  const ext = path.extname(srcPath).toLowerCase()
  let base = path.basename(srcPath, path.extname(srcPath)).toLowerCase()
  // 同名冲突处理：同批内（usedNames）或磁盘上已存在（用户预先放好的 ogg）都自动追加 -2/-3，
  // 绝不静默覆盖已有文件
  const destExists = async (name: string) => exists(path.join(destDir, `${name}.ogg`))
  if (usedNames.has(base) || (await destExists(base))) {
    let i = 2
    while (usedNames.has(`${base}-${i}`) || (await destExists(`${base}-${i}`))) i++
    base = `${base}-${i}`
  }
  const dest = path.join(destDir, `${base}.ogg`)
  // LOW-2：名字在转码成功后才登记（失败的转码不占用名字，同批后续同名文件不被迫 -2）
  if (ext === '.ogg') {
    // 本来就是 ogg：直接复制（L2：走临时文件 + rename，失败不留半截文件）
    const tmp = path.join(destDir, `.${base}.ogg.ra-${Date.now()}.tmp`)
    try {
      await fs.copyFile(srcPath, tmp)
      await fs.rename(tmp, dest)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    usedNames.add(base)
    return dest
  }
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法转换音频（可自行安装 ffmpeg 后重试）')
  // L4：先写临时文件再 rename——ffmpeg 中途失败不会在 music/ 留下半截损坏的 .ogg。
  // 注意：临时文件是 .tmp 扩展名，ffmpeg 无法按扩展名猜输出格式，必须显式 -f ogg
  const tmp = path.join(destDir, `.${base}.ogg.ra-${Date.now()}.tmp`)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(ffmpeg, ['-y', '-i', srcPath, '-f', 'ogg', '-c:a', 'libvorbis', '-q:a', '5', tmp], (err) => {
        if (err) reject(new Error(`音频转换失败：${err.message}`))
        else resolve()
      })
    })
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  usedNames.add(base)
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

/** 创建/补全模组自述文件（mod-info.txt）：只在项目根目录写自述文件，不创建单位或示例；已存在不覆盖 */
export async function createMod(projectRoot: string, params: CreateModParams): Promise<{ files: string[]; musicFailed: string[] }> {
  const root = resolveInside(projectRoot, '.')
  const created: string[] = []
  const musicFailed: string[] = []

  const modInfo = path.join(root, 'mod-info.txt')
  // M1：链接逃逸校验（music/ 目录可能是指向外部的 junction，转码输出不能写穿）
  await assertNoLinkEscape(root, modInfo)
  if (!(await exists(modInfo))) {
    await fs.writeFile(modInfo, buildModInfo(params), 'utf8')
    created.push('mod-info.txt')
  }

  // M6.5 背景音乐：任意格式转 ogg 进 music/（单曲失败记入失败列表并继续，不影响写自述文件）
  if (params.musicFiles && params.musicFiles.length > 0) {
    const musicDir = path.join(root, 'music')
    await assertNoLinkEscape(root, musicDir)
    await fs.mkdir(musicDir, { recursive: true })
    const usedNames = new Set<string>()
    for (const src of params.musicFiles) {
      try {
        const dest = await transcodeToOgg(src, musicDir, usedNames)
        created.push(`music/${path.basename(dest)}`)
      } catch (err) {
        musicFailed.push(`${path.basename(src)}（${err instanceof Error ? err.message : String(err)}）`)
      }
    }
  }

  return { files: created, musicFailed }
}

/** 模组自述文件内容（编辑用） */
export interface ModInfoData {
  title: string
  description?: string
  author?: string
  version?: string
  thumbnail?: string
  minVersion?: string
  /** music/ 目录下的 ogg 文件（相对路径） */
  musicFiles: string[]
  /** [music] 节：使用本模组单位时独占播放 */
  musicExclusive: boolean
  /** maps/ 目录下的 tmx 地图（相对路径） */
  mapsFiles: string[]
  /** [maps] 节：把本模组地图加入随机地图池 */
  mapsExtra: boolean
  /** M8：用户自定义的音乐目录（如 mybgm/）；未设置时为 music/，写回保留原值不覆盖 */
  musicSourceFolder?: string
  /** M8：用户自定义的地图目录（如 mymaps/） */
  mapsSourceFolder?: string
  /** M8：模组更新链接（http/https，写入 [mod] update: 键，供分享/发布时展示） */
  updateUrl?: string
}

/**
 * 解析 mod-info.txt 专用（与源文件解析不同）：
 * - 保留值内的 #（模组标题/描述可能含 #，如「我的#模组」），只把行首 # 当注释；
 * - 节名大小写不敏感（[Mod]/[MUSIC] 都能读）；
 * - 值内的字面 \n 还原为换行（description 写入时转义过）。
 */
function parseModInfoSections(content: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // 行首 # = 注释行
    if (line.startsWith('#')) continue
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      current = { name: sectionMatch[1].trim().toLowerCase(), keys: [] }
      sections.push(current)
      continue
    }
    const keyMatch = line.match(/^([^:]+):\s*(.*)$/)
    if (keyMatch && current) {
      // 值内 \n 还原：先保护「字面反斜杠+n」（写入时已把 \ 转义为 \\），
      // 再把转义换行还原，最后把保护位还原回字面 \n——避免读-写往返改内容。
      // 占位符用私有区字符（不会出现在正常文本里，也不是控制字符）
      const PLACEHOLDER = '\uE000'
      const value = keyMatch[2]
        .trim()
        .replace(/\\\\n/g, PLACEHOLDER)
        .replace(/\\n/g, '\n')
        .split(PLACEHOLDER)
        .join('\\n')
      // 键名统一小写（M2：文件里 Title:/MINVERSION: 等非规范大小写也能读写一致，不会被重置）
      current.keys.push({ key: keyMatch[1].trim().toLowerCase(), value })
    }
  }
  return sections
}

/** 解析 mod-info.txt 各节（mod / music / maps），不存在时返回 null */
export async function readModInfo(projectRoot: string): Promise<ModInfoData | null> {
  const root = resolveInside(projectRoot, '.')
  const file = path.join(root, 'mod-info.txt')
  if (!(await exists(file))) return null
  const content = await fs.readFile(file, 'utf8').catch(() => '')
  const data: ModInfoData = { title: '', musicFiles: [], musicExclusive: false, mapsFiles: [], mapsExtra: false }

  const sections = parseModInfoSections(content)
  const modSec = sections.find((s) => s.name === 'mod')
  if (modSec) {
    // 键已统一小写（M2）：取值键全部用小写形式
    const km = keyMap(modSec)
    data.title = km.get('title') ?? ''
    data.description = km.get('description')
    data.author = km.get('author')
    data.version = km.get('version')
    data.thumbnail = km.get('thumbnail')
    data.minVersion = km.get('minversion')
    data.updateUrl = km.get('update')
  }
  const musicSec = sections.find((s) => s.name === 'music')
  if (musicSec) {
    const km = keyMap(musicSec)
    // 大小写不敏感（文件里 True/TRUE 也能读，避免读-改-写把独占播放静默关掉）
    data.musicExclusive = km.get('whenusingunitsfromthismod_playexclusively')?.toLowerCase() === 'true'
    // M8：用户自定义音乐目录（如 mybgm/）必须读回，写回时保留，否则会被覆盖删除
    data.musicSourceFolder = km.get('sourcefolder')
  }
  const mapsSec = sections.find((s) => s.name === 'maps')
  if (mapsSec) {
    const km = keyMap(mapsSec)
    data.mapsExtra = km.get('addextramapsforpath')?.toLowerCase() === 'true'
    data.mapsSourceFolder = km.get('sourcefolder')
  }

  // 扫描 music/ 与 maps/ 目录（LOW-2：目录本身是指向外部的链接时不跟随，
  // 校验结果当门控——通过才列举，否则视为无音乐/地图，避免泄漏根外文件名）
  const musicDir = path.join(root, 'music')
  if (await exists(musicDir)) {
    const ok = await assertNoLinkEscape(root, musicDir).then(() => true).catch(() => false)
    if (ok) {
      data.musicFiles = (await fs.readdir(musicDir).catch(() => []))
        .filter((f) => f.toLowerCase().endsWith('.ogg'))
        .map((f) => `music/${f}`)
    }
  }
  const mapsDir = path.join(root, 'maps')
  if (await exists(mapsDir)) {
    const ok = await assertNoLinkEscape(root, mapsDir).then(() => true).catch(() => false)
    if (ok) {
      data.mapsFiles = (await fs.readdir(mapsDir).catch(() => []))
        .filter((f) => f.toLowerCase().endsWith('.tmx'))
        .map((f) => `maps/${f}`)
    }
  }
  return data
}

/** 找到 [节名] 的行区间（节头到下一个节头/文件尾；节名大小写不敏感） */
function findSectionRange(lines: string[], name: string): { start: number; end: number } | null {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(lines[i])
    if (m && m[1].trim().toLowerCase() === name) {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/**
 * 把编辑后的自述文件写回（title 必填，其余可选）。
 * 与旧版「整文件重建」不同：只原位更新 mod/music/maps 三节的已知键，
 * 其余内容（注释、自定义键、未知节、节外说明）原样保留，
 * 避免覆盖式写回把用户手改过的内容（如 sourceFolder 自定义目录）删掉。
 * 所有字段统一转义换行（\n → 字面 \n），保证单行 INI 不损坏。
 */
export async function writeModInfo(projectRoot: string, data: ModInfoData): Promise<void> {
  const root = resolveInside(projectRoot, '.')
  const file = path.join(root, 'mod-info.txt')
  const raw = await exists(file) ? await fs.readFile(file, 'utf8').catch(() => '') : ''
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : []

  // 每节要写入的已知键：value 为 null 表示「删除该键的旧行」（如音乐删光后移除 sourceFolder）
  const sections: Array<{ name: string; keys: Array<[string, string | null]> }> = [
    {
      name: 'mod',
      keys: [
        ['title', escapeIniComment(data.title)],
        ['description', data.description ? escapeIniComment(data.description) : null],
        ['author', data.author ? escapeIniComment(data.author) : null],
        ['version', data.version ? escapeIniComment(data.version) : null],
        ['thumbnail', data.thumbnail ? escapeIniComment(data.thumbnail) : null],
        ['minVersion', data.minVersion || '1.15p9'],
        // 主进程复核更新链接格式；非法值按删除处理（不写脏数据）
        ['update', data.updateUrl && isValidUpdateUrl(data.updateUrl) ? escapeIniComment(data.updateUrl) : null],
      ],
    },
    {
      name: 'music',
      keys: [
        // M8：保留用户自定义 sourceFolder（如 mybgm/）；未自定义时才按音乐是否为空写/删
        ['sourceFolder', data.musicSourceFolder ?? (data.musicFiles.length > 0 || data.musicExclusive ? 'music/' : null)],
        ['whenUsingUnitsFromThisMod_playExclusively', data.musicExclusive ? 'true' : null],
      ],
    },
    {
      name: 'maps',
      keys: [
        ['sourceFolder', data.mapsSourceFolder ?? (data.mapsFiles.length > 0 || data.mapsExtra ? 'maps/' : null)],
        ['addExtraMapsForPath', data.mapsExtra ? 'true' : null],
      ],
    },
  ]

  for (const sec of sections) {
    const range = findSectionRange(lines, sec.name)
    const newKeyLines = sec.keys.filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v as string}`)
    if (!range) {
      // 节不存在：追加到文件末尾
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      lines.push(`[${sec.name}]`, ...newKeyLines)
      continue
    }
    // 节内保留非已知键行（注释/自定义键），原位替换已知键
    const rest: string[] = []
    for (let i = range.start + 1; i < range.end; i++) {
      const line = lines[i]
      const m = /^\s*([^:#]+?)\s*:\s*/.exec(line)
      const known = m !== null && sec.keys.some(([k]) => k.toLowerCase() === m[1].trim().toLowerCase())
      if (!known) rest.push(line)
    }
    lines.splice(range.start + 1, range.end - range.start - 1, ...newKeyLines, ...rest)
  }

  await assertNoLinkEscape(root, file)
  // L3：临时文件 + 原子替换（写自述文件时崩溃不留半截 mod-info.txt）
  const tmp = `${file}.ra-${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, lines.join('\n'), 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** 新建单位：<英文名>/<英文名>.ini；已存在时直接报错，不覆盖 */
export async function createUnit(
  projectRoot: string,
  params: { name: string; displayName?: string; folder?: string },
): Promise<{ path: string }> {
  const root = resolveInside(projectRoot, '.')
  const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
  const folder = (params.folder ?? '').replace(/^\/+|\/+$/g, '')
  const rel = folder ? path.posix.join(folder, safeName, `${safeName}.ini`) : path.posix.join(safeName, `${safeName}.ini`)
  const file = resolveInside(root, rel)
  if (await exists(file)) {
    throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
  }
  // M1：链接逃逸校验（单位目录可能是指向外部的 junction）
  await assertNoLinkEscape(root, file)
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
  language?: string
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

/** 加载模板 JSON：按 key 精确匹配文件名（键名保留中文等字符，与 saveFileAsTemplate 一致），
 * 内置目录与用户模板目录依次查找；key 含路径分隔符或越界时拒绝。 */
async function loadTemplateRaw(key: string, extraDirs: string[] = []): Promise<RawTemplate | null> {
  if (!key || key.includes('/') || key.includes('\\') || key === '.' || key === '..') return null
  for (const dir of [templatesDir(), ...extraDirs]) {
    const file = path.join(dir, `${key}.json`)
    if (!isPathInside(dir, file)) return null
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as RawTemplate
    } catch {
      // 该目录没有此模板（或已损坏）：尝试下一个目录
    }
  }
  return null
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

/** 列出全部模板元数据（内置包 + 用户模板目录） */
export async function listTemplates(extraDirs: string[] = []): Promise<TemplateMeta[]> {
  const dirs = [templatesDir(), ...extraDirs]
  const metas: TemplateMeta[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const key = path.basename(f, '.json')
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as RawTemplate
        metas.push(toTemplateMeta(key, raw))
      } catch {
        // 单个模板损坏（如用户手工编辑或半截写入）不影响其它模板
        continue
      }
    }
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * 把单位源文件保存为模板（模板制作）：
 * - 以文件内容为模板 data；content 可选——传入时用该内容（当前编辑缓冲），
 *   否则读磁盘（与编辑器一致；未保存的修改也能存进模板）；
 * - 自动生成 action：name / maxHp / price 三个输入项（文件里有对应键才生成）；
 * - 写入目标目录（用户模板目录），key 取文件名（仅去除路径分隔符等非法字符，
 *   保留中文等字符，避免「坦克」「侦察车」都变成 custom-template 互相覆盖）；
 * - 目标已存在同名模板时自动追加 -2/-3 序号，绝不静默覆盖。
 */
export async function saveFileAsTemplate(
  projectRoot: string,
  filePath: string,
  templateName: string,
  destDir: string,
  content?: string,
): Promise<{ key: string }> {
  const root = resolveInside(projectRoot, '.')
  const file = resolveInside(root, filePath)
  // L-6：读取源文件前做链接逃逸校验（不能把 junction 指向的外部文件内容存成模板）
  await assertNoLinkEscape(root, file)
  const data = content ?? (await fs.readFile(file, 'utf8'))
  const base = path.basename(filePath, path.extname(filePath)).replace(/[\\/:*?"<>|]/g, '-').trim() || 'custom-template'
  const raw = buildTemplateFromFile(data, templateName)
  await fs.mkdir(destDir, { recursive: true })
  let key = base
  for (let suffix = 2; await exists(path.join(destDir, `${key}.json`)); suffix++) key = `${base}-${suffix}`
  await fs.writeFile(path.join(destDir, `${key}.json`), JSON.stringify(raw, null, 2), 'utf8')
  return { key }
}

/** 从源文件文本生成模板 JSON（纯函数，供测试）：自动提取 action 输入项 */
export function buildTemplateFromFile(content: string, templateName: string): RawTemplate {
  const data = content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  const action: RawTemplate['action'] = []
  const hasKeyInSection = (key: string, section: string) => {
    const m = new RegExp(`\\[${section}\\]\\s*\\n([\\s\\S]*?)(?:\\n\\[|$)`)
    const sec = m.exec(data)?.[1] ?? ''
    return new RegExp(`^\\s*${key}\\s*:`, 'm').test(sec)
  }
  // 与参考实现一致：name/maxHp/price 三输入项，文件里有对应键才生成
  for (const [key, label] of [['name', '名称'], ['maxHp', '血量'], ['price', '价格']] as const) {
    if (hasKeyInSection(key, 'core')) {
      action.push({ name: label, key, section: 'core', tag: `${key}-core`, type: 'input' })
    }
  }
  return { name: templateName, data, language: 'ALL', action }
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

/** 基于模板创建单位：<英文名>/<英文名>.ini（已存在报错）。
 * extraTemplateDirs：用户模板目录，让「保存为模板」制作的模板也能用来创建单位。 */
export async function createUnitFromTemplate(
  projectRoot: string,
  params: { name: string; folder?: string; templateKey: string; values: Record<string, string> },
  extraTemplateDirs: string[] = [],
): Promise<{ path: string }> {
  const root = resolveInside(projectRoot, '.')
  const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
  const folder = (params.folder ?? '').replace(/^\/+|\/+$/g, '')
  const rel = folder ? path.posix.join(folder, safeName, `${safeName}.ini`) : path.posix.join(safeName, `${safeName}.ini`)
  const file = resolveInside(root, rel)
  if (await exists(file)) {
    throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
  }
  const raw = await loadTemplateRaw(params.templateKey, extraTemplateDirs)
  if (!raw) throw new Error(`模板不存在：${params.templateKey}`)
  // M-1：与 createUnit 对齐——模板新建也做链接逃逸校验（项目内 junction 不能写穿）
  await assertNoLinkEscape(root, file)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buildFileFromTemplate(raw, params.values ?? {}), 'utf8')
  return { path: rel }
}

/** 打包选项：打包时对源文件做清理/格式化 */
export interface PackOptions {
  /** 移除空文件（源文件内容为空则不打包） */
  removeEmptyFiles?: boolean
  /** 移除空文件夹 */
  removeEmptyFolders?: boolean
  /** 源文件去除所有空行 */
  removeEmptyLines?: boolean
  /** 源文件去除 # 注释行 */
  removeComments?: boolean
  /** 源文件格式化（去行首尾空白，冒号两侧规整） */
  formatCode?: boolean
}

/** 按打包选项处理源文件文本（纯函数，供测试） */
export function processSourceForPack(content: string, options: PackOptions): string {
  let lines = content.split(/\r?\n/)
  if (options.removeEmptyLines) lines = lines.filter((l) => l.trim() !== '')
  if (options.removeComments) lines = lines.filter((l) => !l.trimStart().startsWith('#'))
  let text = lines.join('\n')
  if (options.formatCode) text = formatIniText(text)
  return text
}

/** 铁锈战争 INI 格式化：行去空白、节前留空行、key: value 规整（保留值内部空格） */
export function formatIniText(text: string): string {
  const out: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^\[.+?\]$/.test(line)) {
      // 节前留一个空行（首节除外）
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(line)
      continue
    }
    const colon = line.indexOf(':')
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      out.push(value ? `${key}: ${value}` : `${key}:`)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

/** 打包模组：整目录递归写入 zip（排除垃圾文件） */
export async function packMod(projectRoot: string, options?: PackOptions): Promise<{ size: number; files: number }> {
  const { buffer, files } = await packModBufferWithCount(projectRoot, options)
  return { size: buffer.byteLength, files }
}

/** 打包并返回 zip 二进制（供 IPC 保存用） */
export async function packModBuffer(projectRoot: string, options?: PackOptions): Promise<Buffer> {
  const { buffer } = await packModBufferWithCount(projectRoot, options)
  return buffer
}

/** 导入 .rwmod：把 zip 内容解压到目标目录。
 * 安全措施：拒绝路径穿越（zip-slip）、限制条目数与解压总量（防 zip bomb）、
 * 全部条目先校验再写盘，写盘中途失败回滚已写文件（不留半包）。 */
export async function importModBuffer(rwmodBuffer: Buffer, destDir: string): Promise<{ files: number }> {
  const zip = await JSZip.loadAsync(rwmodBuffer)
  const root = path.resolve(destDir)
  const MAX_ENTRIES = 20000
  const MAX_TOTAL = 512 * 1024 * 1024
  const MAX_SINGLE = 128 * 1024 * 1024

  const entries = Object.values(zip.files).filter((e) => !e.dir)
  if (entries.length > MAX_ENTRIES) throw new Error('导入包内文件过多（超过 20000 个），已中止导入')

  // 第一步：全部条目校验（路径 + 大小 + Windows 设备名 + 目标已存在），通过后才开始写盘
  const plans: Array<{ abs: string; content: Buffer }> = []
  let total = 0
  // LOW-3：Windows 设备名（nul/con/com1 等）不能作为导入条目——写入会静默丢数据
  const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
  for (const entry of entries) {
    const rel = entry.name.replace(/\\/g, '/').trim()
    if (!rel || rel === '.') continue // 空条目名/根目录条目：跳过
    const fileName = rel.split('/').pop() ?? rel
    if (DEVICE_NAME_RE.test(fileName)) {
      throw new Error(`导入包内包含系统保留文件名：${rel}（已中止导入）`)
    }
    // 拒绝绝对路径与 ../ 穿越
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`导入包内包含非法路径：${rel}（已中止导入）`)
    }
    // 目标已存在 → 中止（导入目标目录是新生成的，理论上不该有文件；防御 baseName
    // 极端值/TOCTOU 等场景下静默覆盖用户已有文件）
    if (await exists(abs)) {
      throw new Error(`导入目标已存在文件：${rel}（已中止导入）`)
    }
    const content = await entry.async('nodebuffer')
    if (content.byteLength > MAX_SINGLE) throw new Error(`导入包内文件过大：${rel}（超过 128MB，已中止导入）`)
    total += content.byteLength
    if (total > MAX_TOTAL) throw new Error('导入包解压后总大小超过 512MB，已中止导入')
    plans.push({ abs, content })
  }

  // 第二步：写盘（失败回滚已写文件与失败文件本身，并自底向上清空留下的空目录）
  const written: string[] = []
  try {
    for (const p of plans) {
      await fs.mkdir(path.dirname(p.abs), { recursive: true })
      await fs.writeFile(p.abs, p.content)
      written.push(p.abs)
    }
  } catch (err) {
    // L4：把「写盘失败自身留下的半截文件」也纳入回滚删除
    const failedTargets = plans.map((p) => p.abs)
    const allTargets = [...new Set([...written, ...failedTargets])]
    await Promise.all(allTargets.map((f) => fs.rm(f, { force: true }).catch(() => undefined)))
    // 删除因回滚而变空的目录（自底向上），不留半导入的空壳目录
    for (const f of allTargets) {
      let dir = path.dirname(f)
      while (dir !== root && dir.startsWith(root + path.sep)) {
        const rest = await fs.readdir(dir).catch(() => ['x'])
        if (rest.length > 0) break
        await fs.rmdir(dir).catch(() => undefined)
        dir = path.dirname(dir)
      }
    }
    throw err
  }
  return { files: written.length }
}

/** 打包并返回 zip 二进制与文件数（供 IPC 单次打包：一次打包拿全量信息，避免二次打包不一致） */
export async function packModBufferWithCount(projectRoot: string, options?: PackOptions): Promise<{ buffer: Buffer; files: number; skippedLinks: number }> {
  const root = resolveInside(projectRoot, '.')
  const zip = new JSZip()
  let fileCount = 0
  // 打包是全程内存操作（JSZip）：单文件 512MB / 总字节 2GB 上限，
  // 超限报错中止——防止数 GB 项目把主进程内存推到数倍体积导致 OOM
  const MAX_PACK_FILE_SIZE = 512 * 1024 * 1024
  const MAX_PACK_TOTAL_SIZE = 2 * 1024 * 1024 * 1024
  let totalBytes = 0
  const readForPack = async (abs: string): Promise<Buffer> => {
    const st = await fs.stat(abs).catch(() => null)
    if (!st) throw new Error(`无法读取文件：${abs}`)
    if (st.size > MAX_PACK_FILE_SIZE) throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，打包单文件上限 512MB）：${abs}`)
    if (totalBytes + st.size > MAX_PACK_TOTAL_SIZE) throw new Error('打包内容总量超过 2GB 上限，请先清理大文件再打包')
    totalBytes += st.size
    return fs.readFile(abs)
  }
  // LOW-1：指向项目外的链接不打包（跳过并计数，由 UI 提示），而不是中止整次打包
  let skippedLinks = 0
  const isSource = (name: string) => /\.(ini|template)$/i.test(name)
  // LOW-3：已打包的真实目录集合（防环形 junction：mods/units → mods 会无限递归挂死主进程）。
  // 语义：仅符号链接目录做 realpath 去重；两个链接同指一个真实目录时第二个路径跳过
  // （同一内容不重复打包，属防环设计）；普通目录从不查 visited，各自完整打包。
  const visitedDirs = new Set<string>()
  try {
    visitedDirs.add(normalizePath(await fs.realpath(root)))
  } catch {
    visitedDirs.add(normalizePath(root))
  }

  async function walk(dir: string, prefix: string): Promise<number> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    let packed = 0
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isExcluded(rel)) continue
      const abs = path.join(dir, entry.name)
      // L-8：junction/符号链接在 readdir 下 isDirectory=false、isSymbolicLink=true——
      // 按真实目标处理：根内的链接跟随打包（避免交付物静默缺内容），指向根外的拒绝
      if (entry.isSymbolicLink()) {
        const st = await fs.stat(abs).catch(() => null)
        if (!st) {
          // 悬空链接（目标已删除）：跳过并计数，UI 提示里说明（不静默缺失）
          skippedLinks++
          continue
        }
        if (st.isDirectory()) {
          // 指向项目外的链接：跳过并计数（打包继续，UI 提示），不中止整次打包
          try {
            await assertNoLinkEscape(root, abs)
          } catch {
            skippedLinks++
            continue
          }
          const real = await fs.realpath(abs).catch(() => abs)
          if (visitedDirs.has(normalizePath(real))) continue // 环形链接：已打包过，跳过
          visitedDirs.add(normalizePath(real))
          if (options?.removeEmptyFolders && (await fs.readdir(abs)).length === 0) continue
          packed += await walk(abs, rel)
        } else if (st.isFile()) {
          try {
            await assertNoLinkEscape(root, abs)
          } catch {
            skippedLinks++
            continue
          }
          zip.file(rel, await readForPack(abs))
          packed++
          fileCount++
        }
        continue
      }
      if (entry.isDirectory()) {
        // M1：目录可能是指向外部的 junction——打包不能把外部文件卷进来
        await assertNoLinkEscape(root, abs)
        // 空文件夹不会被写入 zip（JSZip 仅随文件创建目录项）
        if (options?.removeEmptyFolders && (await fs.readdir(abs)).length === 0) continue
        packed += await walk(abs, rel)
      } else if (entry.isFile()) {
        if (options?.removeEmptyFiles && isSource(entry.name)) {
          // 读取失败直接中止打包：静默打成空文件会让交付物悄悄缺内容
          const content = (await readForPack(abs)).toString('utf8')
          if (!content.trim()) continue
          zip.file(rel, processSourceForPack(content, options))
          packed++
          fileCount++
          continue
        }
        if (isSource(entry.name) && (options?.removeEmptyLines || options?.removeComments || options?.formatCode)) {
          const content = (await readForPack(abs)).toString('utf8')
          zip.file(rel, processSourceForPack(content, options))
          packed++
          fileCount++
          continue
        }
        zip.file(rel, await readForPack(abs))
        packed++
        fileCount++
      }
    }
    return packed
  }

  await walk(root, '')
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { buffer: Buffer.from(content), files: fileCount, skippedLinks }
}

/** 单位检查：name 缺失 / [core] 缺失 / name 全局重复 */
export interface ModCheckIssue {
  file: string
  level: 'error' | 'warning' | 'info'
  message: string
}

export interface ModCheckResult {
  issues: ModCheckIssue[]
  unitCount: number
  fileCount: number
}

/** 链式检查规则（public/data/chain_inspection.json） */
export interface ChainRule {
  id: string
  key?: string
  value?: string
  type: string
  list?: string
}

function dataDir(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'public', 'data'),
    path.join(__dirname, '..', 'public', 'data'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/** 加载链式检查规则（缺失时返回空数组，不阻断检查） */
export async function loadChainRules(): Promise<ChainRule[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir(), 'chain_inspection.json'), 'utf8')) as { data?: ChainRule[] }
    return raw.data ?? []
  } catch {
    return []
  }
}

interface IniSection {
  name: string
  keys: Array<{ key: string; value: string }>
}

function parseIniSections(content: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      // 节名统一小写：链式检查/单位判定/规则匹配全部大小写不敏感（[CORE]/[Core] 都能识别）
      current = { name: sectionMatch[1].toLowerCase(), keys: [] }
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

/** 提取节内的键值表 */
function keyMap(section: IniSection): Map<string, string> {
  return new Map(section.keys.map((k) => [k.key, k.value]))
}

/**
 * 对单个单位文件执行链式检查（纯函数，供测试）：
 * - @file   规则：单位文件应包含 list 中的节（缺失 → 警告）
 * - section 规则：若 value 节存在（支持 turret → turret_1 编号节），
 *   list 中的键应存在于该节（缺失 → 警告）
 * - key    规则：若 key 存在且值命中（或 @auto 表示存在即触发），
 *   list 中的键应存在；@tip(...) 在触发时输出提示
 */
export function runChainInspection(content: string, rules: ChainRule[], file: string): ModCheckIssue[] {
  const issues: ModCheckIssue[] = []
  const sections = parseIniSections(content)
  const sectionNames = new Set(sections.map((s) => s.name))

  for (const rule of rules) {
    const list = (rule.list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const tips = list.filter((s) => s.startsWith('@tip(')).map((s) => s.replace(/^@tip\((.*)\)$/, '$1'))
    const keys = list.filter((s) => !s.startsWith('@'))

    if (rule.type === '@file') {
      for (const sec of keys) {
        if (sec && !sectionNames.has(sec)) {
          issues.push({ file, level: 'warning', message: `缺少 [${sec}] 节（链式检查：单位应有此节）` })
        }
      }
      continue
    }

    if (rule.type === 'section') {
      const target = rule.value ?? ''
      // 精确节名或编号节（turret → turret_1）
      const matched = sections.filter((s) => s.name === target || s.name.startsWith(`${target}_`))
      if (matched.length === 0) continue
      for (const sec of matched) {
        const km = keyMap(sec)
        for (const k of keys) {
          if (k && !km.has(k)) {
            issues.push({ file, level: 'warning', message: `[${sec.name}] 节缺少 ${k}（链式检查：该节应包含 ${k}）` })
          }
        }
      }
      continue
    }

    if (rule.type === 'key') {
      const ruleKey = rule.key ?? ''
      for (const sec of sections) {
        const km = keyMap(sec)
        if (!km.has(ruleKey)) continue
        const actual = km.get(ruleKey) ?? ''
        // @auto：存在即触发；否则值必须匹配（如 canAttack=true）
        const triggered = rule.value === '@auto' || actual === rule.value
        if (!triggered) continue
        for (const t of tips) issues.push({ file, level: 'info', message: `[${sec.name}] ${ruleKey}: ${actual} — ${t}` })
        for (const k of keys) {
          if (k && !km.has(k)) {
            issues.push({ file, level: 'warning', message: `[${sec.name}] ${ruleKey}: ${actual} 时建议补充 ${k}` })
          }
        }
      }
    }
  }

  return issues
}

export async function checkMod(projectRoot: string): Promise<ModCheckResult> {
  const root = resolveInside(projectRoot, '.')
  const issues: ModCheckIssue[] = []
  const nameCount = new Map<string, string[]>()
  let unitCount = 0
  let fileCount = 0
  const rules = await loadChainRules()

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
    const content = await readTextLimited(path.join(root, rel))
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

    // 链式检查（对每个单位文件跑规则，追加警告）
    issues.push(...runChainInspection(content, rules, rel))
  }

  for (const [name, files] of nameCount) {
    if (files.length > 1) {
      issues.push({ file: files.join('、'), level: 'error', message: `单位名「${name}」重复（全局唯一）：${files.length} 处` })
    }
  }

  return { issues, unitCount, fileCount }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

