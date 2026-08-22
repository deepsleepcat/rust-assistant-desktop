import type { CommunityAuthPairing, CommunityAuthStatus, CommunityAuthUser } from '../src/types/bridge'
import type { SecureCredentials } from './secureCredentials'
import {
  getConfiguredCommunityOrigin,
  PRODUCTION_COMMUNITY_ORIGIN,
  LOCAL_COMMUNITY_ORIGIN,
  validateCommunityOrigin as validateConfiguredCommunityOrigin,
} from './communityOrigin'

export { PRODUCTION_COMMUNITY_ORIGIN, LOCAL_COMMUNITY_ORIGIN }
export const TRUSTED_COMMUNITY_ORIGIN = PRODUCTION_COMMUNITY_ORIGIN
export const TRUSTED_COMMUNITY_HOST = 'xn--gmqtc392bzw0a.xn--6qq986b3xl'
export const COMMUNITY_PAIRING_PAGE_PATH = '/device/approve'

const DEVICE_START_PATH = '/api/device/pairing/start'
const DEVICE_POLL_PATH = '/api/device/pairing/poll'
const DEVICE_CANCEL_PATH = '/api/device/pairing/cancel'
const AUTH_LOGOUT_PATH = '/api/auth/logout'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 128 * 1024
const DEFAULT_PAIRING_LIFETIME_MS = 10 * 60 * 1000
const DEFAULT_POLL_DELAY_MS = 3_000

/**
 * 配对轮询按后端 message 文案识别终态（M39 过渡措施：等后端提供机器可读的
 * error_code 后应改为匹配错误码；改文案前只需动这一处）。
 */
const PAIRING_ERROR_MESSAGES = {
  /** 配对不存在或已过期/被拒绝/被取消：本地立即清掉配对状态，回到未登录 */
  terminal: ['配对请求不存在或已过期', '配对已拒绝', '配对已取消'],
  /** 尚未批准：继续轮询等待 */
  pendingApproval: '配对尚未批准',
} as const

function isPairingTerminalMessage(message: unknown): boolean {
  return typeof message === 'string' && (PAIRING_ERROR_MESSAGES.terminal as readonly string[]).includes(message)
}

interface ActivePairing {
  pairingId: string
  deviceSecret: string
  userCode: string
  browserUrl: string
  expiresAt: number
  pollAfterMs: number
}

export interface CommunityAuthService {
  status(): Promise<CommunityAuthStatus>
  startPairing(): Promise<CommunityAuthPairing>
  pollPairing(): Promise<CommunityAuthStatus>
  cancelPairing(): Promise<CommunityAuthStatus>
  logout(): Promise<CommunityAuthStatus>
  /** Main-process-only access for the restricted community proxy. */
  withCredential<T>(use: (credential: string) => Promise<T>): Promise<T | null>
  invalidate(): Promise<void>
}

export interface CommunityAuthDependencies {
  credentials: SecureCredentials
  openExternal(url: string): Promise<void>
  fetch?: typeof fetch
  now?: () => number
}

export class CommunityAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommunityAuthError'
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function successfulData(value: unknown): Record<string, unknown> {
  const envelope = object(value)
  if (!envelope || envelope.success !== true) {
    const message = envelope && typeof envelope.message === 'string' ? envelope.message : ''
    throw new CommunityAuthError(message || '社区配对服务拒绝了该请求')
  }
  const result = object(envelope.data)
  if (!result) throw new CommunityAuthError('社区配对服务返回了无效数据')
  return result
}

function apiUrl(origin: string, path: string, query?: Record<string, string>): URL {
  const base = validateConfiguredCommunityOrigin(origin)
  const url = new URL(path, `${base}/`)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  if (url.pathname !== path || url.username || url.password || url.hash) throw new CommunityAuthError('社区配对地址配置无效')
  return url
}

/** Only the fixed production origin or the explicit local test origin may be opened. */
export function validateCommunityPairingUrl(value: string, expectedOrigin = getConfiguredCommunityOrigin()): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) throw new CommunityAuthError('社区配对地址无效')
  let url: URL
  try { url = new URL(value) } catch { throw new CommunityAuthError('社区配对地址无效') }
  const origin = validateConfiguredCommunityOrigin(url.origin)
  if (
    origin !== validateConfiguredCommunityOrigin(expectedOrigin) ||
    url.pathname !== COMMUNITY_PAIRING_PAGE_PATH ||
    (url.port && origin === PRODUCTION_COMMUNITY_ORIGIN) ||
    url.username ||
    url.password
  ) throw new CommunityAuthError('社区配对地址不受信任')
  const code = url.searchParams.get('code')
  if (!code || url.searchParams.size !== 1 || code.length > 32 || url.hash) throw new CommunityAuthError('社区配对地址不受信任')
  return url.toString()
}

function pairingUrl(userCode: string, origin: string): string {
  const url = new URL(COMMUNITY_PAIRING_PAGE_PATH, `${validateConfiguredCommunityOrigin(origin)}/`)
  url.searchParams.set('code', userCode)
  return validateCommunityPairingUrl(url.toString(), origin)
}

function toPublicPairing(pairing: ActivePairing): CommunityAuthPairing {
  return { state: 'pairing', userCode: pairing.userCode, expiresAt: pairing.expiresAt, pollAfterMs: pairing.pollAfterMs }
}

function toUser(value: unknown): CommunityAuthUser | undefined {
  const data = object(value)
  const id = number(data?.id)
  const username = string(data?.username, 160)
  if (id === null || !username) return undefined
  const displayName = string(data?.display_name, 160)
  const avatarUrl = string(data?.avatar_url, 600)
  return { id, username, ...(displayName ? { displayName } : {}), ...(avatarUrl ? { avatarUrl } : {}) }
}

async function readJson(response: Response): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) throw new CommunityAuthError('社区配对服务响应过大')
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new CommunityAuthError('社区配对服务响应过大')
  const text = new TextDecoder().decode(body).trim()
  if (!text) return {}
  try { return JSON.parse(text) as unknown } catch { throw new CommunityAuthError('社区配对服务返回了无效数据') }
}

function publicStatus(status: unknown): CommunityAuthStatus {
  if (status === 'pending' || status === 'approved') return { state: 'pairing' }
  if (status === 'claimed') return { state: 'signed-in' }
  return { state: 'signed-out' }
}

export function createCommunityAuth(deps: CommunityAuthDependencies): CommunityAuthService {
  const fetcher = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const origin = getConfiguredCommunityOrigin()
  let activePairing: ActivePairing | null = null
  let currentUser: CommunityAuthUser | undefined
  let startInFlight: Promise<CommunityAuthPairing> | null = null
  let operationGeneration = 0

  async function request(url: URL, method: 'GET' | 'POST', body?: Record<string, string>, secret?: string, bearer?: string): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const headers = new Headers({ Accept: 'application/json' })
      if (body) headers.set('Content-Type', 'application/json')
      if (secret) headers.set('X-Device-Secret', secret)
      if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
      const response = await fetcher(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: controller.signal })
      return { response, body: await readJson(response) }
    } catch (error) {
      if (error instanceof CommunityAuthError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') throw new CommunityAuthError('社区配对服务请求超时')
      throw new CommunityAuthError('无法连接社区配对服务')
    } finally {
      clearTimeout(timeout)
    }
  }

  async function status(): Promise<CommunityAuthStatus> {
    if (!deps.credentials.isAvailable()) return { state: 'unavailable' }
    if (activePairing && activePairing.expiresAt <= now()) activePairing = null
    if (activePairing) return { state: 'pairing' }
    if (await deps.credentials.hasCredential()) return { state: 'signed-in', ...(currentUser ? { user: currentUser } : {}) }
    currentUser = undefined
    return { state: 'signed-out' }
  }

  async function start(): Promise<CommunityAuthPairing> {
    if (!deps.credentials.isAvailable()) throw new CommunityAuthError('系统安全凭据存储不可用，无法开始社区配对')
    if (activePairing && activePairing.expiresAt > now()) {
      await deps.openExternal(activePairing.browserUrl)
      return toPublicPairing(activePairing)
    }
    if (await deps.credentials.hasCredential()) throw new CommunityAuthError('当前设备已登录社区账号，请先退出后再配对')
    const { response, body } = await request(apiUrl(origin, DEVICE_START_PATH), 'POST', { device_name: 'rust-assistant-desktop' })
    if (!response.ok) {
      const data = object(body)
      const message = data && typeof data.message === 'string' ? data.message : ''
      throw new CommunityAuthError(message || '社区服务器暂不支持桌面登录，请更新服务器后重试')
    }
    const data = successfulData(body)
    const pairingId = string(data.pairing_id, 128)
    const deviceSecret = string(data.device_secret, 256)
    const userCode = string(data.user_code, 64)
    if (!pairingId || !deviceSecret || !userCode) throw new CommunityAuthError('社区配对服务返回了无效数据')
    const expiresAtSeconds = number(data.expires_at)
    const expiresAt = expiresAtSeconds && expiresAtSeconds > 1_000_000_000 ? expiresAtSeconds * 1000 : now() + DEFAULT_PAIRING_LIFETIME_MS
    const approvalUrl = string(data.approval_url, 1000)
    const browserUrl = approvalUrl
      ? validateCommunityPairingUrl(approvalUrl, origin)
      : pairingUrl(userCode, origin)
    const pairing: ActivePairing = { pairingId, deviceSecret, userCode, browserUrl, expiresAt, pollAfterMs: DEFAULT_POLL_DELAY_MS }
    activePairing = pairing
    try {
      await deps.openExternal(browserUrl)
      return toPublicPairing(pairing)
    } catch (error) {
      activePairing = null
      throw error
    }
  }

  return {
    status,
    withCredential: (apply) => deps.credentials.withCredential(apply),
    invalidate: () => deps.credentials.clearCredential(),
    startPairing: () => {
      if (startInFlight) return startInFlight
      const requestPromise = start()
      startInFlight = requestPromise
      void requestPromise.finally(() => { if (startInFlight === requestPromise) startInFlight = null }).catch(() => undefined)
      return requestPromise
    },
    pollPairing: async () => {
      const generation = operationGeneration
      const pairing = activePairing
      if (!pairing || pairing.expiresAt <= now()) { activePairing = null; return status() }
      const { response, body } = await request(apiUrl(origin, DEVICE_POLL_PATH, { pairing_id: pairing.pairingId }), 'GET', undefined, pairing.deviceSecret)
      if (activePairing !== pairing || operationGeneration !== generation) return status()
      if (!response.ok) {
        const data = object(body)
        if (response.status === 404 || isPairingTerminalMessage(data?.message)) { activePairing = null; return status() }
        if (response.status === 409 && data?.message === PAIRING_ERROR_MESSAGES.pendingApproval) return { state: 'pairing' }
        if (response.status === 429) {
          activePairing = null
          throw new CommunityAuthError(typeof data?.message === 'string' ? data.message : '请求过于频繁，请稍后再试')
        }
        activePairing = null
        throw new CommunityAuthError(typeof data?.message === 'string' ? data.message : '社区设备配对状态查询失败')
      }
      const data = successfulData(body)
      const state = publicStatus(data.status)
      if (state.state === 'pairing') return { state: 'pairing' }
      const token = string(data.token, 8192)
      if (!token) throw new CommunityAuthError('社区配对服务返回了无效会话')
      if (operationGeneration !== generation || activePairing !== pairing) return status()
      await deps.credentials.saveCredential(token)
      currentUser = toUser(data.user)
      activePairing = null
      return { state: 'signed-in', ...(currentUser ? { user: currentUser } : {}) }
    },
    cancelPairing: async () => {
      operationGeneration += 1
      const pairing = activePairing
      activePairing = null
      if (pairing) await request(apiUrl(origin, DEVICE_CANCEL_PATH, { pairing_id: pairing.pairingId }), 'POST', undefined, pairing.deviceSecret).catch(() => undefined)
      return status()
    },
    logout: async () => {
      operationGeneration += 1
      activePairing = null
      try {
        await deps.credentials.withCredential(async (credential) => {
          await request(apiUrl(origin, AUTH_LOGOUT_PATH), 'POST', undefined, undefined, credential).catch(() => undefined)
        })
      } finally {
        currentUser = undefined
        await deps.credentials.clearCredential()
      }
      return status()
    },
  }
}
