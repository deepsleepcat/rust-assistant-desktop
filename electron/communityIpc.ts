/**
 * 社区网络代理 IPC（M40 巨型文件拆分批次 B2/B4）：
 * 桌面端用于绕开部署端缺失 CORS 响应头的限制。
 * 渲染层不能任选主机、方法或路径，避免把主进程暴露为通用 HTTP/SSRF 代理。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import type { CommunityRequest, CommunityResponse } from '../src/types/bridge'
import { getConfiguredCommunityOrigin, validateCommunityOrigin } from './communityOrigin'

/** 流式读取响应体并限制总大小（头像 2MB / JSON 2MB / 下载 50MB） */
async function readResponseBytes(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declaredSize = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('社区服务器响应过大')
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength > maxBytes) throw new Error('社区服务器响应过大')
    return body.buffer
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
        throw new Error('社区服务器响应过大')
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
  return result.buffer
}

/** 社区网络代理：桌面端用于绕开部署端缺失 CORS 响应头的限制。
 * 渲染层不能任选主机、方法或路径，避免把主进程暴露为通用 HTTP/SSRF 代理。 */
export function registerCommunityIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  // 只代理正式社区或显式本地开发后端，避免该通道成为通用 HTTP/SSRF 代理。
  const trustedOrigin = validateCommunityOrigin(getConfiguredCommunityOrigin())
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE'])
  const allowedPaths = [
    /^\/health$/,
    /^\/api\/auth\/(register|login|logout|verification|email\/bind)$/,
    /^\/api\/me$/,
    /^\/api\/avatar\/[A-Za-z0-9]{48}\.png$/,
    /^\/api\/community\/(boards|tags|rankings|posts)$/,
    /^\/api\/community\/posts\/following$/,
    /^\/api\/community\/posts\/mine$/,
    /^\/api\/community\/posts\/\d+$/,
    /^\/api\/community\/posts\/\d+\/comments$/,
    /^\/api\/community\/posts\/\d+\/resources$/,
    /^\/api\/community\/posts\/\d+\/like$/,
    /^\/api\/community\/authors\/\d+\/follow$/,
    /^\/api\/community\/comments\/\d+$/,
    /^\/api\/community\/resources\/\d+(?:\/download)?$/,
    /^\/api\/community\/moderation\/posts$/,
    /^\/api\/community\/moderation\/posts\/\d+$/,
    /^\/api\/community\/moderation\/posts\/\d+\/curation$/,
    /^\/api\/community\/moderation\/(comments|resources)$/,
    /^\/api\/community\/moderation\/(comments|resources)\/\d+$/,
    /^\/api\/community\/posts\/\d+\/comments\/\d+\/accept$/,
  ]
  const maxJsonBytes = 2 * 1024 * 1024
  const maxUploadBytes = 50 * 1024 * 1024

  ipc('community:request', async (_event, input: unknown): Promise<CommunityResponse> => {
    if (!input || typeof input !== 'object') throw new Error('社区请求参数无效')
    const request = input as CommunityRequest
    if (!allowedMethods.has(request.method)) throw new Error('社区请求方法不允许')
    if (typeof request.url !== 'string' || request.url.length > 600) throw new Error('社区服务器地址无效')
    if (request.authenticated !== undefined && typeof request.authenticated !== 'boolean') throw new Error('社区认证参数无效')
    if (request.body !== undefined && typeof request.body !== 'string') throw new Error('社区请求体无效')
    if (request.headers !== undefined && (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers))) throw new Error('社区请求头无效')
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      throw new Error('社区服务器地址无效')
    }
    if (url.origin !== trustedOrigin) throw new Error('社区服务器地址不受信任')
    // pathname 必须是站内绝对路径（单 / 开头）：阻止 `//host` 协议相对形式借 base 重建时逃逸到其他源
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) throw new Error('社区请求路径不允许')
    if (!allowedPaths.some((pattern) => pattern.test(url.pathname))) throw new Error('社区请求路径不允许')
    if (/^\/api\/avatar\/[A-Za-z0-9]{48}\.png$/.test(url.pathname) && (request.method !== 'GET' || request.body !== undefined || request.upload)) {
      throw new Error('社区头像只允许读取')
    }
    if (url.search.length > 600) throw new Error('社区查询参数过长')
    if (typeof request.body === 'string' && Buffer.byteLength(request.body, 'utf8') > maxJsonBytes) throw new Error('社区请求体过大')
    if (request.upload !== undefined) {
      if (request.method !== 'POST' || !/^\/api\/community\/posts\/\d+\/resources$/.test(url.pathname) || request.body !== undefined) {
        throw new Error('附件只能上传到帖子资源接口')
      }
      if (!request.upload || typeof request.upload !== 'object' || Array.isArray(request.upload)) throw new Error('社区附件参数无效')
      if (typeof request.upload.name !== 'string' || typeof request.upload.type !== 'string' || request.upload.name.length > 180 || request.upload.type.length > 200) throw new Error('社区附件参数无效')
      const bytes = request.upload.bytes
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > maxUploadBytes) throw new Error('社区附件超过 50 MiB 限制')
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (!/^(accept|content-type)$/i.test(key) || typeof value !== 'string' || value.length > 600) continue
      headers.set(key, value)
    }
    let body: string | FormData | undefined = request.body
    if (request.upload) {
      if (!/^[^\\/\0\r\n]{1,180}$/.test(request.upload.name)) throw new Error('附件名称无效')
      const form = new FormData()
      form.append('file', new Blob([request.upload.bytes], { type: request.upload.type || 'application/octet-stream' }), request.upload.name)
      body = form
      headers.delete('content-type')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const perform = async (credential?: string): Promise<Response> => {
        const requestHeaders = new Headers(headers)
        if (request.authenticated && credential) requestHeaders.set('Authorization', `Bearer ${credential}`)
        // origin 只取自已验证的 trustedOrigin；pathname/search 以属性赋值方式搬入，
        // 避免 `new URL(动态串, base)` 的协议相对形式在任何路径下改写源
        const trustedUrl = new URL(trustedOrigin)
        trustedUrl.pathname = url.pathname
        trustedUrl.search = url.search
        return fetch(trustedUrl, { method: request.method, headers: requestHeaders, body, signal: controller.signal, redirect: 'error' })
      }
      const response = request.authenticated
        ? await (ctx.communityAuth?.withCredential((credential) => perform(credential)) ?? Promise.reject(new Error('社区登录已失效')))
        : await perform()
      if (!response) throw new Error('社区登录已失效')
      if (response.status === 401 && request.authenticated) await ctx.communityAuth?.invalidate()
      const isAvatar = /^\/api\/avatar\/[A-Za-z0-9]{48}\.png$/.test(url.pathname)
      const limit = url.pathname.endsWith('/download') ? maxUploadBytes : isAvatar ? 2 * 1024 * 1024 : maxJsonBytes
      const data = await readResponseBytes(response, limit)
      const safeHeaders: Record<string, string> = {}
      for (const name of ['content-type', 'content-disposition', 'content-length', 'x-oneapi-request-id']) {
        const value = response.headers.get(name)
        if (value) safeHeaders[name] = value
      }
      return { status: response.status, headers: safeHeaders, body: data }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('社区服务器请求超时', { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
    }
  })
}
