import { getCommunityEndpoint } from './communityConfig'
import { normalizeCommunityEndpoint } from './communityApi'

const DEFAULT_COMMUNITY_ENDPOINT = getCommunityEndpoint()

/**
 * 仪表盘 API 客户端（与后端 docs/DASHBOARD-API.md 使用同一契约）。
 *
 * - 余额只来自 gateway.users.quota（单位“计费额度”），不换算 Token，不出现
 *   remaining/tokenQuota 字段；
 * - 用量 Token 数值为 null=未记录/来源不可靠，只有后端标 upstream 的准确值才显示；
 * - 同时检查 HTTP 状态与信封 success，任一失败都抛 DashboardApiError。
 *
 * 认证：Electron 下 Authorization 由主进程注入（authenticated 意图），renderer 不接触令牌。
 */

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 512 * 1024

export type DashboardRange = '7d' | '30d' | '90d'
export type DashboardCoverage = 'complete' | 'partial' | 'unavailable'
export type UsageSource = 'upstream' | 'gateway_estimate' | 'unavailable'

export interface DashboardEnvelope<T> {
  success: boolean
  data: T | null
  message: string
  code?: string
}

export interface DashboardWindow {
  start: string
  end: string
  timezone: 'UTC'
}

export interface DashboardCounts {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export interface DashboardFieldCoverage {
  exactRequestCount: number
  coverage: DashboardCoverage
}

export interface DashboardSummary extends DashboardCounts {
  requestCount: number
  exactRequestCount: number
  coverage: DashboardCoverage
  reason: string | null
  fieldCoverage: Record<keyof DashboardCounts, DashboardFieldCoverage>
}

export interface DashboardSeriesDay extends DashboardSummary {
  date: string
}

export interface DashboardBalance {
  amount: number | null
  unit: string
  source: string | null
  reason: string | null
}

export interface DashboardCallLog extends DashboardCounts {
  id: string
  createdAt: string
  model: string
  reasoningEffort: string | null
  usageSource: UsageSource
  reason: string | null
}

export interface DashboardLogs {
  range: DashboardRange
  window: DashboardWindow
  page: number
  pageSize: number
  total: number
  items: DashboardCallLog[]
}

export interface DashboardData {
  range: DashboardRange
  window: DashboardWindow
  balance: DashboardBalance
  usage: DashboardSummary
  series: DashboardSeriesDay[]
  logs: DashboardLogs
}

export type DashboardSlot = 'balance' | 'tokens'
export interface DashboardLayout {
  version: 1
  slots: [DashboardSlot, DashboardSlot]
}

export class DashboardApiError extends Error {
  readonly status: number
  readonly kind: 'http' | 'business' | 'network' | 'invalid_response' | 'invalid_endpoint' | 'timeout'
  readonly code?: string

  constructor(message: string, options: { status?: number; kind?: DashboardApiError['kind']; code?: string } = {}) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = options.status ?? 0
    this.kind = options.kind ?? 'network'
    this.code = options.code
  }
}

function defaultDashboardFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const bridge = typeof window !== 'undefined' ? window.rustAssistant?.community : undefined
  const url = input instanceof Request ? input.url : String(input)
  if (bridge && url.startsWith(DEFAULT_COMMUNITY_ENDPOINT)) {
    const method = ((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE')
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const headerRecord: Record<string, string> = {}
    headers.forEach((value, key) => { headerRecord[key] = value })
    const body = typeof init?.body === 'string' ? init.body : undefined
    // 令牌只由主进程注入；renderer 一律只表达“需要认证”的意图。
    const authenticated = headers.has('Authorization') || Boolean((init as { authenticated?: boolean } | undefined)?.authenticated)
    headers.delete('Authorization')
    const sanitized: Record<string, string> = {}
    headers.forEach((value, key) => { sanitized[key] = value })
    return bridge.request({ url, method, headers: sanitized, authenticated, body })
      .then((result) => new Response(result.body, { status: result.status, headers: result.headers }))
  }
  if (import.meta.env.DEV) {
    try {
      const target = new URL(url)
      if (target.origin === new URL(DEFAULT_COMMUNITY_ENDPOINT).origin) {
        return fetch(`/community-api${target.pathname}${target.search}`, init)
      }
    } catch {
      // fetch 会把地址错误转换为统一网络错误。
    }
  }
  return fetch(input, init)
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > maxBytes) throw new DashboardApiError('仪表盘服务器响应过大', { kind: 'invalid_response', status: response.status })
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new DashboardApiError('仪表盘服务器响应过大', { kind: 'invalid_response', status: response.status })
    return new TextDecoder().decode(bytes)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new DashboardApiError('仪表盘服务器响应过大', { kind: 'invalid_response', status: response.status })
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(out)
}

function errorMessage(status: number, message: string): string {
  if (status === 401) return '社区登录已失效，请重新登录'
  if (status === 403) return message || '当前账号没有访问仪表盘的权限'
  if (status === 503) return message || '仪表盘数据源暂不可用'
  return message || `仪表盘请求失败（HTTP ${status}）`
}

export interface DashboardApiOptions {
  fetchImpl?: typeof fetch
  authenticated?: boolean
  onUnauthorized?: () => void
}

export interface DashboardRequestOptions {
  signal?: AbortSignal
}

export function createDashboardApi(endpoint: string, options: DashboardApiOptions = {}) {
  const base = normalizeCommunityEndpoint(endpoint)
  const fetchImpl = options.fetchImpl ?? defaultDashboardFetch

  async function request<T>(path: string, init: RequestInit & { authenticated?: boolean } = {}, requestOptions: DashboardRequestOptions = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const onExternalAbort = () => controller.abort()
    if (requestOptions.signal) {
      if (requestOptions.signal.aborted) controller.abort()
      else requestOptions.signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const headers = new Headers(init.headers)
      if (!headers.has('Accept')) headers.set('Accept', 'application/json')
      if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      const requestInit: RequestInit & { authenticated?: boolean } = { ...init, headers, signal: controller.signal, authenticated: init.authenticated ?? options.authenticated ?? true }
      const response = await fetchImpl(`${base}${path}`, requestInit)
      const text = await readLimitedText(response, MAX_RESPONSE_BYTES)
      let payload: DashboardEnvelope<T> | null = null
      try {
        payload = text ? (JSON.parse(text) as DashboardEnvelope<T>) : null
      } catch {
        throw new DashboardApiError('仪表盘服务器返回了无效数据', { kind: 'invalid_response', status: response.status })
      }
      // 同时检查 HTTP 状态与信封 success：任何一侧失败都视为失败。
      if (!response.ok) {
        throw new DashboardApiError(errorMessage(response.status, payload?.message ?? ''), {
          kind: 'http', status: response.status, code: payload?.code,
        })
      }
      if (!payload || payload.success !== true) {
        throw new DashboardApiError(errorMessage(response.status, payload?.message || '仪表盘服务器拒绝了请求'), {
          kind: 'business', status: response.status, code: payload?.code,
        })
      }
      if (payload.data === null || payload.data === undefined) {
        throw new DashboardApiError('仪表盘服务器返回了空数据', { kind: 'invalid_response', status: response.status })
      }
      return payload.data
    } catch (error) {
      if (error instanceof DashboardApiError) {
        if (error.status === 401) options.onUnauthorized?.()
        throw error
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (requestOptions.signal?.aborted) throw new DashboardApiError('仪表盘请求已取消', { kind: 'network' })
        throw new DashboardApiError('仪表盘服务器请求超时', { kind: 'timeout' })
      }
      throw new DashboardApiError('无法连接社区服务器，请检查网络或服务器地址', { kind: 'network' })
    } finally {
      clearTimeout(timer)
      requestOptions.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  const rangeQuery = (range: DashboardRange) => `range=${encodeURIComponent(range)}`

  return {
    endpoint: base,
    dashboard(range: DashboardRange = '7d', requestOptions?: DashboardRequestOptions): Promise<DashboardData> {
      return request<DashboardData>(`/api/community/dashboard?${rangeQuery(range)}`, {}, requestOptions)
    },
    logs(range: DashboardRange = '7d', page = 1, pageSize = 20, requestOptions?: DashboardRequestOptions): Promise<DashboardLogs> {
      return request<DashboardLogs>(`/api/community/dashboard/logs?${rangeQuery(range)}&page=${page}&pageSize=${pageSize}`, {}, requestOptions)
    },
    layout(requestOptions?: DashboardRequestOptions): Promise<DashboardLayout> {
      return request<DashboardLayout>('/api/community/dashboard/layout', {}, requestOptions)
    },
    putLayout(layout: DashboardLayout, requestOptions?: DashboardRequestOptions): Promise<DashboardLayout> {
      return request<DashboardLayout>('/api/community/dashboard/layout', { method: 'PUT', body: JSON.stringify(layout) }, requestOptions)
    },
  }
}

export type DashboardApi = ReturnType<typeof createDashboardApi>
