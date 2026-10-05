import type { CommunityRequest } from '../types/bridge'
import { getCommunityEndpoint } from './communityConfig'

/**
 * 云书包（社区模组仓库）API 客户端。
 * 端点族固定为 `/api/community/cloudbag/**`（桌面 IPC 前缀族已覆盖，JSON 端点零发版）。
 * 与 communityApi 同注入模式：只依赖 fetch，Vitest 注入假 fetch；渲染层不持有令牌，
 * 认证凭据由主进程经 community:request IPC 注入（authenticated 意图标记）。
 * 信封沿用社区 `{success, message, data}`，新增平级 `code`（机器可读错误码，J3：
 * 业务错误一律 HTTP 200 + success:false；桌面只按 code 分支，绝不按 HTTP 状态码分支）。
 */

export const MAX_BLOB_BYTES = 50 * 1024 * 1024
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024
const MAX_TREE_FILE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * blob 上传时限策略（与主进程 electron/cloudbagTree.ts 同公式同值，由测试锁定一致）：
 * 单个 blob 上限 50MiB，若沿用 15s 的 JSON 超时，等于要求 ≥3.34MiB/s 的持续上行——
 * 普通家庭宽带上行远达不到，合法大文件必然「上传超时」并重试三次全部白费带宽。
 * 改为「下限 60s + 按字节数线性放宽」（假定 256KiB/s 的保守上行速率）。
 */
export const CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS = 60_000
export const CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC = 256 * 1024

export function cloudBagUploadTimeoutMs(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS
  const scaled = Math.ceil(bytes / CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC) * 1000
  return Math.max(CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS, scaled)
}

export type CloudBagVisibility = 'private' | 'public' | 'link'

export interface CloudBagRepo {
  id: number
  slug: string
  title: string
  description: string
  visibility: CloudBagVisibility
  tags: string[]
  headVersionNo: number
  fileCount: number
  versionCount: number
  totalSize: number
  postId: number | null
  quota: { usedBytes: number; limitBytes: number }
  myRole: 'owner' | 'editor' | 'viewer' | null
  updatedAt: number // unix 秒
}

export interface CloudBagTreeEntry {
  path: string
  size: number
  sha256: string
}

export interface CloudBagManifest {
  title: string
  description: string
  thumbnail: string
  version: string
  author: string
  update: string
  minVersion: string
  /** 警告性：树内引用缺失列表（不阻断） */
  brokenRefs: string[]
}

export interface CloudBagVersion {
  id: number
  versionNo: number
  parentVersionNo: number | null
  message: string
  manifest: CloudBagManifest
  fileCount: number
  totalSize: number
  createdByUserId: number
  createdAt: number
}

export interface CloudBagDiffEntry {
  path: string
  change: 'added' | 'removed' | 'modified'
}

export interface CloudBagSyncSession {
  id: string
  status: 'open' | 'committed' | 'aborted'
  files: Array<{ path: string; sha256: string; state: 'pending' | 'done' | 'failed' }>
}

export type CloudBagErrorCode =
  | 'version_conflict'
  | 'quota_exceeded'
  | 'file_too_large'
  | 'unsupported_extension'
  | 'invalid_path'
  | 'manifest_parse_failed'
  | 'object_hash_mismatch'
  | 'not_found'
  | 'forbidden'

export interface CloudBagMember {
  userId: number
  role: 'owner' | 'editor' | 'viewer'
  username?: string
  displayName?: string
}

export interface CloudBagRelease {
  id: number
  versionId: number
  versionNo?: number
  name: string
  notes: string
  status: 'draft' | 'published' | 'revoked'
  publishedAt: number | null
  createdAt: number
}

export interface CloudBagShare {
  id: number
  url?: string
  token?: string
  expiresAt: number | null
  versionNo?: number | null
  maxDownloads?: number
  downloadCount?: number
  revokedAt?: number
  createdAt?: number
}

/** version_conflict 应答里的远端 head 摘要（后端 cloudbag_version.go 的 headSummary 对象；
 * 契约 §7.1 与后端一致：files 超 200 条时截断并置 truncated）。 */
export interface CloudBagHeadSummaryFile {
  path: string
  sha256: string
  size?: number
}

export interface CloudBagHeadSummaryDetail {
  versionNo: number
  message: string
  fileCount: number
  totalSize: number
  files: CloudBagHeadSummaryFile[]
  truncated?: boolean
}

export interface CloudBagHeadSummary {
  headVersionNo: number
  headSummary?: CloudBagHeadSummaryDetail
}

export interface CloudBagPage<T> {
  items: T[]
  total?: number
  page?: number
  page_size?: number
  nextCursor?: string | null
}

export interface CreateCloudBagRepoInput {
  title: string
  /** 标识建议：服务端命名为 slug（后端 cloudBagRepoRequest.Slug，与网页端逐字一致），
   * 撞名或非法时由服务端自动生成——占位符已写明「最终以服务端生成为准」。 */
  slugSuggestion?: string
  description?: string
  visibility?: CloudBagVisibility
  tags?: string[]
}

export interface UpdateCloudBagRepoInput {
  title?: string
  description?: string
  visibility?: CloudBagVisibility
  tags?: string[]
  coverPath?: string
  postId?: number | null
}

export interface PushCloudBagVersionInput {
  baseVersionNo: number
  message: string
  clientOpId: string
  files: Array<{ path: string; sha256: string }>
  restoreFrom?: number
}

export interface BlobUploadInput {
  sessionId: string
  path: string
  sha256: string
  bytes: ArrayBuffer
  fileName: string
  contentType: string
}

export interface CloudBagDownload {
  bytes: ArrayBuffer
  filename: string
  contentType: string
}

/** 云书包错误：business 携带后端 code；network/http 与社区客户端语义一致。
 * timeout 单列一档：超时不是「连不上」，且重试会把整包重发（大文件在慢上行链路上
 * 永远传不完），必须让调用方按不可重试处理并给出与网络故障不同的文案。 */
export type CloudBagApiErrorKind = CloudBagErrorCode | 'http' | 'network' | 'timeout' | 'invalid_response' | 'invalid_endpoint'

export class CloudBagApiError extends Error {
  readonly kind: CloudBagApiErrorKind
  readonly status: number
  /** version_conflict 时携带服务端 head 清单摘要（J3：不看 HTTP 状态码） */
  readonly conflict: CloudBagHeadSummary | null

  constructor(message: string, options: { kind?: CloudBagApiErrorKind; status?: number; conflict?: CloudBagHeadSummary | null } = {}) {
    super(message)
    this.name = 'CloudBagApiError'
    this.kind = options.kind ?? 'network'
    this.status = options.status ?? 0
    this.conflict = options.conflict ?? null
  }
}

/** code → 用户文案（桌面契约 §8 逐字映射；网络层错误另有统一文案） */
const CODE_MESSAGES: Record<CloudBagErrorCode, string> = {
  version_conflict: '远端已有新版本，请先查看差异再选择合并方式',
  quota_exceeded: '云书包空间不足（请查看仓库配额占用）',
  file_too_large: '单文件超过 50 MiB，本轮不支持更大文件',
  unsupported_extension: '该文件类型不在模组资产白名单内',
  invalid_path: '文件路径不合法',
  manifest_parse_failed: 'mod-info.txt 解析失败，无法识别模组信息',
  object_hash_mismatch: '文件校验不一致，请重试上传',
  forbidden: '你在该仓库没有执行此操作的权限',
  not_found: '仓库或版本不存在',
}

export function describeCloudBagCode(code: string): string {
  const mapped = CODE_MESSAGES[code as CloudBagErrorCode]
  return mapped ?? '云书包操作失败'
}

/**
 * 后端信封的 data 按端点专属键包裹（repo / version / sync / share）。
 * 统一在此展开，避免把整个 data 当成实体使用（契约 §3：data 形状逐端点固定）。
 * 键缺失时回退整包（防御式，不伪造字段）。
 */
function unwrapKey<T>(data: unknown, key: string): T {
  if (data && typeof data === 'object' && key in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>)[key] as T
  }
  return data as T
}

interface CloudBagEnvelope<T> {
  success: boolean
  message?: string
  data: T | null
  code?: string
}

/**
 * 超限文案：明确这是**桌面端本地上限**，不是服务端响应过大。
 * 服务端导出默认上限 512MiB，桌面 V1 只支持 50MiB（单文件与单次导出/拉取同）；
 * 旧文案「云书包响应过大」把客户端限制说成服务端问题，用户无从定位。
 */
function localLimitMessage(maxBytes: number): string {
  const mib = Math.round(maxBytes / (1024 * 1024))
  return `响应超过桌面端本地上限（${mib} MiB）——这是客户端限制而非服务端响应过大；更大的内容请在社区网页端操作`
}

/** 超时文案：上传类请求（时限按字节数放宽）与普通 JSON 请求分开，避免把「本地上传通道
 * 太慢/上限」误导成服务端故障。 */
function timeoutMessage(timeoutMs: number): string {
  if (timeoutMs > REQUEST_TIMEOUT_MS) {
    return `上传超时（本次请求时限 ${Math.round(timeoutMs / 1000)}s，已按文件大小放宽）：请检查上行网络，或到社区网页端上传该文件`
  }
  return '社区服务器请求超时'
}

async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > maxBytes) throw new CloudBagApiError(localLimitMessage(maxBytes), { kind: 'invalid_response' })
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new CloudBagApiError(localLimitMessage(maxBytes), { kind: 'invalid_response' })
    return bytes
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
        throw new CloudBagApiError(localLimitMessage(maxBytes), { kind: 'invalid_response' })
      }
      chunks.push(next.value)
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

/**
 * 让 IPC 桥接调用也响应 AbortSignal：IPC 本身不可取消，但渲染层可以不再等待，
 * 由调用方的 AbortController 决定超时（否则声明的 REQUEST_TIMEOUT_MS 在桥接路径上完全失效）。
 */
async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** 主进程凭据被拒（社区登录失效）是鉴权错误，不是网络故障：如实映射，别归因到网络。 */
function bridgeAuthError(error: unknown, onUnauthorized?: () => void): CloudBagApiError | null {
  if (error instanceof Error && /登录已失效/.test(error.message)) {
    onUnauthorized?.()
    return new CloudBagApiError('社区登录已失效，请重新登录', { kind: 'http', status: 401 })
  }
  return null
}

/** 桥接 fetch：同源社区请求走 community:request IPC（主进程注入凭据），其余直连（测试注入用） */
async function defaultCloudBagFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const bridge = typeof window !== 'undefined' ? window.rustAssistant?.community : undefined
  const source = input instanceof Request ? input.url : String(input)
  if (bridge && source.startsWith(getCommunityEndpoint())) {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() as CommunityRequest['method']
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const requestHeaders: Record<string, string> = {}
    headers.forEach((value, key) => { requestHeaders[key] = value })
    const form = init?.body instanceof FormData ? init.body : null
    let upload: CommunityRequest['upload'] | undefined
    if (form) {
      const file = form.get('file')
      if (!(file instanceof File)) throw new CloudBagApiError('云书包上传内容无效', { kind: 'invalid_response' })
      const fields: Record<string, string> = {}
      form.forEach((value, key) => {
        if (key !== 'file' && typeof value === 'string') fields[key] = value
      })
      upload = { name: file.name, type: file.type, bytes: await file.arrayBuffer(), fields }
    }
    const body = typeof init?.body === 'string' ? init.body : undefined
    const requestInit: RequestInit & { authenticated?: boolean } = { ...init, headers, body }
    // 认证凭据由主进程注入：renderer 的 Authorization 一律剥除，只表达「需要认证」的意图
    const authenticated = headers.has('Authorization') || Boolean(requestInit.authenticated)
    headers.delete('Authorization')
    const sanitizedHeaders: Record<string, string> = {}
    headers.forEach((value, key) => { sanitizedHeaders[key] = value })
    const result = await awaitWithSignal(
      bridge.request({ url: source, method, headers: sanitizedHeaders, authenticated, body, upload }),
      init?.signal,
    )
    return new Response(result.body, { status: result.status, headers: result.headers })
  }
  if (import.meta.env.DEV) {
    // 与 communityApi 同形的开发期同源代理回退：浏览器预览下云书包请求不应直连网关
    // （与同页社区帖子走 /community-api 的机制不一致，且会受部署端 CORS 头影响）。
    try {
      const url = new URL(source)
      if (url.origin === new URL(getCommunityEndpoint()).origin) {
        return await fetch(`/community-api${url.pathname}${url.search}`, init)
      }
    } catch {
      // URL 解析失败时退回下面的直连，fetch 会给出统一网络错误。
    }
  }
  return fetch(input, init)
}

function query(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VERSION_NO_RE = /^\d{1,9}$/

function assertSlug(slug: string, label = '仓库'): string {
  if (!SLUG_RE.test(slug)) throw new CloudBagApiError(`${label}标识不合法`, { kind: 'invalid_response' })
  return encodeURIComponent(slug)
}

function assertVersionNo(no: number | string): string {
  const value = String(no)
  if (!VERSION_NO_RE.test(value)) throw new CloudBagApiError('版本号不合法', { kind: 'invalid_response' })
  return value
}

export function createCloudBagApi(
  endpoint: string,
  fetchImpl: typeof fetch = defaultCloudBagFetch,
  onUnauthorized?: () => void,
): CloudBagApi {
  let base = endpoint.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base) || base.length > 500) throw new CloudBagApiError('社区服务器地址格式无效', { kind: 'invalid_endpoint' })
  try {
    const parsed = new URL(base)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin')
    base = parsed.toString().replace(/\/+$/, '')
  } catch {
    throw new CloudBagApiError('社区服务器地址格式无效', { kind: 'invalid_endpoint' })
  }

  /** 信封解析：HTTP 恒按 200 信封处理业务错误（J3），code 决定分支与文案。
   * timeoutMs 可由调用方覆盖（blob 上传按字节数放宽，见 cloudBagUploadTimeoutMs）。 */
  async function request<T>(path: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const headers = new Headers(init.headers)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const requestInit: RequestInit & { authenticated?: boolean } = { ...init, headers, signal: controller.signal, authenticated: true }
    try {
      const response = await fetchImpl(`${base}${path}`, requestInit)
      const text = await readLimitedText(response, 2 * 1024 * 1024)
      let payload: CloudBagEnvelope<T> | null = null
      try {
        payload = text ? JSON.parse(text) as CloudBagEnvelope<T> : null
      } catch {
        throw new CloudBagApiError('社区服务器返回了无效数据', { kind: 'invalid_response', status: response.status })
      }
      if (response.status === 401) {
        onUnauthorized?.()
        throw new CloudBagApiError('社区登录已失效，请重新登录', { kind: 'http', status: 401 })
      }
      if (!response.ok) {
        throw new CloudBagApiError(payload?.message || `社区服务器请求失败（HTTP ${response.status}）`, { kind: 'http', status: response.status })
      }
      if (!payload || payload.success !== true) {
        const code = payload?.code
        const conflict = code === 'version_conflict' && payload?.data && typeof payload.data === 'object'
          ? (payload.data as unknown as CloudBagHeadSummary)
          : null
        const message = code ? describeCloudBagCode(code) : (payload?.message || '云书包操作失败')
        throw new CloudBagApiError(message, { kind: (code as CloudBagErrorCode) ?? 'invalid_response', status: response.status, conflict })
      }
      return payload.data as T
    } catch (error) {
      if (error instanceof CloudBagApiError) throw error
      const auth = bridgeAuthError(error, onUnauthorized)
      if (auth) throw auth
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new CloudBagApiError(timeoutMessage(timeoutMs), { kind: 'timeout' })
      }
      // 主进程侧的 60s/size-scaled 超时也是「超时」而不是「连不上」：分类为 timeout 才能
      // 避免调用方按 network 反复重发整包（渲染层的 abort 并不会中断主进程那次传输）。
      if (error instanceof Error && /超时/.test(error.message)) {
        throw new CloudBagApiError(timeoutMessage(timeoutMs), { kind: 'timeout' })
      }
      throw new CloudBagApiError('连接社区服务器失败，请检查网络后重试', { kind: 'network' })
    } finally {
      clearTimeout(timer)
    }
  }

  function json<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<T> {
    return request<T>(path, { method, body: JSON.stringify(body) })
  }

  return {
    endpoint: base,
    repos: (options: { mine?: boolean; q?: string; tag?: string; sort?: string; page?: number; pageSize?: number } = {}) =>
      request<CloudBagPage<CloudBagRepo>>(`/api/community/cloudbag/repos?${query({
        mine: options.mine ? 1 : undefined,
        q: options.q,
        tag: options.tag,
        sort: options.sort,
        page: options.page ?? 1,
        page_size: options.pageSize ?? 12,
      })}`),
    repo: async (slug: string) =>
      unwrapKey<CloudBagRepo>(await request<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}`), 'repo'),
    createRepo: async (input: CreateCloudBagRepoInput) =>
      unwrapKey<CloudBagRepo>(await json<unknown>('/api/community/cloudbag/repos', 'POST', {
        title: input.title,
        // 键名 slug（不是 slug_suggestion）：后端结构体只认 slug，未知键被
        // encoding/json 静默忽略 → 用户填写的标识永不生效。
        ...(input.slugSuggestion ? { slug: input.slugSuggestion } : {}),
        description: input.description ?? '',
        visibility: input.visibility ?? 'private',
        tags: input.tags ?? [],
      }), 'repo'),
    updateRepo: async (slug: string, input: UpdateCloudBagRepoInput) =>
      unwrapKey<CloudBagRepo>(await json<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}`, 'PUT', {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.coverPath !== undefined ? { cover_path: input.coverPath } : {}),
        ...(input.postId !== undefined ? { post_id: input.postId } : {}),
      }), 'repo'),
    deleteRepo: async (slug: string) => request<null>(`/api/community/cloudbag/repos/${assertSlug(slug)}`, { method: 'DELETE' }),
    versions: async (slug: string, cursor?: string, limit = 20) =>
      request<CloudBagPage<CloudBagVersion>>(`/api/community/cloudbag/repos/${assertSlug(slug)}/versions?${query({ cursor, limit })}`),
    version: async (slug: string, versionNo: number) =>
      unwrapKey<CloudBagVersion>(
        await request<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}/versions/${assertVersionNo(versionNo)}`),
        'version',
      ),
    tree: async (slug: string, versionNo: number, cursor?: string, limit = 200) =>
      request<CloudBagPage<CloudBagTreeEntry>>(`/api/community/cloudbag/repos/${assertSlug(slug)}/versions/${assertVersionNo(versionNo)}/tree?${query({ cursor, limit })}`),
    file: async (slug: string, versionNo: number, path: string): Promise<{ bytes: ArrayBuffer; contentType: string }> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') || path.includes('\\') || path.includes('\0')) {
          throw new CloudBagApiError('文件路径不合法', { kind: 'invalid_path' })
        }
        const response = await fetchImpl(`${base}/api/community/cloudbag/repos/${assertSlug(slug)}/versions/${assertVersionNo(versionNo)}/file?${query({ path })}`, {
          headers: { Accept: '*/*' },
          signal: controller.signal,
          authenticated: true,
        } as RequestInit & { authenticated?: boolean })
        if (response.status === 401) onUnauthorized?.()
        if (!response.ok) throw new CloudBagApiError('文件读取失败', { kind: 'http', status: response.status })
        const bytes = await readLimitedBytes(response, MAX_TREE_FILE_BYTES)
        return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
      } catch (error) {
        if (error instanceof CloudBagApiError) throw error
        const auth = bridgeAuthError(error, onUnauthorized)
        if (auth) throw auth
        if (error instanceof DOMException && error.name === 'AbortError') throw new CloudBagApiError('社区服务器请求超时', { kind: 'timeout' })
        if (error instanceof Error && /超时/.test(error.message)) throw new CloudBagApiError('社区服务器请求超时', { kind: 'timeout' })
        throw new CloudBagApiError('连接社区服务器失败，请检查网络后重试', { kind: 'network' })
      } finally {
        clearTimeout(timer)
      }
    },
    diff: async (slug: string, versionNo: number, against: number) => {
      const data = await request<CloudBagDiffEntry[] | { items?: CloudBagDiffEntry[] }>(
        `/api/community/cloudbag/repos/${assertSlug(slug)}/versions/${assertVersionNo(versionNo)}/diff?${query({ against: assertVersionNo(against) })}`,
      )
      // 后端返回 data = {items, from, to}（契约 §3.1 的 [{path,change}] 同形展开）；数组直返兼容
      if (Array.isArray(data)) return data
      return Array.isArray(data?.items) ? data.items : []
    },
    openSession: async (slug: string, input: { opType: 'push' | 'restore'; baseVersionNo: number; files: Array<{ path: string; sha256: string }> }) => {
      const data = await json<{ sessionId?: string; status?: CloudBagSyncSession['status']; files?: CloudBagSyncSession['files'] }>(
        `/api/community/cloudbag/repos/${assertSlug(slug)}/sessions`,
        'POST',
        {
          op_type: input.opType,
          base_version_no: input.baseVersionNo,
          files: input.files,
        },
      )
      // 后端字段名为 sessionId（cloudbag_object.go）；桌面内部统一用 id
      const id = data?.sessionId
      if (typeof id !== 'string' || !id) throw new CloudBagApiError('同步会话响应缺少 sessionId', { kind: 'invalid_response' })
      return { id, status: data.status ?? 'open', files: data.files ?? [] }
    },
    uploadBlob: async (slug: string, input: BlobUploadInput, onProgress?: (sentBytes: number) => void): Promise<void> => {
      if (input.bytes.byteLength > MAX_BLOB_BYTES) throw new CloudBagApiError(describeCloudBagCode('file_too_large'), { kind: 'file_too_large' })
      const form = new FormData()
      // sha256 + session_id 表单字段（后端契约 §3.2）；file 字段最后追加
      form.append('session_id', input.sessionId)
      form.append('sha256', input.sha256)
      if (onProgress) onProgress(0)
      form.append('file', new Blob([input.bytes], { type: input.contentType }), input.fileName)
      // 上传时限按字节数放宽：50MiB 的合法 blob 在 15s 的 JSON 超时下必然失败（需 ≥3.34MiB/s
      // 持续上行），而主进程侧同样是按大小放宽的时限（electron/communityIpc.ts）
      await request<null>(`/api/community/cloudbag/repos/${assertSlug(slug)}/blobs`, { method: 'POST', body: form }, cloudBagUploadTimeoutMs(input.bytes.byteLength))
      if (onProgress) onProgress(input.bytes.byteLength)
    },
    pushVersion: async (slug: string, input: PushCloudBagVersionInput): Promise<{ versionNo: number }> => {
      const data = await json<{ sync?: { resultVersionNo?: number | null; version?: { versionNo?: number } | null } }>(
        `/api/community/cloudbag/repos/${assertSlug(slug)}/versions`,
        'POST',
        {
          base_version_no: input.baseVersionNo,
          message: input.message,
          client_op_id: input.clientOpId,
          files: input.files,
          ...(input.restoreFrom !== undefined ? { restore_from: input.restoreFrom } : {}),
        },
      )
      // 成功/幂等重放同形：data.sync.resultVersionNo（契约 §3.3）；version 对象同值兜底
      const versionNo = data?.sync?.resultVersionNo ?? data?.sync?.version?.versionNo
      if (typeof versionNo !== 'number') throw new CloudBagApiError('版本提交响应缺少版本号', { kind: 'invalid_response' })
      return { versionNo }
    },
    releases: (slug: string) => request<CloudBagPage<CloudBagRelease>>(`/api/community/cloudbag/repos/${assertSlug(slug)}/releases`),
    shares: (slug: string) => request<CloudBagPage<CloudBagShare>>(`/api/community/cloudbag/repos/${assertSlug(slug)}/shares`),
    createRelease: async (slug: string, input: { versionNo: number; name?: string; notes: string }) =>
      unwrapKey<CloudBagRelease>(await json<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}/releases`, 'POST', {
        version_no: input.versionNo,
        ...(input.name ? { name: input.name } : {}),
        notes: input.notes,
      }), 'release'),
    revokeRelease: async (slug: string, releaseId: number) =>
      request<null>(`/api/community/cloudbag/repos/${assertSlug(slug)}/releases/${encodeURIComponent(String(releaseId))}`, { method: 'DELETE' }),
    members: async (slug: string) => request<CloudBagPage<CloudBagMember>>(`/api/community/cloudbag/repos/${assertSlug(slug)}/members`),
    // 成员写端点响应为 data.member 包裹（cloudbag_members.go：CreateCloudBagMember/
    // UpdateCloudBagMember 的 cloudBagOK(c, gin.H{"member": ...})），与 repo/version/
    // sync/share/release 同一包裹键纪律；此前未展开，调用方拿到的是 {member: {...}}
    // 包装层而非成员对象（契约 §3.2 形状不符，渲染层恰好不消费返回值才未暴露）。
    addMember: async (slug: string, input: { userId: number; role: 'editor' | 'viewer' }) =>
      unwrapKey<CloudBagMember>(await json<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}/members`, 'POST', { uid: input.userId, role: input.role }), 'member'),
    updateMember: async (slug: string, userId: number, role: 'editor' | 'viewer') =>
      unwrapKey<CloudBagMember>(await json<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}/members/${encodeURIComponent(String(userId))}`, 'PUT', { role }), 'member'),
    removeMember: async (slug: string, userId: number) =>
      request<null>(`/api/community/cloudbag/repos/${assertSlug(slug)}/members/${encodeURIComponent(String(userId))}`, { method: 'DELETE' }),
    createShare: async (slug: string, input: { versionNo?: number; expiresInDays?: number }) =>
      unwrapKey<CloudBagShare>(await json<unknown>(`/api/community/cloudbag/repos/${assertSlug(slug)}/shares`, 'POST', {
        ...(input.versionNo !== undefined ? { version_no: input.versionNo } : {}),
        ...(input.expiresInDays !== undefined ? { expires_in_days: input.expiresInDays } : {}),
      }), 'share'),
    revokeShare: (shareId: number) => request<null>(`/api/community/cloudbag/shares/${encodeURIComponent(String(shareId))}`, { method: 'DELETE' }),
    exportRwmod: async (slug: string, versionNo: number): Promise<CloudBagDownload> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
      try {
        const response = await fetchImpl(`${base}/api/community/cloudbag/repos/${assertSlug(slug)}/versions/${assertVersionNo(versionNo)}/export.rwmod`, {
          headers: { Accept: '*/*' },
          signal: controller.signal,
          authenticated: true,
        } as RequestInit & { authenticated?: boolean })
        if (response.status === 401) onUnauthorized?.()
        if (!response.ok) {
          const text = await readLimitedText(response, 64 * 1024).catch(() => '')
          let message = ''
          try { message = (JSON.parse(text) as { message?: string }).message ?? '' } catch { /* 导出错误可能不是 JSON */ }
          throw new CloudBagApiError(message || '导出失败', { kind: 'http', status: response.status })
        }
        const bytes = await readLimitedBytes(response, MAX_EXPORT_BYTES)
        const fallbackName = `${slug}-v${versionNo}.rwmod`
        const disposition = response.headers.get('content-disposition') ?? ''
        const filenamePart = disposition.split(';').find((part) => part.trim().toLowerCase().startsWith('filename=') || part.trim().toLowerCase().startsWith('filename*='))
        const rawFilename = filenamePart ? filenamePart.slice(filenamePart.indexOf('=') + 1).trim().replace(/^UTF-8''/i, '').replace(/^"|"$/g, '') : fallbackName
        // 服务端返回截断/畸形的 percent 编码（如 `%E4%B8`）时 decodeURIComponent 会抛 URIError：
        // 那是响应头格式问题，不是网络故障——回退到确定性文件名，绝不能冒充「连接失败」。
        let decoded = fallbackName
        try {
          decoded = decodeURIComponent(rawFilename)
        } catch {
          decoded = fallbackName
        }
        const filename = decoded.replace(/[\\/\0\r\n]/g, '_').replace(/^\.+$/, '_').slice(0, 180) || fallbackName
        return {
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          filename,
          contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        }
      } catch (error) {
        if (error instanceof CloudBagApiError) throw error
        const auth = bridgeAuthError(error, onUnauthorized)
        if (auth) throw auth
        if (error instanceof DOMException && error.name === 'AbortError') throw new CloudBagApiError('导出下载超时', { kind: 'timeout' })
        if (error instanceof Error && /超时/.test(error.message)) throw new CloudBagApiError('导出下载超时', { kind: 'timeout' })
        throw new CloudBagApiError('连接社区服务器失败，请检查网络后重试', { kind: 'network' })
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export interface CloudBagApi {
  endpoint: string
  repos(options?: { mine?: boolean; q?: string; tag?: string; sort?: string; page?: number; pageSize?: number }): Promise<CloudBagPage<CloudBagRepo>>
  repo(slug: string): Promise<CloudBagRepo>
  createRepo(input: CreateCloudBagRepoInput): Promise<CloudBagRepo>
  updateRepo(slug: string, input: UpdateCloudBagRepoInput): Promise<CloudBagRepo>
  deleteRepo(slug: string): Promise<null>
  versions(slug: string, cursor?: string, limit?: number): Promise<CloudBagPage<CloudBagVersion>>
  version(slug: string, versionNo: number): Promise<CloudBagVersion>
  tree(slug: string, versionNo: number, cursor?: string, limit?: number): Promise<CloudBagPage<CloudBagTreeEntry>>
  file(slug: string, versionNo: number, path: string): Promise<{ bytes: ArrayBuffer; contentType: string }>
  diff(slug: string, versionNo: number, against: number): Promise<CloudBagDiffEntry[]>
  openSession(slug: string, input: { opType: 'push' | 'restore'; baseVersionNo: number; files: Array<{ path: string; sha256: string }> }): Promise<CloudBagSyncSession>
  uploadBlob(slug: string, input: BlobUploadInput, onProgress?: (sentBytes: number) => void): Promise<void>
  pushVersion(slug: string, input: PushCloudBagVersionInput): Promise<{ versionNo: number }>
  releases(slug: string): Promise<CloudBagPage<CloudBagRelease>>
  shares(slug: string): Promise<CloudBagPage<CloudBagShare>>
  createRelease(slug: string, input: { versionNo: number; name?: string; notes: string }): Promise<CloudBagRelease>
  revokeRelease(slug: string, releaseId: number): Promise<null>
  members(slug: string): Promise<CloudBagPage<CloudBagMember>>
  addMember(slug: string, input: { userId: number; role: 'editor' | 'viewer' }): Promise<CloudBagMember>
  updateMember(slug: string, userId: number, role: 'editor' | 'viewer'): Promise<CloudBagMember>
  removeMember(slug: string, userId: number): Promise<null>
  createShare(slug: string, input: { versionNo?: number; expiresInDays?: number }): Promise<CloudBagShare>
  revokeShare(shareId: number): Promise<null>
  exportRwmod(slug: string, versionNo: number): Promise<CloudBagDownload>
}
