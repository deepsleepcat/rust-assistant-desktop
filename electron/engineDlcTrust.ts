import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './ipcContext'
import type { ResolvedEngineDlc } from './engineDlc'
import { ENGINE_DLC_SESSION_ENTRY } from './engineDlc'
import { normalizePath } from './paths'

export const ENGINE_DLC_ENABLED_KEY = 'engineDlcEnabled'

/** Legacy grants without execution configuration deliberately require reauthorization. */
export interface EngineDlcGrant {
  entry: string
  fingerprint: string
  execution?: string
}

/**
 * 会话链固定文件集：会话宿主桥、会话 Node 入口、会话 Java 桥 JAR 与引擎校验清单。
 * 全部落在 DLC 目录内；不存在的项跳过（老包没有 bridge-session.jar）。
 * 授权指纹必须覆盖整条会话链，而不是只覆盖单帧入口——任何一处被替换都要重新授权。
 */
const SESSION_TRUST_FILES = [ENGINE_DLC_SESSION_ENTRY, 'render-session.cjs', 'bridge-session.jar', 'compatibility.json'] as const

/** Hash all bytes, including large executables, with bounded memory. */
export async function fingerprintEntry(entryPath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(entryPath)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

/** 会话链指纹（相对路径 → sha256）。session-host.cjs 不存在时返回 undefined（无会话能力）。 */
export async function fingerprintSessionChain(dir: string): Promise<Record<string, string> | undefined> {
  const sessionHost = path.join(dir, ENGINE_DLC_SESSION_ENTRY)
  try {
    const st = await fs.stat(sessionHost)
    if (!st.isFile()) return undefined
  } catch {
    return undefined
  }
  const fingerprints: Record<string, string> = {}
  for (const relative of SESSION_TRUST_FILES) {
    const absolute = path.join(dir, relative)
    try {
      const st = await fs.stat(absolute)
      if (!st.isFile()) continue
      fingerprints[relative] = await fingerprintEntry(absolute)
    } catch {
      continue
    }
  }
  return fingerprints
}

export async function snapshotEngineDlc(ctx: IpcContext, dlc: ResolvedEngineDlc): Promise<EngineDlcGrant> {
  const entry = normalizePath(await fs.realpath(dlc.entryPath))
  const dir = normalizePath(await fs.realpath(dlc.dir))
  // 会话链指纹放进 execution 快照一起比较：任何会话链文件被替换 → 指纹失配 → 需重新授权。
  // 旧版授权快照没有该字段，DLC 升级后自然要求重新授权（符合「程序变化需重新确认」）。
  const sessionChain = await fingerprintSessionChain(dir)
  return {
    entry,
    fingerprint: await fingerprintEntry(entry),
    execution: JSON.stringify({
      id: dlc.id, name: dlc.name, version: dlc.version, description: dlc.description,
      entry, dir, args: dlc.args, timeoutMs: dlc.timeoutMs, runtime: ctx.nodeRuntime,
      ...(sessionChain ? { sessionChain } : {}),
    }),
  }
}

export function sameEngineDlcGrant(a: EngineDlcGrant, b: EngineDlcGrant): boolean {
  return a.entry === b.entry && a.fingerprint === b.fingerprint && !!a.execution && a.execution === b.execution
}

export async function isEngineDlcAllowed(ctx: IpcContext, dlc: ResolvedEngineDlc): Promise<boolean> {
  const grant = ctx.engineDlc.enabled.get(dlc.id)
  if (!grant) return false
  try {
    const current = await snapshotEngineDlc(ctx, dlc)
    return ctx.engineDlc.enabled.get(dlc.id) === grant && sameEngineDlcGrant(grant, current)
  } catch {
    return false
  }
}

/** Persist the already-confirmed snapshot; never silently authorize new bytes. */
export async function grantEngineDlc(ctx: IpcContext, dlc: ResolvedEngineDlc, snapshot: EngineDlcGrant): Promise<void> {
  ctx.engineDlc.enabled.set(dlc.id, snapshot)
  await ctx.store.set(ENGINE_DLC_ENABLED_KEY, Object.fromEntries(ctx.engineDlc.enabled))
}

export function revokeEngineDlc(ctx: IpcContext, dlcId: string): void {
  if (!ctx.engineDlc.enabled.delete(dlcId)) return
  void ctx.store.set(ENGINE_DLC_ENABLED_KEY, Object.fromEntries(ctx.engineDlc.enabled))
}

export function restoreEngineDlcGrants(ctx: IpcContext): void {
  const saved = ctx.store.get(ENGINE_DLC_ENABLED_KEY)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
  for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const { entry, fingerprint, execution } = value as Record<string, unknown>
    if (typeof entry !== 'string' || !entry || typeof fingerprint !== 'string' || !fingerprint) continue
    ctx.engineDlc.enabled.set(id, { entry, fingerprint, ...(typeof execution === 'string' ? { execution } : {}) })
  }
}
