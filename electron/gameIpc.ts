/**
 * 游戏集成 IPC（M40 巨型文件拆分批次 B4）：
 * 检测 / 导入官方单位 / 导入已装模组 / 启动 / 运行前检查 / 资产图片。
 * 导入目标目录必须已登记；解压进自动创建的唯一子目录，失败只清理本次子目录。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { isPathInside, normalizePath } from './paths'
import { detectGameDir, importOfficialUnits, launchGame, openDir, preflightCheck, readGameAssetImage } from './game'
import { importModBuffer } from './modTools'
import { exists, registerRoot } from './projectTrust'

/** 显式目录边界断言（防御性冗余；调用点均已先做信任锚校验） */
function assertInsideDir(base: string, target: string): void {
  if (!isPathInside(path.resolve(base), target)) throw new Error('目标路径超出项目目录范围，拒绝访问')
}

/** 游戏集成：检测 / 导入官方单位 / 导入已装模组 / 启动 / 运行前检查 / 资产图片 */
export function registerGameIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('game:detect', async (_event, configuredPath?: string) => {
    return detectGameDir(typeof configuredPath === 'string' && configuredPath ? configuredPath : undefined)
  })

  ipc('game:importSample', async (_event, gamePath: string, targetRoot: string, opts: { title?: string; description?: string } | null) => {
    if (typeof targetRoot !== 'string' || !ctx.roots.has(normalizePath(targetRoot))) {
      throw new Error('目标目录未登记，请重新选择文件夹')
    }
    const detected = await detectGameDir(typeof gamePath === 'string' ? gamePath : undefined)
    if (!detected.found || !detected.gamePath) throw new Error('未找到铁锈战争安装目录，请先在设置中配置游戏目录')
    if (ctx.packing.active) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const meta = opts ?? {}
    const result = await importOfficialUnits(detected.gamePath, targetRoot, detected.units, {
      title: typeof meta.title === 'string' && meta.title ? meta.title : '官方单位示例',
      description:
        typeof meta.description === 'string' && meta.description
          ? meta.description
          : `由铁锈助手从游戏安装目录导入的 ${detected.units.length} 个官方单位（仅供学习参考）`,
      author: 'Rusted Warfare 官方',
      version: '1.0',
    })
    registerRoot(ctx, targetRoot)
    return { rootPath: targetRoot, ...result }
  })

  ipc('game:importMod', async (_event, gamePath: string, fileName: string, targetRoot: string) => {
    if (typeof targetRoot !== 'string' || !ctx.roots.has(normalizePath(targetRoot))) {
      throw new Error('目标目录未登记，请重新选择文件夹')
    }
    const detected = await detectGameDir(typeof gamePath === 'string' ? gamePath : undefined)
    if (!detected.found || !detected.gamePath) throw new Error('未找到铁锈战争安装目录，请先在设置中配置游戏目录')
    // 文件名白名单：只接受 mods/units 下实际存在的 .rwmod（防路径穿越）
    if (typeof fileName !== 'string' || fileName !== path.basename(fileName) || !detected.mods.includes(fileName)) {
      throw new Error('无效的模组包文件名')
    }
    if (ctx.packing.active) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const pkg = path.join(detected.gamePath, 'mods', 'units', fileName)
    const pkgStat = await fs.stat(pkg)
    if (pkgStat.size > 1024 * 1024 * 1024) {
      throw new Error(`模组包过大（${(pkgStat.size / 1024 / 1024 / 1024).toFixed(1)}GB，上限 1GB），无法导入`)
    }
    // 在用户选定的目录下创建唯一子目录解压（与 mod:import 同款命名/去重），
    // 绝不直接解压进用户既有目录——解压失败清理也只针对本次创建的子目录，避免误删用户数据
    let baseName = path.basename(fileName, path.extname(fileName)).replace(/[/:*?"<>|]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '')
    if (!baseName || baseName === '.' || baseName === '..') baseName = 'imported-mod'
    // Windows 保留名（CON/NUL/PRN/AUX/COM1-9/LPT1-9）：mkdir 会抛 EINVAL，加后缀避开
    if (/^(con|nul|prn|aux|com[1-9]|lpt[1-9])$/i.test(baseName)) baseName += '-mod'
    let destRoot = path.join(targetRoot, baseName)
    // 显式边界断言：清洗后的子目录必须落在已登记的目标项目根内
    assertInsideDir(targetRoot, destRoot)
    for (let suffix = 2; await exists(destRoot); suffix++) destRoot = path.join(targetRoot, `${baseName}-${suffix}`)
    const buf = await fs.readFile(pkg)
    let files: number
    try {
      // 解压写盘前创建目录（放 try 内：读包/建目录失败都会清理，不留空目录）
      await fs.mkdir(destRoot, { recursive: true })
      ;({ files } = await importModBuffer(buf, destRoot))
    } catch (err) {
      // 解压中途失败：只清理本次创建的子目录（不留残留），用户选择的父目录不受影响
      await fs.rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    registerRoot(ctx, destRoot)
    // 登记为「本次会话创建」：语义与 mod:import 一致（只针对本次创建的目录）
    ctx.importedDirs.add(normalizePath(destRoot))
    return { rootPath: destRoot, files }
  })

  // M12 试玩联动：启动游戏 / 打开目录 / 运行前检查。
  // 安全：launchGame 只接受通过 looksLikeGameDir 校验的目录；openDir 只接受
  // 已登记的项目根（打开任意目录无写风险，但保持「限制项目根」的一致性）
  ipc('game:launch', async (_event, gamePath: unknown) => {
    if (typeof gamePath !== 'string' || !gamePath) return { ok: false, message: '请先在设置中配置游戏安装目录' }
    return launchGame(gamePath)
  })

  ipc('game:openDir', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, message: '目录为空' }
    const normalized = normalizePath(rootPath)
    if (!ctx.roots.has(normalized)) return { ok: false, message: '目录未登记，无法打开' }
    return openDir(normalized)
  })

  ipc('game:preflight', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, issues: [{ severity: 'error' as const, message: '项目目录为空' }] }
    const normalized = normalizePath(rootPath)
    if (!ctx.roots.has(normalized)) return { ok: false, issues: [{ severity: 'error' as const, message: '项目目录未登记，无法检查' }] }
    return preflightCheck(normalized)
  })

  // M22 单位预览：读游戏资产图片（CORE:/ROOT: 官方贴图；gamePath 需通过游戏目录校验）
  ipc('game:readAssetImage', async (_event, gamePath: unknown, relPath: unknown) => {
    if (typeof gamePath !== 'string' || typeof relPath !== 'string') throw new Error('参数错误')
    return readGameAssetImage(gamePath, relPath)
  })
}
