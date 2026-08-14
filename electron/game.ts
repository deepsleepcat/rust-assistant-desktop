/**
 * 游戏集成（M8）：检测铁锈战争安装目录、导入官方单位示例、导入游戏内已装模组。
 * 游戏目录只是只读数据源，不登记为项目根；导入目标目录才会登记信任锚。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizePath } from './paths'
import { escapeIniComment } from './modTools'

const execFileAsync = promisify(execFile)

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
