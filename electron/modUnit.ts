/**
 * 单位创建与复制（M40 巨型文件拆分批次 A9b）：
 * - createUnit  新建最小可玩单位骨架：<folder>/<name>/<name>.ini（已存在报错）
 * - copyUnit    跨/同模组复制单位配置文本（两端项目根都须已登记）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoLinkEscape } from './paths'
import { buildUnitSkeleton } from './modIni'
import { exists, readTextLimited, resolveInside } from './modShared'

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

/** M34 单位复制参数：sourceRoot/sourceFilePath 指明源单位，targetRoot 目标项目 */
export interface CopyUnitParams {
  /** 源项目根目录（须已登记；与目标可以相同=同模组复制） */
  sourceRoot: string
  /** 源单位文件相对源项目根的路径（scanUnits 返回的 path） */
  sourceFilePath: string
  /** 目标项目根目录（须已登记） */
  targetRoot: string
  /** 目标单位名（用作新文件目录名；非法字符替换为 -） */
  targetName: string
  /** 目标文件夹（相对目标项目根的目录，可空） */
  targetFolder?: string
}

/**
 * 从其它模组（或同模组）复制单位配置到目标模组（M34）。
 * 主进程原子操作：两端项目根都校验登记 → 源文件越界/链接逃逸校验 →
 * 单位格式校验（.ini/.template + [core]/[核心]）→ 目标不存在才写入。
 * 复制的是单位配置文本（含注释/节顺序），不自动复制图片/音频等外部资源；
 * 与 createUnitFromTemplate 的目标路径规则一致：<folder>/<name>/<name>.ini。
 */
export async function copyUnit(params: CopyUnitParams): Promise<{ path: string }> {
  const { sourceRoot, sourceFilePath, targetRoot, targetName, targetFolder } = params
  if (!sourceRoot || !targetRoot || !sourceFilePath || !targetName) throw new Error('复制参数不完整')

  // 2) 源：限定 .ini/.template，解析为源项目内绝对路径（越界即抛错）
  if (!/\.(ini|template)$/i.test(sourceFilePath)) {
    throw new Error(`只能复制 .ini / .template 单位文件：${sourceFilePath}`)
  }
  const sourceAbs = resolveInside(sourceRoot, sourceFilePath)
  // 源文件不能通过 junction/符号链接指向项目外
  await assertNoLinkEscape(sourceRoot, sourceAbs)
  const content = await readTextLimited(sourceAbs)
  if (!content) throw new Error('源单位文件为空或不可读（超过 64MB 上限？）')
  // 节名大小写不敏感（引擎同，与 scanUnits/scanResources 的小写化识别对齐）
  if (!/^\s*\[(core|核心)\s*\]/im.test(content)) {
    throw new Error('源文件不是单位文件（缺少 [core] / [核心] 节）')
  }

  // 3) 目标：与 createUnitFromTemplate 相同的路径规则与安全校验
  const safeName = targetName.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
  const folder = (targetFolder ?? '').replace(/^\/+|\/+$/g, '')
  const rel = folder ? path.posix.join(folder, safeName, `${safeName}.ini`) : path.posix.join(safeName, `${safeName}.ini`)
  const targetAbs = resolveInside(targetRoot, rel)
  await assertNoLinkEscape(targetRoot, targetAbs)
  // flag 'wx'：目标已存在即失败（原子防重，消除 exists 检查与写入之间的 TOCTOU 窗口）
  await fs.mkdir(path.dirname(targetAbs), { recursive: true })
  try {
    await fs.writeFile(targetAbs, content, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`目标文件已存在：${rel}（不会覆盖已有文件）`, { cause: err })
    }
    throw new Error(`写入目标文件失败：${rel}`, { cause: err })
  }
  return { path: rel }
}
