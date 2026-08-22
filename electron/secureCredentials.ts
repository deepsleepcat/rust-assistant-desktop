import type { JsonStore } from './store'

/** Main-process-only JSON-store key. Its value is always safeStorage ciphertext encoded as base64. */
export const COMMUNITY_AUTH_CREDENTIAL_KEY = 'communityAuthCredentialV1'
export const DEEPSEEK_CREDENTIAL_KEY = 'deepseekApiKeyV1'

const MAX_CREDENTIAL_LENGTH = 8 * 1024
const ENCRYPTED_CREDENTIAL_PREFIX = 'safe-v1:'

/** The subset of Electron safeStorage needed here, kept injectable for focused tests. */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux may report the insecure basic-text backend when no keyring is available. */
  getSelectedStorageBackend?: () => string
}

export interface SecureCredentials {
  /** False when the operating system key store is not available or would use basic text. */
  isAvailable(): boolean
  hasCredential(): Promise<boolean>
  saveCredential(secret: string): Promise<void>
  clearCredential(): Promise<void>
  /** Runs the callback with a transient decrypted value. Never expose this through IPC. */
  withCredential<T>(apply: (secret: string) => Promise<T> | T): Promise<T | null>
}

export class SecureCredentialsUnavailableError extends Error {
  constructor() {
    super('系统安全凭据存储不可用，无法保存社区登录信息')
    this.name = 'SecureCredentialsUnavailableError'
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Persists a single credential exclusively through Electron safeStorage.
 * There is deliberately no plaintext fallback, including Electron's Linux basic_text backend.
 */
export function createSecureCredentials(store: Pick<JsonStore, 'get' | 'set'>, safeStorage: SafeStorageAdapter, credentialKey = COMMUNITY_AUTH_CREDENTIAL_KEY): SecureCredentials {
  function isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    return safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  }

  async function clearCredential(): Promise<void> {
    await store.set(credentialKey, null)
  }

  async function decryptStoredCredential(): Promise<string | null> {
    const stored = store.get(credentialKey)
    if (stored === null || stored === undefined) return null
    // A plaintext legacy value is not a migration source. Delete it rather than silently retaining it.
    if (!isNonEmptyString(stored) || !isAvailable()) {
      await clearCredential()
      return null
    }
    if (!stored.startsWith(ENCRYPTED_CREDENTIAL_PREFIX)) {
      await clearCredential()
      return null
    }
    try {
      const encoded = stored.slice(ENCRYPTED_CREDENTIAL_PREFIX.length)
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('credential encoding is invalid')
      const decrypted = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      if (!isNonEmptyString(decrypted) || decrypted.length > MAX_CREDENTIAL_LENGTH) throw new Error('credential is invalid')
      return decrypted
    } catch {
      // Corrupt or key-rotated-unreadable ciphertext must never be treated as plaintext.
      await clearCredential()
      return null
    }
  }

  return {
    isAvailable,
    hasCredential: async () => (await decryptStoredCredential()) !== null,
    saveCredential: async (secret) => {
      const normalized = typeof secret === 'string' ? secret.trim() : ''
      if (!normalized || normalized.length > MAX_CREDENTIAL_LENGTH) throw new Error('社区登录凭据无效')
      if (!isAvailable()) throw new SecureCredentialsUnavailableError()
      const encrypted = safeStorage.encryptString(normalized)
      await store.set(credentialKey, `${ENCRYPTED_CREDENTIAL_PREFIX}${encrypted.toString('base64')}`)
    },
    clearCredential,
    withCredential: async (apply) => {
      const credential = await decryptStoredCredential()
      return credential === null ? null : apply(credential)
    },
  }
}
