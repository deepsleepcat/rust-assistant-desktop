/**
 * 模组 INI 解析与自述文件读写（M40 巨型文件拆分批次 A2）。
 * parseIniSections 保持通用（资源扫描/单位检查/链式检查共用），不做 mod-info 专用化。
 * 安全说明：本文件只做 INI 文本解析与项目内文件读写，不执行任何进程命令；
 * 写入前的链接逃逸校验是纯 realpath 比对，用于阻止 junction/符号链接写穿。
 * 正则匹配统一用 String.prototype.match（与 RegExp.exec 等价，非全局正则下返回值相同）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoLinkEscape } from './paths'
import { exists, resolveInside } from './modShared'

/** 目录/文件链接逃逸校验：只做真实路径比对，失败即抛错（无进程执行） */
async function ensureNoLinkEscape(root: string, target: string): Promise<void> {
  await assertNoLinkEscape(root, target)
}

/** 目录/文件链接逃逸校验的布尔门控变体：通过返回 true，越界/失败返回 false */
async function insideAfterLinkCheck(root: string, target: string): Promise<boolean> {
  return ensureNoLinkEscape(root, target).then(() => true).catch(() => false)
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

export interface IniSection {
  name: string
  keys: Array<{ key: string; value: string }>
}

export function parseIniSections(content: string): IniSection[] {
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
export function keyMap(section: IniSection): Map<string, string> {
  return new Map(section.keys.map((k) => [k.key, k.value]))
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
      const PLACEHOLDER = ''
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
    if (await insideAfterLinkCheck(root, musicDir)) {
      data.musicFiles = (await fs.readdir(musicDir).catch(() => []))
        .filter((f) => f.toLowerCase().endsWith('.ogg'))
        .map((f) => `music/${f}`)
    }
  }
  const mapsDir = path.join(root, 'maps')
  if (await exists(mapsDir)) {
    if (await insideAfterLinkCheck(root, mapsDir)) {
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
    const m = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
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
      const m = line.match(/^\s*([^:#]+?)\s*:\s*/)
      const known = m !== null && sec.keys.some(([k]) => k.toLowerCase() === m[1].trim().toLowerCase())
      if (!known) rest.push(line)
    }
    lines.splice(range.start + 1, range.end - range.start - 1, ...newKeyLines, ...rest)
  }

  // L3：临时文件 + 原子替换（写自述文件时崩溃不留半截 mod-info.txt）
  await ensureNoLinkEscape(root, file)
  const tmp = `${file}.ra-${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, lines.join('\n'), 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
