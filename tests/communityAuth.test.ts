import { describe, expect, it, vi } from 'vitest'
import {
  COMMUNITY_PAIRING_PAGE_PATH,
  TRUSTED_COMMUNITY_ORIGIN,
  createCommunityAuth,
  validateCommunityPairingUrl,
} from '../electron/communityAuth'
import { COMMUNITY_AUTH_CREDENTIAL_KEY, DEEPSEEK_CREDENTIAL_KEY, createSecureCredentials, type SafeStorageAdapter } from '../electron/secureCredentials'

function createMemoryStore(): { data: Map<string, unknown>; get(key: string): unknown; set(key: string, value: unknown): Promise<void> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: (key) => data.get(key),
    set: async (key, value) => { data.set(key, value) },
  }
}

function createSafeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'os_crypt',
    encryptString: (value) => Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0xa5)),
    decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8'),
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('secure credentials', () => {
  it('persists only safeStorage ciphertext and decrypts only inside the main-process callback', async () => {
    const store = createMemoryStore()
    const credentials = createSecureCredentials(store, createSafeStorage())

    await credentials.saveCredential('desktop-secret')
    const persisted = store.data.get(COMMUNITY_AUTH_CREDENTIAL_KEY)
    expect(persisted).toBeTypeOf('string')
    expect(persisted).not.toBe('desktop-secret')
    expect(String(persisted)).not.toContain('desktop-secret')
    await expect(credentials.withCredential((value) => `used:${value}`)).resolves.toBe('used:desktop-secret')

    await credentials.clearCredential()
    await expect(credentials.withCredential((value) => value)).resolves.toBeNull()
  })

  it('rejects unavailable or basic-text safeStorage and deletes legacy plaintext', async () => {
    const unavailableStore = createMemoryStore()
    const unavailable = createSecureCredentials(unavailableStore, createSafeStorage({ available: false }))
    await expect(unavailable.saveCredential('secret')).rejects.toThrow('安全凭据存储不可用')
    expect(unavailableStore.data.has(COMMUNITY_AUTH_CREDENTIAL_KEY)).toBe(false)

    const basicTextStore = createMemoryStore()
    const basicText = createSecureCredentials(basicTextStore, createSafeStorage({ backend: 'basic_text' }))
    await expect(basicText.saveCredential('secret')).rejects.toThrow('安全凭据存储不可用')

    const legacyStore = createMemoryStore()
    legacyStore.data.set(COMMUNITY_AUTH_CREDENTIAL_KEY, 'legacy-plaintext-token')
    const credentials = createSecureCredentials(legacyStore, createSafeStorage())
    await expect(credentials.hasCredential()).resolves.toBe(false)
    expect(legacyStore.data.get(COMMUNITY_AUTH_CREDENTIAL_KEY)).toBeNull()
  })

  it('persists under a custom credential key without touching the default key', async () => {
    // 回归：saveCredential 曾写死默认键名，导致自定义键（如 deepseekApiKeyV1）保存后读取永远为空
    const store = createMemoryStore()
    store.data.set(COMMUNITY_AUTH_CREDENTIAL_KEY, 'other-secret')
    const credentials = createSecureCredentials(store, createSafeStorage(), DEEPSEEK_CREDENTIAL_KEY)

    await credentials.saveCredential('deepseek-key')
    await expect(credentials.hasCredential()).resolves.toBe(true)
    await expect(credentials.withCredential((value) => value)).resolves.toBe('deepseek-key')
    // 写入只落在自定义键，默认键不受影响
    expect(String(store.data.get(DEEPSEEK_CREDENTIAL_KEY))).not.toContain('deepseek-key')
    expect(store.data.get(COMMUNITY_AUTH_CREDENTIAL_KEY)).toBe('other-secret')

    await credentials.clearCredential()
    expect(store.data.get(DEEPSEEK_CREDENTIAL_KEY)).toBeNull()
    expect(store.data.get(COMMUNITY_AUTH_CREDENTIAL_KEY)).toBe('other-secret')
  })
})

describe('community device auth', () => {
  it('allows only the fixed HTTPS origin and pairing path for browser navigation', () => {
    expect(validateCommunityPairingUrl(`${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}?code=ABCD-1234`))
      .toBe(`${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}?code=ABCD-1234`)
    for (const candidate of [
      `http://xn--gmqtc392bzw0a.xn--6qq986b3xl${COMMUNITY_PAIRING_PAGE_PATH}`,
      `https://example.com${COMMUNITY_PAIRING_PAGE_PATH}`,
      `${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}`,
      `${TRUSTED_COMMUNITY_ORIGIN}/api/device/pairing/start`,
      `${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}#token`,
      `${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}?code=ABCD-1234&code=EXTRA`,
      `https://user@xn--gmqtc392bzw0a.xn--6qq986b3xl${COMMUNITY_PAIRING_PAGE_PATH}`,
    ]) {
      expect(() => validateCommunityPairingUrl(candidate)).toThrow('不受信任')
    }
  })

  it('keeps device secret and bearer token in the main process through start and poll', async () => {
    const store = createMemoryStore()
    const credentials = createSecureCredentials(store, createSafeStorage())
    const openExternal = vi.fn(async () => undefined)
    const remainingAfterStart = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe(TRUSTED_COMMUNITY_ORIGIN)
      if (url.pathname === '/api/device/pairing/start') {
        expect(init?.method).toBe('POST')
        expect(init?.body).toBe('{"device_name":"rust-assistant-desktop"}')
        return json({
          success: true,
          data: {
            pairing_id: 'private-pairing-id',
            device_secret: 'private-device-secret',
            user_code: 'ABCD-1234',
            approval_url: `${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}?code=ABCD-1234`,
            expires_at: 601,
          },
        })
      }
      expect(url.pathname).toBe('/api/device/pairing/poll')
      expect(url.searchParams.get('pairing_id')).toBe('private-pairing-id')
      expect(init?.method).toBe('GET')
      expect(new Headers(init?.headers).get('X-Device-Secret')).toBe('private-device-secret')
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return json({
        success: true,
        data: {
          status: 'claimed',
          token: 'desktop-bearer-token',
          user: { id: 7, username: 'alice', display_name: 'Alice' },
        },
      })
    })
    const auth = createCommunityAuth({ credentials, openExternal, fetch: remainingAfterStart, now: () => 1_000 })

    const pairing = await auth.startPairing()
    expect(pairing).toEqual({ state: 'pairing', userCode: 'ABCD-1234', expiresAt: 601_000, pollAfterMs: 3_000 })
    expect(pairing).not.toHaveProperty('deviceSecret')
    expect(pairing).not.toHaveProperty('token')
    expect(openExternal).toHaveBeenCalledWith(`${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}?code=ABCD-1234`)

    const signedIn = await auth.pollPairing()
    expect(signedIn).toEqual({ state: 'signed-in', user: { id: 7, username: 'alice', displayName: 'Alice' } })
    expect(signedIn).not.toHaveProperty('token')
    expect(String(store.data.get(COMMUNITY_AUTH_CREDENTIAL_KEY))).not.toContain('desktop-bearer-token')
    await expect(credentials.withCredential((value) => value)).resolves.toBe('desktop-bearer-token')
  })

  it('cancels locally and clears the encrypted credential even when remote logout fails', async () => {
    const store = createMemoryStore()
    const credentials = createSecureCredentials(store, createSafeStorage())
    await credentials.saveCredential('desktop-bearer-token')
    const fetcher = vi.fn(async () => json({ success: false, data: null }, 503))
    const auth = createCommunityAuth({ credentials, openExternal: async () => undefined, fetch: fetcher })

    await expect(auth.cancelPairing()).resolves.toEqual({ state: 'signed-in' })
    await expect(auth.logout()).resolves.toEqual({ state: 'signed-out' })
    await expect(credentials.hasCredential()).resolves.toBe(false)
    expect(store.data.get(COMMUNITY_AUTH_CREDENTIAL_KEY)).toBeNull()
  })

  it('surfaces the real server message when pairing start is rejected', async () => {
    const store = createMemoryStore()
    const credentials = createSecureCredentials(store, createSafeStorage())
    const fetcher = vi.fn(async () => json({ success: false, message: '请求过于频繁，请稍后再试' }, 429))
    const auth = createCommunityAuth({ credentials, openExternal: async () => undefined, fetch: fetcher })

    await expect(auth.startPairing()).rejects.toThrow('请求过于频繁，请稍后再试')
  })

  it('stops the pairing flow and surfaces the server message when a manual poll is rate limited', async () => {
    const store = createMemoryStore()
    const credentials = createSecureCredentials(store, createSafeStorage())
    const openExternal = vi.fn(async () => undefined)
    let pollCount = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/device/pairing/start') {
        return json({
          success: true,
          data: {
            pairing_id: 'private-pairing-id',
            device_secret: 'private-device-secret',
            user_code: 'ABCD-1234',
            approval_url: `${TRUSTED_COMMUNITY_ORIGIN}${COMMUNITY_PAIRING_PAGE_PATH}?code=ABCD-1234`,
            expires_at: 700,
          },
        })
      }
      expect(url.pathname).toBe('/api/device/pairing/poll')
      pollCount += 1
      if (pollCount === 1) return json({ success: false, message: '请求过于频繁，请稍后再试' }, 429)
      return json({ success: true, data: { status: 'pending' } })
    })
    const auth = createCommunityAuth({ credentials, openExternal, fetch: fetcher })

    await auth.startPairing()
    await expect(auth.pollPairing()).rejects.toThrow('请求过于频繁，请稍后再试')
    expect(await auth.status()).toEqual({ state: 'signed-out' })
  })
})