import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommunityAuth, TRUSTED_COMMUNITY_ORIGIN } from '../electron/communityAuth'
import { registerCommunityIpc } from '../electron/communityIpc'
import type { SecureCredentials } from '../electron/secureCredentials'
import type { IpcContext } from '../electron/ipcContext'
import type { CommunityRequest } from '../src/types/bridge'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const token = () => `sk-${randomBytes(24).toString('hex')}`
function fixture() {
  const old = token(), next = token()
  let current: string | null = old
  const credentials: SecureCredentials = {
    isAvailable: () => true,
    hasCredential: async () => current !== null,
    withCredential: async (apply) => current === null ? null : apply(current),
    saveCredential: async (value) => { current = value },
    clearCredential: vi.fn(async () => { current = null }),
  }
  const started = deferred<void>(), delayed = deferred<Response>()
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (new Headers(init?.headers).get('Authorization') === `Bearer ${old}`) {
      started.resolve()
      return delayed.promise
    }
    if (path.endsWith('/pairing/start')) return Response.json({ success: true, data: { pairing_id: 'isolated', device_secret: randomBytes(16).toString('hex'), user_code: 'TEST-ONLY', expires_at: Math.floor(Date.now() / 1000) + 600 } })
    if (path.endsWith('/pairing/poll')) return Response.json({ success: true, data: { status: 'claimed', token: next, user: { id: 2, username: 'isolated-next' } } })
    if (path === '/api/me') return Response.json({ success: true, data: { id: 2, username: 'isolated-next' } })
    return Response.json({ success: true, data: {} })
  })
  const auth = createCommunityAuth({ credentials, fetch: fetcher, openExternal: async () => {} })
  const loginNext = async () => {
    await auth.invalidate()
    await auth.startPairing()
    expect((await auth.pollPairing()).state).toBe('signed-in')
  }
  return { old, next, credentials, started, delayed, fetcher, auth, loginNext, hasNext: () => current === next }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('delayed authenticated responses (isolated memory credentials, no network)', () => {
  it.each(['/api/community/dashboard', '/api/community/posts', '/api/usage'])('old 401 on %s preserves a subsequently paired credential', async (path) => {
    const f = fixture()
    vi.stubGlobal('fetch', f.fetcher)
    let handler!: (event: unknown, input: CommunityRequest) => unknown
    registerCommunityIpc({ communityAuth: f.auth } as IpcContext, (_name, fn) => { handler = fn as typeof handler })
    const pending = handler({} as never, { url: `${TRUSTED_COMMUNITY_ORIGIN}${path}`, method: 'GET', authenticated: true })
    await f.started.promise
    await f.loginNext()
    f.delayed.resolve(Response.json({ success: false }, { status: 401 }))
    await pending
    expect(f.hasNext()).toBe(true)
    expect((await f.auth.status()).state).toBe('signed-in')
  })

  it('auth status old /api/me 401 preserves the new paired session', async () => {
    const f = fixture()
    const pending = f.auth.status()
    await f.started.promise
    await f.loginNext()
    f.delayed.resolve(Response.json({ success: false }, { status: 401 }))
    expect((await pending).state).toBe('signed-in')
    expect(f.hasNext()).toBe(true)
  })
})


describe('conditional invalidation serialization', () => {
  it('clears a matching credential, leaves a different credential, and retains force invalidate', async () => {
    const f = fixture()
    expect(await f.auth.invalidateIfCredential(f.next)).toBe(false)
    expect(await f.credentials.hasCredential()).toBe(true)
    expect(await f.auth.invalidateIfCredential(f.old)).toBe(true)
    expect(await f.credentials.hasCredential()).toBe(false)
    await f.credentials.saveCredential(f.next)
    await f.auth.invalidate()
    expect(await f.credentials.hasCredential()).toBe(false)
  })

  it('keeps pairing save behind the entire conditional compare-and-clear task', async () => {
    const f = fixture()
    await f.auth.invalidate()
    await f.auth.startPairing()
    await f.credentials.saveCredential(f.old) // seed only the isolated in-memory fixture
    const compared = deferred<void>(), release = deferred<void>()
    const readCredential = f.credentials.withCredential
    f.credentials.withCredential = async (apply) => readCredential(async (value) => {
      const result = await apply(value)
      if (result === true) { compared.resolve(); await release.promise }
      return result
    })
    const conditional = f.auth.invalidateIfCredential(f.old)
    await compared.promise
    const pairing = f.auth.pollPairing()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(f.hasNext()).toBe(false)
    release.resolve()
    expect(await conditional).toBe(true)
    expect((await pairing).state).toBe('signed-in')
    expect(f.hasNext()).toBe(true)
  })

  it('does not cache an old successful /api/me response over the new paired user', async () => {
    const f = fixture()
    const pending = f.auth.status()
    await f.started.promise
    await f.loginNext()
    f.delayed.resolve(Response.json({ success: true, data: { id: 1, username: 'isolated-old' } }))
    expect((await pending).user?.id).toBe(2)
    expect((await f.auth.status()).user?.id).toBe(2)
  })
})
