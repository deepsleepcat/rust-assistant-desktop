/**
 * 引擎渲染 DLC IPC（M42）：列出指定目录里的 DLC / 打开目录 / 授权或撤销 / 执行渲染。
 *
 * 主张：宿主只提供插座，不提供引擎。用户把自己准备的渲染 DLC 放进
 * <userData>/engine-dlc/，授权后即可作为单位预览的渲染路径。
 *
 * 安全边界（对应 engineDlc.ts 的四条，这里补 IPC 层的三条）：
 * - `dlc:grant` 会弹**主进程系统确认框**：授权=允许在本机以用户权限运行该程序。
 *   渲染层被 XSS 后可静默调 IPC，所以必须由不可伪造的系统对话框让用户点确认。
 * - 渲染层不传 DLC id、也不传任何路径给可执行文件：`dlc:render` 只收「要画什么」，
 *   用哪个 DLC 由主进程遍历授权集合决定，渲染层给的一个字段都不参与路径构造。
 * - `dlc:render` 的 unitFile 必须落在已登记的项目根内：不主动把任意路径递给外部程序。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { isPathInside, normalizePath } from './paths'
import {
  engineDlcDir,
  readEngineDlcDir,
  runEngineDlcRender,
  scanEngineDlcDir,
  toEngineDlcList,
  type ResolvedEngineDlc,
} from './engineDlc'
import { grantEngineDlc, isEngineDlcAllowed, revokeEngineDlc } from './engineDlcTrust'

/** 界面传来的布尔值一律重新收敛（IPC 参数不可信） */
function asBoolean(value: unknown): boolean {
  return value === true
}

/** 界面传来的整数收敛到合法范围；非法返回 null */
function asInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < min || value > max) return null
  return value
}

export function registerEngineDlcIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  /** 指定目录（userData 由主进程提供，渲染层无法影响其位置） */
  const rootOf = (): string => engineDlcDir(ctx.app.getPath('userData'))

  /** 扫描 + 授权判定：返回界面列表与「当前可用于渲染的 DLC」 */
  const survey = async (): Promise<{ dir: string; dlcs: ReturnType<typeof toEngineDlcList>; active: ResolvedEngineDlc | null }> => {
    const root = rootOf()
    const { dir, items } = await scanEngineDlcDir(root)
    const allowed = new Set<string>()
    let active: ResolvedEngineDlc | null = null
    for (const item of items) {
      if (!item.dlc) continue
      if (!(await isEngineDlcAllowed(ctx, item.dlc))) continue
      allowed.add(item.dlc.id)
      active ??= item.dlc // 按目录名排序后的第一个可用项，结果稳定可预期
    }
    return { dir, dlcs: toEngineDlcList(items, allowed), active }
  }

  ipc('dlc:list', async () => {
    const { dir, dlcs } = await survey()
    return { dir, dlcs }
  })

  /** 打开指定目录（不存在则创建）。路径由主进程拼出，渲染层传什么都不参与。 */
  ipc('dlc:openDir', async () => {
    const root = rootOf()
    await fs.mkdir(root, { recursive: true })
    const err = await ctx.shell.openPath(root)
    return err ? { ok: false, message: err, dir: root } : { ok: true, dir: root }
  })

  /** 授权/撤销。授权必须先过系统确认框；撤销不需要（回收权限永远安全）。 */
  ipc('dlc:grant', async (_event, dlcId: unknown, enabled: unknown) => {
    if (typeof dlcId !== 'string' || !dlcId) return { ok: false, message: 'DLC 标识无效' }
    const root = rootOf()
    await fs.mkdir(root, { recursive: true })
    const read = await readEngineDlcDir(path.join(root, dlcId), dlcId)
    if (!read.ok) return { ok: false, message: read.problem }

    if (!asBoolean(enabled)) {
      revokeEngineDlc(ctx, dlcId)
      return { ok: true, enabled: false }
    }

    const size = await fs.stat(read.dlc.entryPath).then((st) => st.size).catch(() => null)
    // 授权=允许在本机执行该程序：用系统对话框确认（渲染层伪造不了对话框）
    const { response } = await ctx.dialog.showMessageBox({
      type: 'warning',
      title: '授权引擎渲染 DLC',
      message: `允许「${read.dlc.name}」在本机运行？`,
      detail:
        '授权后，单位预览可以调用这个程序渲染图片。\n\n' +
        `入口：${read.dlc.entryPath}\n` +
        `大小：${size === null ? '未知' : `${Math.round(size / 1024)} KB`}\n\n` +
        '它会以你的用户权限运行，能读写你能读写的一切。请只授权你信任的来源。' +
        '程序文件若被替换，需要重新授权。',
      buttons: ['取消', '授权运行'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (response !== 1) return { ok: false, message: '已取消授权' }

    await grantEngineDlc(ctx, read.dlc)
    return { ok: true, enabled: true, name: read.dlc.name }
  })

  /**
   * 引擎渲染：主进程挑 DLC、写请求、跑子进程、读回 PNG。
   * 收的参数只有「要画什么」，没有任何字段能指定可执行文件。
   */
  ipc('dlc:render', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: '渲染参数无效' }
    }
    const input = payload as Record<string, unknown>

    const projectRoot = input.projectRoot
    if (typeof projectRoot !== 'string' || !projectRoot) return { ok: false, reason: '项目目录为空' }
    const normalizedRoot = normalizePath(projectRoot)
    if (!ctx.roots.has(normalizedRoot)) return { ok: false, reason: '项目目录未登记，无法引擎渲染' }

    const unitFile = input.unitFile
    if (typeof unitFile !== 'string' || !unitFile) return { ok: false, reason: '单位文件路径为空' }
    const absUnit = path.resolve(unitFile)
    if (!isPathInside(normalizedRoot, absUnit)) return { ok: false, reason: '单位文件不在项目目录内，已拒绝' }

    const frame = asInt(input.frame, 0, 10_000)
    const direction = asInt(input.direction, 0, 3599)
    const width = asInt(input.width, 1, 4096)
    const height = asInt(input.height, 1, 4096)
    if (frame === null || direction === null || width === null || height === null) {
      return { ok: false, reason: '渲染参数超出允许范围' }
    }
    const animationState = input.animationState
    if (typeof animationState !== 'string' || !['idle', 'moving', 'attack'].includes(animationState)) {
      return { ok: false, reason: '动画状态无效' }
    }

    const { active } = await survey()
    if (!active) return { ok: false, reason: '没有已授权的引擎渲染 DLC' }

    return await runEngineDlcRender(
      active,
      {
        unitFile: absUnit,
        unitContent: typeof input.unitContent === 'string' ? input.unitContent : '',
        projectRoot: normalizedRoot,
        gamePath: typeof input.gamePath === 'string' ? input.gamePath : '',
        frame,
        direction,
        animationState,
        showWreck: asBoolean(input.showWreck),
        width,
        height,
      },
      { execPath: ctx.nodeRuntime },
    )
  })
}
