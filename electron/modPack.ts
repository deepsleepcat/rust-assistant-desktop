/**
 * 模组打包、导入与部署（M40 巨型文件拆分批次 A8）：
 * - packModBuffer / packModBufferWithCount  整目录打成 .rwmod（zip）
 * - importModBuffer                         解压导入（zip-slip/zip bomb/回滚防护）
 * - deployMod                               部署到游戏 mods/units 目录
 * 链接处理：指向项目外的链接跳过并计数；环形链接用 realpath 去重防递归。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { assertNoLinkEscape, normalizePath } from './paths'
import { exists, resolveInside } from './modShared'
import { isExcluded } from './modScan'

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
            await assertNoLinkEscape(projectRoot, abs)
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
            await assertNoLinkEscape(projectRoot, abs)
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
        await assertNoLinkEscape(projectRoot, abs)
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

/** M35 F3：打包并部署到游戏 mods/units 目录（一键验证闭环的「部署」环节）。
 * 设计：游戏目录不是项目根（不登记），写游戏目录是本功能唯一的例外——
 * 目录判定与 game.ts looksLikeGameDir 同标准（gamePath/assets/units 是目录），
 * 文件名取项目根 basename 并清洗非法字符/路径穿越/保留设备名/结尾点；
 * 同名已存在且未确认覆盖时返回 EXISTS 不写盘（防误删游戏内已有模组）；
 * overwrite=false 用 'wx' 原子创建（防并发覆盖）；拒绝写入符号链接目标
 * （防 mods/units/<name>.rwmod 被做成指向游戏目录外的链接）；写盘失败
 * （权限不足/文件被占用）抛错由上层提示。 */
export async function deployMod(
  projectRoot: string,
  gamePath: string,
  options: PackOptions,
  overwrite: boolean,
): Promise<
  | { ok: true; filePath: string; size: number; files: number; skippedLinks: number; overwritten: boolean }
  | { ok: false; code?: 'EXISTS'; filePath?: string; message: string }
> {
  const root = resolveInside(projectRoot, '.')
  // 先校验游戏目录（fail fast：配置错误不浪费打包时间与互斥占用）
  if (!path.isAbsolute(gamePath)) {
    return { ok: false, message: '游戏目录必须是绝对路径，请检查设置中的游戏安装路径' }
  }
  try {
    const st = await fs.stat(path.join(gamePath, 'assets', 'units'))
    if (!st.isDirectory()) {
      return { ok: false, message: '游戏目录校验失败（未找到 assets/units），请检查设置中的游戏安装路径' }
    }
  } catch {
    return { ok: false, message: '游戏目录校验失败（未找到 assets/units），请检查设置中的游戏安装路径' }
  }
  const { buffer, files, skippedLinks } = await packModBufferWithCount(root, options)
  const rawName = path.basename(path.resolve(root)).trim() || 'mod'
  // 清洗 Windows 文件名非法字符 + 路径穿越 + 结尾点/空格 + 保留设备名（CON/NUL/COM1…）
  let safeName = rawName.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').replace(/[. ]+$/, '') || 'mod'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safeName)) safeName = `_${safeName}`
  const modsDir = path.join(gamePath, 'mods', 'units')
  const target = path.join(modsDir, `${safeName}.rwmod`)
  // 拒绝符号链接目标（防写入被链接重定向到游戏目录外）
  let existed = false
  try {
    const st = await fs.lstat(target)
    if (st.isSymbolicLink()) {
      return { ok: false, message: `部署目标存在符号链接，拒绝写入：${target}` }
    }
    existed = true
  } catch {
    // 目标不存在
  }
  if (existed && !overwrite) {
    return { ok: false, code: 'EXISTS', filePath: target, message: `游戏模组目录已存在同名模组：${safeName}.rwmod（确认覆盖后重试）` }
  }
  try {
    await fs.mkdir(modsDir, { recursive: true })
    if (overwrite) {
      await fs.writeFile(target, buffer)
    } else {
      // 'wx' 原子创建：并发下不覆盖刚出现的同名文件（EXISTS 检查与写入合一）
      const handle = await fs.open(target, 'wx')
      try {
        await handle.writeFile(buffer)
      } finally {
        await handle.close()
      }
    }
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, code: 'EXISTS', filePath: target, message: `游戏模组目录已存在同名模组：${safeName}.rwmod（确认覆盖后重试）` }
    }
    throw new Error(`部署到游戏目录失败（权限不足或文件被占用，游戏可能正在运行）：${target}`, { cause: err })
  }
  return { ok: true, filePath: target, size: buffer.byteLength, files, skippedLinks, overwritten: existed && overwrite }
}
