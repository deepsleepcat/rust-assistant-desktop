import type { CommunityRequest } from '../types/bridge'
import { getCommunityEndpoint, isAllowedCommunityEndpoint } from './communityConfig'

/**
 * 铁锈工坊社区 API 客户端。
 * 只依赖 fetch，既可在 Electron renderer 使用，也可在 Vitest 中注入假 fetch。
 * 认证令牌只进入请求头，不会出现在错误消息或日志中。
 */

export const DEFAULT_COMMUNITY_ENDPOINT = getCommunityEndpoint()
const MAX_ENDPOINT_LENGTH = 500
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export interface CommunityApiEnvelope<T> {
  success: boolean
  message?: string
  data: T | null
}

export interface CommunityHealth {
  ok: boolean
  message: string
  version?: string
}

export interface CommunityUser {
  id: number
  username: string
  display_name?: string
  avatar_url?: string
  email_verified?: boolean
  role?: number
  status?: number
  email?: string
  group?: string
  quota?: number
  used_quota?: number
  request_count?: number
}

export interface CommunityAuthResult {
  token: string
  user: CommunityUser
}

export interface CommunityRegistrationOptions {
  email?: string
  verificationCode?: string
}

export interface CommunityPage<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export type CommunityBoard = string | { id?: string; name?: string; title?: string; post_count?: number }
export interface CommunityTag {
  name: string
  usage_count?: number
  post_count?: number
}

export interface CommunityPost {
  id: number
  board: string
  title: string
  body: string
  author_user_id: number
  author_name: string
  status?: string
  resource_count?: number
  comment_count?: number
  created_at: number
  updated_at: number
  content_type?: 'discussion' | 'dynamic' | 'question' | 'article' | string
  tags?: string[]
  view_count?: number
  like_count?: number
  featured?: boolean
  pinned?: boolean
  accepted_comment_id?: number | null
  liked?: boolean
  following?: boolean
}

export interface CommunityComment {
  id: number
  post_id: number
  author_user_id: number
  author_name: string
  body: string
  created_at: number
  updated_at: number
  status?: string
  accepted?: boolean
}

export interface CommunityResource {
  id: number
  post_id: number
  author_user_id: number
  display_name: string
  content_type: string
  size: number
  sha256: string
  status?: string
  download_count?: number
  created_at: number
  download_url?: string
}

export interface CommunityPostDetail extends CommunityPost {
  resources?: CommunityResource[]
}

export interface CommunityRankingItem {
  id?: number
  post_id?: number
  author_user_id?: number
  title?: string
  author_name?: string
  score?: number
  count?: number
  like_count?: number
  comment_count?: number
  post_count?: number
}

export type PostFeed = 'all' | 'hot' | 'featured' | 'dynamic' | 'question' | 'article'

export interface ListPostsOptions {
  board?: string
  keyword?: string
  feed?: PostFeed
  tag?: string
  page?: number
  pageSize?: number
}

export class CommunityApiError extends Error {
  readonly status: number
  readonly code: 'http' | 'business' | 'network' | 'invalid_response' | 'invalid_endpoint'
  readonly requestId?: string

  constructor(message: string, options: { status?: number; code?: CommunityApiError['code']; requestId?: string } = {}) {
    super(message)
    this.name = 'CommunityApiError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'network'
    this.requestId = options.requestId
  }
}

export function normalizeCommunityEndpoint(input: string): string {
  const value = input.trim().replace(/\/+$/, '')
  if (!value || value.length > MAX_ENDPOINT_LENGTH || !/^https?:\/\//i.test(value)) {
    throw new CommunityApiError('社区服务器地址必须是 http:// 或 https:// 地址', { code: 'invalid_endpoint' })
  }
  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid origin')
    if (!isAllowedCommunityEndpoint(url.origin)) throw new Error('untrusted origin')
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new CommunityApiError('社区服务器地址格式无效', { code: 'invalid_endpoint' })
  }
}

/** 将后端返回的相对头像路径解析为同源 URL；拒绝非 HTTP(S) 协议。 */
export function resolveCommunityUrl(endpoint: string, value: string | undefined): string | null {
  if (!value || value.length > 600) return null
  try {
    const base = new URL(normalizeCommunityEndpoint(endpoint))
    const url = new URL(value, `${base.toString()}/`)
    return /^https?:$/.test(url.protocol) && url.origin === base.origin ? url.toString() : null
  } catch {
    return null
  }
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  return value ? value : undefined
}

async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > maxBytes) throw new CommunityApiError('社区服务器响应过大', { code: 'invalid_response' })
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new CommunityApiError('社区服务器响应过大', { code: 'invalid_response' })
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new CommunityApiError('社区服务器响应过大', { code: 'invalid_response' })
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(response, maxBytes))
}

function errorMessage(status: number, message: string): string {
  if (status === 401) return '社区登录已失效，请重新登录'
  if (status === 403) return message || '当前账号未完成社区认证，暂不能执行此操作'
  return message || `社区服务器请求失败（HTTP ${status}）`
}

async function defaultCommunityFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const bridge = typeof window !== 'undefined' ? window.rustAssistant?.community : undefined
  const source = input instanceof Request ? input.url : String(input)
  if (bridge && source.startsWith(DEFAULT_COMMUNITY_ENDPOINT)) {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() as CommunityRequest['method']
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const requestHeaders: Record<string, string> = {}
    headers.forEach((value, key) => { requestHeaders[key] = value })
    const form = init?.body instanceof FormData ? init.body : null
    const file = form?.get('file')
    if (form && !(file instanceof File)) throw new CommunityApiError('社区附件无效', { code: 'invalid_response' })
    const upload = file instanceof File
      ? { name: file.name, type: file.type, bytes: await file.arrayBuffer() }
      : undefined
    const body = typeof init?.body === 'string' ? init.body : undefined
    // 认证凭据由主进程注入：renderer 的 Authorization 一律剥除，只表达「需要认证」的意图
    const authenticated = headers.has('Authorization') || Boolean((init as { authenticated?: boolean } | undefined)?.authenticated)
    headers.delete('Authorization')
    const sanitizedHeaders: Record<string, string> = {}
    headers.forEach((value, key) => { sanitizedHeaders[key] = value })
    const result = await bridge.request({ url: source, method, headers: sanitizedHeaders, authenticated, body, upload })
    return new Response(result.body, { status: result.status, headers: result.headers })
  }

  if (import.meta.env.DEV) {
    try {
      const url = new URL(source)
      if (url.origin === new URL(DEFAULT_COMMUNITY_ENDPOINT).origin) {
        return await fetch(`/community-api${url.pathname}${url.search}`, init)
      }
    } catch {
      // fetch 会把地址错误转换为统一网络错误。
    }
  }
  return fetch(input, init)
}

export function createCommunityApi(
  endpoint: string,
  token = '',
  fetchImpl: typeof fetch = defaultCommunityFetch,
  onUnauthorized?: () => void,
): CommunityApi {
  const base = normalizeCommunityEndpoint(endpoint)
  const authToken = token.trim()

  async function request<T>(path: string, init: RequestInit = {}, options: { auth?: boolean; maxBytes?: number } = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const headers = new Headers(init.headers)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const requestInit: RequestInit & { authenticated?: boolean } = { ...init, headers, signal: controller.signal }
    if (options.auth !== false && authToken) headers.set('Authorization', `Bearer ${authToken}`)
    if (options.auth !== false) requestInit.authenticated = true
    try {
      const response = await fetchImpl(`${base}${path}`, requestInit)
      const requestId = headerValue(response.headers, 'X-Oneapi-Request-Id')
      const text = await readLimitedText(response, options.maxBytes ?? MAX_RESPONSE_BYTES)
      let payload: CommunityApiEnvelope<T> | null = null
      try {
        payload = text ? JSON.parse(text) as CommunityApiEnvelope<T> : null
      } catch {
        throw new CommunityApiError('社区服务器返回了无效数据', { status: response.status, code: 'invalid_response', requestId })
      }
      if (!response.ok) {
        throw new CommunityApiError(errorMessage(response.status, payload?.message ?? ''), { status: response.status, code: 'http', requestId })
      }
      if (!payload || payload.success !== true) {
        throw new CommunityApiError(errorMessage(response.status, payload?.message ?? '社区服务器拒绝了请求'), { status: response.status, code: 'business', requestId })
      }
      return payload.data as T
    } catch (error) {
      if (error instanceof CommunityApiError) {
        if (error.status === 401) onUnauthorized?.()
        throw error
      }
      if (error instanceof DOMException && error.name === 'AbortError') throw new CommunityApiError('社区服务器请求超时', { code: 'network' })
      throw new CommunityApiError('无法连接社区服务器，请检查网络或服务器地址', { code: 'network' })
    } finally {
      clearTimeout(timer)
    }
  }

  function json<T>(path: string, method: string, body: unknown, auth = true): Promise<T> {
    return request<T>(path, { method, body: JSON.stringify(body) }, { auth })
  }

  return {
    endpoint: base,
    tokenConfigured: Boolean(authToken),
    health: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetchImpl(`${base}/health`, { headers: { Accept: 'application/json' }, signal: controller.signal })
        const text = await readLimitedText(response, 64 * 1024)
        const data = JSON.parse(text) as CommunityHealth
        if (!response.ok || data.ok !== true) throw new CommunityApiError(data.message || '社区服务器不可用', { status: response.status, code: 'http' })
        return { ok: true, message: data.message || 'ok', version: data.version }
      } catch (error) {
        if (error instanceof CommunityApiError) throw error
        if (error instanceof DOMException && error.name === 'AbortError') throw new CommunityApiError('社区服务器请求超时', { code: 'network' })
        throw new CommunityApiError('无法连接社区服务器，请检查网络或服务器地址', { code: 'network' })
      } finally {
        clearTimeout(timer)
      }
    },
    register: (username: string, password: string, options: CommunityRegistrationOptions = {}) => json<CommunityAuthResult>(
      '/api/auth/register',
      'POST',
      {
        username,
        password,
        ...(options.email ? { email: options.email } : {}),
        ...(options.verificationCode ? { verification_code: options.verificationCode } : {}),
      },
      false,
    ),
    login: (username: string, password: string) => json<CommunityAuthResult>('/api/auth/login', 'POST', { username, password }, false),
    requestVerification: (email: string) => request<null>(
      `/api/auth/verification?${query({ email })}`,
      {},
      { auth: false },
    ),
    bindEmail: (email: string, verificationCode: string) => json<CommunityUser>(
      '/api/auth/email/bind',
      'POST',
      { email, verification_code: verificationCode },
    ),
    logout: () => request<null>('/api/auth/logout', { method: 'POST' }),
    me: () => request<CommunityUser>('/api/me'),
    boards: async () => {
      const data = await request<{ items?: CommunityBoard[] }>('/api/community/boards', {}, { auth: false })
      return Array.isArray(data) ? data : (data.items ?? [])
    },
    tags: (keyword = '', page = 1, pageSize = 50) => request<CommunityPage<CommunityTag>>(`/api/community/tags?${query({ keyword, page, page_size: pageSize })}`, {}, { auth: false }),
    posts: (options: ListPostsOptions = {}) => request<CommunityPage<CommunityPost>>(`/api/community/posts?${query({ board: options.board, keyword: options.keyword, feed: options.feed, tag: options.tag, page: options.page ?? 1, page_size: options.pageSize ?? 12 })}`, {}, { auth: false }),
    following: (page = 1, pageSize = 12) => request<CommunityPage<CommunityPost>>(`/api/community/posts/following?${query({ page, page_size: pageSize })}`),
    post: (id: number) => request<CommunityPostDetail>(`/api/community/posts/${encodeURIComponent(id)}`, {}, { auth: false }),
    comments: (postId: number, page = 1, pageSize = 50) => request<CommunityPage<CommunityComment>>(`/api/community/posts/${encodeURIComponent(postId)}/comments?${query({ page, page_size: pageSize })}`, {}, { auth: false }),
    rankings: async (type: 'posts' | 'authors') => {
      const data = await request<{ items?: CommunityRankingItem[]; type?: string } | CommunityRankingItem[]>(`/api/community/rankings?type=${type}`, {}, { auth: false })
      return Array.isArray(data) ? data : (data.items ?? [])
    },
    createPost: (body: { board: string; title: string; body: string; content_type?: string; tags?: string[] }) => json<CommunityPost>('/api/community/posts', 'POST', body),
    updatePost: (id: number, body: { board: string; title: string; body: string; content_type?: string; tags?: string[] }) => json<CommunityPost>(`/api/community/posts/${encodeURIComponent(id)}`, 'PUT', body),
    deletePost: (id: number) => request<null>(`/api/community/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    uploadResource: async (postId: number, file: File) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return request<CommunityResource>(`/api/community/posts/${encodeURIComponent(postId)}/resources`, { method: 'POST', body: form })
    },
    deleteResource: (id: number) => request<null>(`/api/community/resources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    createComment: (postId: number, body: string) => json<CommunityComment>(`/api/community/posts/${encodeURIComponent(postId)}/comments`, 'POST', { body }),
    updateComment: (id: number, body: string) => json<CommunityComment>(`/api/community/comments/${encodeURIComponent(id)}`, 'PUT', { body }),
    deleteComment: (id: number) => request<null>(`/api/community/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    like: (id: number) => request<null>(`/api/community/posts/${encodeURIComponent(id)}/like`, { method: 'POST' }),
    unlike: (id: number) => request<null>(`/api/community/posts/${encodeURIComponent(id)}/like`, { method: 'DELETE' }),
    follow: (id: number) => request<null>(`/api/community/authors/${encodeURIComponent(id)}/follow`, { method: 'POST' }),
    unfollow: (id: number) => request<null>(`/api/community/authors/${encodeURIComponent(id)}/follow`, { method: 'DELETE' }),
    download: async (id: number) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      try {
        const headers = new Headers({ Accept: '*/*' })
        if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
        const response = await fetchImpl(`${base}/api/community/resources/${encodeURIComponent(id)}/download`, { headers, signal: controller.signal })
        const length = Number(response.headers.get('content-length') ?? '')
        if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new CommunityApiError('下载资源超过 50 MiB 限制', { status: response.status, code: 'invalid_response' })
        if (!response.ok) {
          const text = await readLimitedText(response, 64 * 1024)
          let message = ''
          try { message = (JSON.parse(text) as { message?: string }).message ?? '' } catch { /* 附件错误可能不是 JSON */ }
          const error = new CommunityApiError(errorMessage(response.status, message), { status: response.status, code: 'http' })
          if (response.status === 401) onUnauthorized?.()
          throw error
        }
        const bytes = await readLimitedBytes(response, MAX_DOWNLOAD_BYTES)
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: response.headers.get('content-type') ?? '' })
        const disposition = response.headers.get('content-disposition') ?? ''
        const filenamePart = disposition.split(';').find((part) => part.trim().toLowerCase().startsWith('filename=') || part.trim().toLowerCase().startsWith('filename*='))
        const rawFilename = filenamePart ? filenamePart.slice(filenamePart.indexOf('=') + 1).trim().replace(/^UTF-8''/i, '').replace(/^"|"$/g, '') : 'community-resource'
        const decodedFilename = decodeURIComponent(rawFilename)
        const filename = decodedFilename.replace(/[\\/\0\r\n]/g, '_').replace(/^\.+$/, '_').slice(0, 180) || 'community-resource'
        return { blob, filename, contentType: response.headers.get('content-type') ?? blob.type }
      } catch (error) {
        if (error instanceof CommunityApiError) throw error
        if (error instanceof DOMException && error.name === 'AbortError') throw new CommunityApiError('资源下载超时', { code: 'network' })
        throw new CommunityApiError('资源下载失败', { code: 'network' })
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function query(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

export interface CommunityApi {
  endpoint: string
  tokenConfigured: boolean
  health(): Promise<CommunityHealth>
  register(username: string, password: string, options?: CommunityRegistrationOptions): Promise<CommunityAuthResult>
  login(username: string, password: string): Promise<CommunityAuthResult>
  requestVerification(email: string): Promise<null>
  bindEmail(email: string, verificationCode: string): Promise<CommunityUser>
  logout(): Promise<null>
  me(): Promise<CommunityUser>
  boards(): Promise<CommunityBoard[]>
  tags(keyword?: string, page?: number, pageSize?: number): Promise<CommunityPage<CommunityTag>>
  posts(options?: ListPostsOptions): Promise<CommunityPage<CommunityPost>>
  following(page?: number, pageSize?: number): Promise<CommunityPage<CommunityPost>>
  post(id: number): Promise<CommunityPostDetail>
  comments(postId: number, page?: number, pageSize?: number): Promise<CommunityPage<CommunityComment>>
  rankings(type: 'posts' | 'authors'): Promise<CommunityRankingItem[]>
  createPost(body: { board: string; title: string; body: string; content_type?: string; tags?: string[] }): Promise<CommunityPost>
  updatePost(id: number, body: { board: string; title: string; body: string; content_type?: string; tags?: string[] }): Promise<CommunityPost>
  deletePost(id: number): Promise<null>
  uploadResource(postId: number, file: File): Promise<CommunityResource>
  deleteResource(id: number): Promise<null>
  createComment(postId: number, body: string): Promise<CommunityComment>
  updateComment(id: number, body: string): Promise<CommunityComment>
  deleteComment(id: number): Promise<null>
  like(id: number): Promise<null>
  unlike(id: number): Promise<null>
  follow(id: number): Promise<null>
  unfollow(id: number): Promise<null>
  download(id: number): Promise<{ blob: Blob; filename: string; contentType: string }>
}
