/**
 * 游戏集成（M8）：检测铁锈战争安装目录、导入官方单位示例、导入游戏内已装模组。
 * 游戏目录只是只读数据源，不登记为项目根；导入目标目录才会登记信任锚。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertNoLinkEscape, isPathInside, normalizePath } from './paths'
import { checkMod, escapeIniComment, isExcluded } from './modTools'

const execFileAsync = promisify(execFile)

/** 文本读取上限（与 modTools 一致）：超过返回空，调用方跳过该文件 */
const MAX_READ_SIZE = 64 * 1024 * 1024
async function readTextLimited(file: string): Promise<string> {
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || st.size > MAX_READ_SIZE) return ''
    return fs.readFile(file, 'utf8').catch(() => '')
  } catch {
    return ''
  }
}

/** 验证目录看起来像铁锈战争安装目录（存在 assets/units） */
export async function looksLikeGameDir(dir: string): Promise<boolean> {
  if (!dir) return false
  try {
    const stat = await fs.stat(path.join(dir, 'assets', 'units'))
    return stat.isDirectory()
  } catch {
    return false
  }
}

/** 从 Steam 注册表读 Steam 安装路径（仅 Windows；非 Steam/无注册表返回 null） */
async function steamPathFromRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { timeout: 5000, windowsHide: true },
    )
    const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout)
    if (m) return m[1].trim().replace(/\\\\/g, '\\')
  } catch {
    // 无注册表项（非 Steam 安装/便携版）
  }
  return null
}

/** 候选游戏路径：注册表 Steam 库路径 + 常见安装位置 */
async function candidateGameDirs(): Promise<string[]> {
  const dirs: string[] = []
  const steam = await steamPathFromRegistry()
  const common = path.join('steamapps', 'common', 'Rusted Warfare')
  if (steam) dirs.push(path.join(steam, common))
  dirs.push(
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Rusted Warfare',
    'C:\\Program Files\\Steam\\steamapps\\common\\Rusted Warfare',
    'D:\\Steam\\steamapps\\common\\Rusted Warfare',
    'D:\\SteamLibrary\\steamapps\\common\\Rusted Warfare',
    'E:\\Steam\\steamapps\\common\\Rusted Warfare',
    'E:\\SteamLibrary\\steamapps\\common\\Rusted Warfare',
  )
  // 去重（注册表 Steam 路径与硬编码路径可能重合）
  return [...new Set(dirs)]
}

/** 官方单位目录名：assets/units 下含 .ini 的子目录（按名排序） */
export async function listOfficialUnitDirs(gamePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(gamePath, 'assets', 'units'), { withFileTypes: true })
    const dirs: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const files = await fs.readdir(path.join(gamePath, 'assets', 'units', e.name)).catch(() => [])
      if (files.some((f) => f.toLowerCase().endsWith('.ini'))) dirs.push(e.name)
    }
    return dirs.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** 游戏内已安装模组包：mods/units 下的 .rwmod 文件名 */
export async function listGameMods(gamePath: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(gamePath, 'mods', 'units'))
    return files.filter((f) => f.toLowerCase().endsWith('.rwmod')).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** 自动检测游戏安装目录；configured 为渲染层设置里用户配置的路径（优先验证） */
export async function detectGameDir(
  configured?: string,
): Promise<{ found: boolean; gamePath: string | null; units: string[]; mods: string[] }> {
  const candidates = configured ? [configured, ...(await candidateGameDirs())] : await candidateGameDirs()
  for (const dir of candidates) {
    if (dir && (await looksLikeGameDir(dir))) {
      const [units, mods] = await Promise.all([listOfficialUnitDirs(dir), listGameMods(dir)])
      return { found: true, gamePath: normalizePath(dir), units, mods }
    }
  }
  return { found: false, gamePath: null, units: [], mods: [] }
}

/** 递归复制目录，跳过符号链接（防把游戏目录外的链接目标拉进项目），返回文件数 */
async function copyDirSkipLinks(from: string, to: string): Promise<number> {
  let count = 0
  await fs.mkdir(to, { recursive: true })
  const entries = await fs.readdir(from, { withFileTypes: true })
  for (const e of entries) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isSymbolicLink()) continue // 链接：跳过（目标可能指向游戏目录外）
    if (e.isDirectory()) {
      count += await copyDirSkipLinks(s, d)
    } else {
      await fs.copyFile(s, d)
      count++
    }
  }
  return count
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 导入官方单位示例到目标目录：复制全部单位目录（ini + 图片等资源）+ 生成 mod-info.txt。
 * 目标目录必须已由调用方创建并登记信任锚。
 * 安全：单位名只接受 assets/units 下实际存在的目录（防 ../ 穿越与任意路径复制）；
 * 复制跳过符号链接；目标已有同名单位/自述文件时跳过不覆盖（与 fs:createFile 约定一致）；
 * 中途失败回滚已复制的内容，不留半成品。
 */
export async function importOfficialUnits(
  gamePath: string,
  targetRoot: string,
  units: string[],
  meta: { title: string; description: string; author: string; version: string },
): Promise<{ units: number; files: number }> {
  const allowed = new Set(await listOfficialUnitDirs(gamePath))
  const src = path.join(gamePath, 'assets', 'units')
  let files = 0
  let copiedUnits = 0
  const copied: string[] = []
  let wroteModInfo = false
  try {
    for (const u of units) {
      // 白名单 + 纯目录名校验：拒绝路径分隔符/相对路径/不在官方单位清单中的名字
      if (!allowed.has(u)) continue
      if (u !== path.basename(u) || u.includes('..')) continue
      const from = path.join(src, u)
      const to = path.join(targetRoot, u)
      // 目标已有同名单位目录：跳过不覆盖（用户可能自建过同名单位）
      if (await exists(to)) continue
      files += await copyDirSkipLinks(from, to)
      copied.push(to)
      copiedUnits++
    }

    // mod-info.txt（对齐 buildModInfo 结构：仅 [mod] 节，不写音乐/地图占位节；已存在不覆盖）
    const modInfoPath = path.join(targetRoot, 'mod-info.txt')
    if (!(await exists(modInfoPath))) {
      const lines: string[] = ['[mod]']
      lines.push(`title: ${escapeIniComment(meta.title)}`)
      if (meta.description) lines.push(`description: ${escapeIniComment(meta.description)}`)
      if (meta.version) lines.push(`version: ${escapeIniComment(meta.version)}`)
      if (meta.author) lines.push(`author: ${escapeIniComment(meta.author)}`)
      lines.push('minVersion: 1.15p9')
      lines.push('')
      await fs.writeFile(modInfoPath, lines.join('\n'), 'utf8')
      wroteModInfo = true
      files += 1
    }
  } catch (err) {
    // 中途失败（含 mod-info 写入失败）：回滚本次已复制的单位目录 + 清理本次写入的 mod-info.txt，
    // 不留半成品（目标原本就有的文件一律不动）
    for (const c of copied.reverse()) {
      await fs.rm(c, { recursive: true, force: true }).catch(() => undefined)
    }
    if (wroteModInfo) {
      await fs.rm(path.join(targetRoot, 'mod-info.txt'), { force: true }).catch(() => undefined)
    }
    throw err
  }

  return { units: copiedUnits, files }
}

/**
 * M12 试玩联动：一键启动游戏、打开模组目录、运行前检查清单。
 * 安全：launchGame 只接受通过 looksLikeGameDir 校验的目录（存在 assets/units），
 * 绝不执行任意路径的可执行文件；打开目录限定项目根内。
 */
import { spawn } from 'node:child_process'
import { shell } from 'electron'

/** 游戏可执行文件名（优先 64 位） */
const GAME_EXE_CANDIDATES = ['Rusted Warfare - 64.exe', 'Rusted Warfare.exe', 'Rusted Warfare - 32.exe', 'Rusted Warfare_x64.exe']

/** 找游戏可执行文件（gamePath 需已通过 looksLikeGameDir 校验；找不到返回 null） */
export async function findGameExe(gamePath: string): Promise<string | null> {
  for (const name of GAME_EXE_CANDIDATES) {
    const p = path.join(gamePath, name)
    try {
      const st = await fs.stat(p)
      if (st.isFile()) return p
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

/** 启动游戏（detached 不阻塞主进程；失败返回错误信息，成功返回 null）。
 * spawn 的失败（ENOENT/EACCES/ENOEXEC）是异步 'error' 事件而非同步异常：
 * 用 Promise 包裹监听 error/spawn 两个事件，避免误报「已启动」或
 * unhandled 'error' 打崩主进程 */
export async function launchGame(gamePath: string): Promise<{ ok: boolean; message?: string }> {
  if (!(await looksLikeGameDir(gamePath))) return { ok: false, message: '不是有效的铁锈战争安装目录（缺少 assets/units）' }
  const exe = await findGameExe(gamePath)
  if (!exe) return { ok: false, message: '在游戏目录中未找到可执行文件（Rusted Warfare.exe）' }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: gamePath, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, message: `启动失败：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    child.once('error', (err) => {
      resolve({ ok: false, message: `启动失败：${err.message}` })
    })
    child.once('spawn', () => {
      child.unref() // 不阻塞主进程退出
      resolve({ ok: true })
    })
  })
}

/** 打开目录（项目根或游戏目录；shell.openPath 是只读操作） */
export async function openDir(dir: string): Promise<{ ok: boolean; message?: string }> {
  if (!dir) return { ok: false, message: '目录为空' }
  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) return { ok: false, message: '路径不是目录' }
  } catch {
    return { ok: false, message: '目录不存在' }
  }
  const err = await shell.openPath(dir)
  return err ? { ok: false, message: err } : { ok: true }
}

/** 图片 MIME（按扩展名；未知返回 application/octet-stream） */
function mimeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
    }[ext] ?? 'application/octet-stream'
  )
}

/** 单位预览资产上限（10MB：单张贴图足够，防大图拖垮渲染） */
const MAX_ASSET_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * 读游戏资产图片为 data URL（M22 单位预览：CORE:/ROOT: 官方贴图预览）。
 * 安全：gamePath 必须通过 looksLikeGameDir 校验；路径解析后必须仍在游戏目录内
 * （词法 + 链接逃逸双重校验）；图片大小上限。
 */
export async function readGameAssetImage(gamePath: string, relPath: string): Promise<string> {
  if (!(await looksLikeGameDir(gamePath))) throw new Error('不是有效的铁锈战争安装目录（缺少 assets/units）')
  const rel = String(relPath).replace(/^\/+/, '').replace(/\\/g, '/')
  // 拒绝相对穿越、盘符绝对路径（win32 上 path.join 会丢弃 gamePath 拼接绝对路径）
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('无效的资产路径')
  // 规范化后显式边界校验（与 isPathInside 同语义；内联让静态检查可见）
  const abs = path.resolve(gamePath, rel)
  const base = path.resolve(gamePath)
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('路径超出游戏目录范围')
  await assertNoLinkEscape(gamePath, abs)
  const st = await fs.stat(abs).catch(() => null)
  if (!st || !st.isFile()) throw new Error(`资产文件不存在：${rel}`)
  if (st.size > MAX_ASSET_IMAGE_BYTES) throw new Error('资产文件过大，已拒绝读取')
  const buf = await fs.readFile(abs)
  return `data:${mimeOf(rel)};base64,${buf.toString('base64')}`
}

/** 运行前检查单条结果 */
export interface PreflightIssue {
  severity: 'error' | 'warning'
  message: string
  /** 关联文件（相对项目根，可为空） */
  file?: string
}

export interface PreflightResult {
  ok: boolean
  issues: PreflightIssue[]
}

/** ini 里引用资源文件的键（小写；值可能是逗号分隔或 CUSTOM: 前缀） */
const RESOURCE_REF_KEYS = new Set([
  'image', 'image_wreak', 'image_turret', 'image_shadow', 'image_foot_shadow', 'image_end_shadow',
  'beamimage', 'beamimageend', 'beamimagestart', 'minimapicon', 'icon',
])
/** 非文件引用的值（放行） */
const RESOURCE_SKIP_VALUES = new Set(['none', 'auto', 'shared'])

/**
 * 运行前检查清单（主进程文件级）：
 * 1) mod-info.txt 完整性（存在 + [mod] + title/version/minVersion）
 * 2) 单位 ini 引用的图片等文件必须存在（缺失 → 游戏里单位显示异常）
 * 3) 合并现有 checkMod 的 error 级问题（单位完整性）
 * 版本兼容维度由渲染层语义检查器（checkVersionCompatibility）覆盖。
 */
export async function preflightCheck(projectRoot: string): Promise<PreflightResult> {
  const root = path.resolve(projectRoot)
  const issues: PreflightIssue[] = []

  // 1) mod-info.txt 完整性（区分「缺失」与「过大/读取失败」）
  const modInfoPath = path.join(root, 'mod-info.txt')
  const modInfoContent = await readTextLimited(modInfoPath)
  if (!modInfoContent) {
    const st = await fs.stat(modInfoPath).catch(() => null)
    if (st && st.size > MAX_READ_SIZE) {
      issues.push({ severity: 'error', message: 'mod-info.txt 过大（超过 64MB），无法读取', file: 'mod-info.txt' })
    } else {
      issues.push({ severity: 'error', message: '缺少 mod-info.txt（游戏不识别该模组）', file: 'mod-info.txt' })
    }
  } else {
    const modSection = /^\s*\[mod\]\s*$/im.test(modInfoContent)
    if (!modSection) issues.push({ severity: 'error', message: 'mod-info.txt 缺少 [mod] 节', file: 'mod-info.txt' })
    if (!/^\s*title\s*:/im.test(modInfoContent)) issues.push({ severity: 'warning', message: 'mod-info.txt 缺少 title（模组名）', file: 'mod-info.txt' })
    if (!/^\s*version\s*:/im.test(modInfoContent)) issues.push({ severity: 'warning', message: 'mod-info.txt 缺少 version（建议填写）', file: 'mod-info.txt' })
    if (!/^\s*minVersion\s*:/im.test(modInfoContent)) issues.push({ severity: 'warning', message: 'mod-info.txt 缺少 minVersion（建议填写最低游戏版本）', file: 'mod-info.txt' })
  }

  // 2) 引用文件存在性：扫描全部 ini 的资源键，检查相对路径文件存在
  const iniFiles: string[] = []
  async function collectIni(dir: string, prefix = ''): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      // 与打包同一套排除规则（out/.hg/*.tmp 等永远不会进模组的内容不检查）
      const relName = prefix ? `${prefix}/${e.name}` : e.name
      if (isExcluded(relName)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await collectIni(full, relName)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.ini')) iniFiles.push(full)
    }
  }
  await collectIni(root)
  for (const file of iniFiles) {
    const content = await readTextLimited(file)
    if (!content) continue
    const rel = path.relative(root, file).replace(/\\/g, '/')
    // 键名排除冒号/换行/#（m 标志下 [^:] 会跨行吞掉节名行，导致键名错乱）
    const kvRe = /^([^:\n#][^:\n]*?)\s*:\s*(.*)$/gm
    for (const m of content.matchAll(kvRe)) {
      const key = m[1].trim().toLowerCase()
      if (!RESOURCE_REF_KEYS.has(key)) continue
      for (const raw of m[2].split(',')) {
        // 值清洗（与编辑器 imagePathFromLine 对齐）：行内注释/引号/CUSTOM:/ROOT: 前缀
        let ref = raw.trim().replace(/[ \t]+#.*$/, '').replace(/^["']|["']$/g, '')
        if (!ref) continue
        const lower = ref.toLowerCase()
        if (RESOURCE_SKIP_VALUES.has(lower)) continue
        // SHARED: 前缀 = 游戏共享资源（不检查存在性）；CUSTOM:/ROOT: = 项目内引用（剥前缀）
        if (lower.startsWith('shared:')) continue
        const rootBased = /^ROOT:/i.test(ref)
        ref = ref.replace(/^CUSTOM:/i, '').replace(/^ROOT:/i, '')
        if (!ref) continue
        // 多帧引用（a.png;b.png）逐帧检查；帧语法（frame_1.png:延迟）剥冒号后缀
        for (let frame of ref.split(';')) {
          frame = frame.split(':')[0].trim()
          if (!frame || frame.includes('*') || frame.includes('${')) continue
          const candidate = frame
          // ROOT: 前缀按项目根解析，其余按 ini 所在目录解析
          const target = rootBased ? path.resolve(root, candidate) : path.resolve(path.dirname(file), candidate)
          // 越出项目根（../ 引用）→ 直接报错（打包后必然失效）
          if (!isPathInside(root, target)) {
            issues.push({ severity: 'error', message: `「${key}」引用越出项目目录：${candidate}`, file: rel })
            continue
          }
          try {
            const st = await fs.stat(target)
            if (!st.isFile()) {
              issues.push({ severity: 'error', message: `「${key}」引用的文件不存在：${candidate}`, file: rel })
              continue
            }
            // 链接逃逸：目标存在但经链接指向项目外 → 打包会跳过该链接，模组缺图
            await assertNoLinkEscape(root, target)
          } catch (err) {
            if (err instanceof Error && err.message.includes('指向项目目录外的链接')) {
              issues.push({ severity: 'error', message: `「${key}」引用的文件经链接指向项目外（打包会跳过）：${candidate}`, file: rel })
            } else {
              issues.push({ severity: 'error', message: `「${key}」引用的文件不存在：${candidate}`, file: rel })
            }
          }
        }
      }
    }
  }

  // 2.5) 地图基础校验（打包桥接）：.tmx 必须有 <map> 根元素且含瓦片层 data
  const tmxFiles: string[] = []
  async function collectTmx(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (isExcluded(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await collectTmx(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.tmx')) tmxFiles.push(full)
    }
  }
  await collectTmx(root)
  for (const file of tmxFiles) {
    const content = await readTextLimited(file)
    const rel = path.relative(root, file).replace(/\\/g, '/')
    if (!content) {
      issues.push({ severity: 'error', message: '地图文件为空或无法读取', file: rel })
      continue
    }
    if (!/<map\b[^>]*>/.test(content)) {
      issues.push({ severity: 'error', message: '地图缺少 <map> 根元素（可能不是有效 TMX）', file: rel })
      continue
    }
    // Ground 瓦片层必须有 data（正则粗检：<layer name="Ground" ...><data ...>）
    if (!/<layer\b[^>]*name\s*=\s*"Ground"[^>]*>[\s\S]*?<data\b/.test(content)) {
      issues.push({ severity: 'warning', message: '缺少带 data 的 Ground 瓦片层（地形可能无法加载）', file: rel })
    }
  }

  // 3) 合并现有 checkMod 的 error 级问题（单位完整性：缺 name/重名等）
  const modCheck = await checkMod(root).catch(() => null)
  if (modCheck) {
    for (const it of modCheck.issues) {
      if (it.level === 'error') issues.push({ severity: 'error', message: it.message, file: it.file })
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues }
}
