/**
 * 模组创建与音频转码（M40 巨型文件拆分批次 A9a）：
 * - createMod       创建/补全 mod-info.txt（可选背景音乐转 ogg）
 * - transcodeToOgg  任意音频转 ogg（ffmpeg-static 优先，退回系统 PATH）
 * - findFfmpeg      ffmpeg 可执行文件定位
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { assertNoLinkEscape } from './paths'
import { buildModInfo, type CreateModParams } from './modIni'
import { exists, resolveInside } from './modShared'

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
