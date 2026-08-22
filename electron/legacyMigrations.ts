import type { JsonStore } from './store'
import type { SecureCredentials } from './secureCredentials'

/**
 * 一次性明文凭据迁移（应用启动时调用）：
 * 把设置 JSON 里残留的旧版明文凭据（社区令牌 / DeepSeek API Key）搬入系统安全存储，
 * 无论迁移是否成功都立即擦除明文并落盘——安全存储不可用（Linux 无密钥环等）时
 * 宁可要求用户重新登录/重填，也不让明文继续留在 app-state.json。
 */
export async function migrateLegacySettingsCredentials(
  store: Pick<JsonStore, 'get' | 'set' | 'flush'>,
  credentials: { community: SecureCredentials; deepSeek: SecureCredentials },
): Promise<void> {
  const settings = store.get('settings') as
    | { ai?: { communityToken?: unknown; deepseekApiKey?: unknown } }
    | undefined

  const legacyToken = settings?.ai?.communityToken
  if (typeof legacyToken === 'string' && legacyToken.trim()) {
    try {
      await credentials.community.saveCredential(legacyToken.trim())
      console.info('[auth] 已把旧版社区登录迁移到系统安全存储')
    } catch (error) {
      console.warn('[auth] 安全存储迁移失败，已擦除旧版明文令牌:', error)
    }
    await eraseLegacyCredential(store, 'communityToken')
  }

  // DeepSeek Key：与社区令牌同一模式（迁移成功与否都擦除明文）
  const legacyKey = settings?.ai?.deepseekApiKey
  if (typeof legacyKey === 'string' && legacyKey.trim()) {
    try {
      await credentials.deepSeek.saveCredential(legacyKey.trim())
      console.info('[ai] 已把旧版明文 DeepSeek Key 迁移到系统安全存储')
    } catch (error) {
      console.warn('[ai] 安全存储迁移失败，已擦除旧版明文 Key:', error)
    }
    await eraseLegacyCredential(store, 'deepseekApiKey')
  }
}

/** 擦除设置里某个明文凭据字段；迁移结果必须在继续启动前可靠落盘，
 * 避免进程在防抖写入窗口内崩溃后明文复活。 */
async function eraseLegacyCredential(store: Pick<JsonStore, 'get' | 'set' | 'flush'>, field: 'communityToken' | 'deepseekApiKey'): Promise<void> {
  const current = store.get('settings') as { ai?: Record<string, unknown> } | undefined
  if (!current || typeof current !== 'object') return
  await store.set('settings', {
    ...current,
    ai: { ...(current.ai ?? {}), [field]: '' },
  })
  await store.flush()
}
