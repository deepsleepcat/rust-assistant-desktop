/**
 * 引擎 DLC 授权锚（M42）——记录「用户授权过哪些 DLC」，并检测程序是否被换过。
 *
 * 设计：DLC 是可执行程序，一旦运行就等于把用户权限交出去。因此「允许运行」
 * 必须是一次**显式、可追溯、能撤销**的用户决定，而不是「文件在那儿」这种事实。
 * 本模块只负责存这份决定；做出决定的动作（系统确认框）在 engineDlcIpc 里。
 *
 * 安全边界：锚键 ENGINE_DLC_ENABLED_KEY 只能由主进程的授权流程写入，渲染层无法伪造
 * （已加进 storeIpc 的 MAIN_PROCESS_ONLY_STORE_KEYS）。若允许渲染层写这个键，
 * 被 XSS 的界面就能自行授予自己「执行任意程序」的权限，锚也就形同虚设。
 *
 * 指纹：授权时记下入口文件的 sha256，之后每次扫描都比对。文件被替换（换了程序、
 * 或更新了版本）就要求重新授权——授权的是「这一个程序」，不是「这个目录名」。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { IpcContext } from './ipcContext'
import type { ResolvedEngineDlc } from './engineDlc'

/** DLC id → 授权记录 的主进程独占锚键 */
export const ENGINE_DLC_ENABLED_KEY = 'engineDlcEnabled'

/** 单条授权记录：授权时的入口文件指纹 */
export interface EngineDlcGrant {
  /** 入口文件相对路径（授权时记录；换路径即视为另一个程序） */
  entry: string
  /** `sha256:<hex>`；文件过大时退化为 `meta:<size>:<mtimeMs>` */
  fingerprint: string
}

/** 计算入口文件指纹。超过 64 MB 不整读（避免扫描目录时卡住），退化为体积+修改时间。 */
const MAX_HASH_BYTES = 64 * 1024 * 1024

export async function fingerprintEntry(entryPath: string): Promise<string> {
  const st = await fs.stat(entryPath)
  if (st.size > MAX_HASH_BYTES) return `meta:${st.size}:${Math.round(st.mtimeMs)}`
  const buffer = await fs.readFile(entryPath)
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
}

/** 该 DLC 当前是否被授权运行（授权存在 + 入口相对路径一致 + 指纹仍然匹配） */
export async function isEngineDlcAllowed(ctx: IpcContext, dlc: ResolvedEngineDlc): Promise<boolean> {
  const grant = ctx.engineDlc.enabled.get(dlc.id)
  if (!grant) return false
  if (grant.entry !== dlc.entryPath) return false
  try {
    return (await fingerprintEntry(dlc.entryPath)) === grant.fingerprint
  } catch {
    return false
  }
}

/** 授权一个 DLC（写入当前入口指纹） */
export async function grantEngineDlc(ctx: IpcContext, dlc: ResolvedEngineDlc): Promise<void> {
  const fingerprint = await fingerprintEntry(dlc.entryPath)
  ctx.engineDlc.enabled.set(dlc.id, { entry: dlc.entryPath, fingerprint })
  void ctx.store.set(ENGINE_DLC_ENABLED_KEY, Object.fromEntries(ctx.engineDlc.enabled))
}

/** 撤销授权（入口文件已不存在时也能调用） */
export function revokeEngineDlc(ctx: IpcContext, dlcId: string): void {
  if (!ctx.engineDlc.enabled.delete(dlcId)) return
  void ctx.store.set(ENGINE_DLC_ENABLED_KEY, Object.fromEntries(ctx.engineDlc.enabled))
}

/** 启动时从锚值恢复授权集合；锚值异常（非对象）时按「没有任何授权」处理 */
export function restoreEngineDlcGrants(ctx: IpcContext): void {
  const saved = ctx.store.get(ENGINE_DLC_ENABLED_KEY)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    if (saved !== null && saved !== undefined) {
      console.warn('[ipc] engineDlcEnabled 锚值异常，按无授权处理:', typeof saved)
    }
    return
  }
  for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const { entry, fingerprint } = value as Record<string, unknown>
    if (typeof entry !== 'string' || !entry || typeof fingerprint !== 'string' || !fingerprint) continue
    ctx.engineDlc.enabled.set(id, { entry, fingerprint })
  }
}
