import { describe, expect, it, vi } from 'vitest'
import { migrateLegacySettingsCredentials } from '../electron/legacyMigrations'
import { createSecureCredentials, DEEPSEEK_CREDENTIAL_KEY, type SafeStorageAdapter } from '../electron/secureCredentials'

// 测试用的占位值均为无效格式（非真实凭据样式），仅验证迁移行为
const PLACEHOLDER_TOKEN = 'legacy-token-placeholder'
const PLACEHOLDER_KEY = 'legacy-deepseek-key-placeholder'

interface MemoryStore {
  data: Map<string, unknown>
  get(key: string): unknown
  set(key: string, value: unknown): Promise<void>
  flush(): Promise<void>
}

function createMemoryStore(): MemoryStore {
  const data = new Map<string, unknown>()
  return {
    data,
    get: (key) => data.get(key),
    set: async (key, value) => { data.set(key, value) },
    flush: async () => undefined,
  }
}

function createSafeStorage(options: { available?: boolean } = {}): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () => 'os_crypt',
    encryptString: (value) => Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0x5a)),
    decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8'),
  }
}

function createCredentials(store: MemoryStore, useDeepSeekKey: boolean) {
  return createSecureCredentials(store, createSafeStorage(), useDeepSeekKey ? DEEPSEEK_CREDENTIAL_KEY : undefined)
}

describe('legacy settings credential migration', () => {
  it('把旧明文社区令牌与 DeepSeek Key 搬入各自安全存储键并立即擦除落盘', async () => {
    const store = createMemoryStore()
    const flush = vi.spyOn(store, 'flush')
    store.data.set('settings', {
      ai: { communityToken: PLACEHOLDER_TOKEN, deepseekApiKey: PLACEHOLDER_KEY, deepseekModel: 'deepseek-v4-flash' },
    })
    const community = createCredentials(store, false)
    const deepSeek = createCredentials(store, true)

    await migrateLegacySettingsCredentials(store, { community, deepSeek })

    await expect(community.withCredential((v) => v)).resolves.toBe(PLACEHOLDER_TOKEN)
    await expect(deepSeek.withCredential((v) => v)).resolves.toBe(PLACEHOLDER_KEY)
    const settings = store.data.get('settings') as { ai: { communityToken: string; deepseekApiKey: string; deepseekModel: string } }
    expect(settings.ai.communityToken).toBe('')
    expect(settings.ai.deepseekApiKey).toBe('')
    // 其余设置字段原样保留
    expect(settings.ai.deepseekModel).toBe('deepseek-v4-flash')
    // 明文不再出现在任何落盘值里
    expect(JSON.stringify([...store.data.values()])).not.toContain(PLACEHOLDER_TOKEN)
    expect(JSON.stringify([...store.data.values()])).not.toContain(PLACEHOLDER_KEY)
    // 每个凭据各擦除一次 → 至少两次 flush（防抖窗口内崩溃不复活）
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('安全存储不可用时也擦除明文（宁可要求用户重填，不让明文存活）', async () => {
    const store = createMemoryStore()
    store.data.set('settings', { ai: { deepseekApiKey: PLACEHOLDER_KEY } })
    const unavailable = createSecureCredentials(store, createSafeStorage({ available: false }), DEEPSEEK_CREDENTIAL_KEY)

    await migrateLegacySettingsCredentials(store, { community: createCredentials(store, false), deepSeek: unavailable })

    expect((store.data.get('settings') as { ai: { deepseekApiKey: string } }).ai.deepseekApiKey).toBe('')
    expect(JSON.stringify([...store.data.values()])).not.toContain(PLACEHOLDER_KEY)
  })

  it('没有旧明文时不改写设置', async () => {
    const store = createMemoryStore()
    store.data.set('settings', { ai: { deepseekModel: 'deepseek-v4-flash' } })
    const flush = vi.spyOn(store, 'flush')
    const set = vi.spyOn(store, 'set')

    await migrateLegacySettingsCredentials(store, { community: createCredentials(store, false), deepSeek: createCredentials(store, true) })

    expect(set).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(store.data.get('settings')).toEqual({ ai: { deepseekModel: 'deepseek-v4-flash' } })
  })
})
