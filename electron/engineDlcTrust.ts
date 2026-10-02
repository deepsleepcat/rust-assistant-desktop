import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import type { IpcContext } from './ipcContext'
import type { ResolvedEngineDlc } from './engineDlc'
import { normalizePath } from './paths'

export const ENGINE_DLC_ENABLED_KEY = 'engineDlcEnabled'

/** Legacy grants without execution configuration deliberately require reauthorization. */
export interface EngineDlcGrant {
  entry: string
  fingerprint: string
  execution?: string
}

/** Hash all bytes, including large executables, with bounded memory. */
export async function fingerprintEntry(entryPath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(entryPath)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

export async function snapshotEngineDlc(ctx: IpcContext, dlc: ResolvedEngineDlc): Promise<EngineDlcGrant> {
  const entry = normalizePath(await fs.realpath(dlc.entryPath))
  const dir = normalizePath(await fs.realpath(dlc.dir))
  return {
    entry,
    fingerprint: await fingerprintEntry(entry),
    execution: JSON.stringify({
      id: dlc.id, name: dlc.name, version: dlc.version, description: dlc.description,
      entry, dir, args: dlc.args, timeoutMs: dlc.timeoutMs, runtime: ctx.nodeRuntime,
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
