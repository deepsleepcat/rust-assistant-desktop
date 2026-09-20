/**
 * 社区网络代理 IPC（M40 巨型文件拆分批次 B2/B4）：
 * 桌面端用于绕开部署端缺失 CORS 响应头的限制。
 * 渲染层不能任选主机、方法或路径，避免把主进程暴露为通用 HTTP/SSRF 代理。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import type { CommunityRequest, CommunityResponse } from '../src/types/bridge'
import { getConfiguredCommunityOrigin, validateCommunityOrigin } from './communityOrigin'
import { cloudBagUploadTimeoutMs } from './cloudbagTree'

/**
 * 超限文案：区分「桌面端本地上限」与「服务端响应过大」。
 * 旧文案一律说「社区服务器响应过大」，用户按服务端问题排查永远找不到原因
 * （实际是客户端上限；服务端导出默认上限为 512MiB）。
 */
function tooLargeMessage(maxBytes: number): string {
  const mib = Math.round(maxBytes / (1024 * 1024))
  return `响应超过桌面端本地上限（${mib} MiB）——这是客户端限制而非服务端响应过大；更大的内容请在社区网页端操作`
}

/** 流式读取响应体并限制总大小（头像 2MB / JSON 2MB / 下载 50MB） */
async function readResponseBytes(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declaredSize = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error(tooLargeMessage(maxBytes))
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength > maxBytes) throw new Error(tooLargeMessage(maxBytes))
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
        throw new Error(tooLargeMessage(maxBytes))
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
  // 前缀族白名单（方案 D Step 4）：社区服务以后新增同族接口时不需要发桌面版。
  // 家族之外一律拒绝；源固定、方法、大小上限、头白名单、凭据注入边界全部不变。
  // 例外：头像仍限定 48 位对象名；附件上传走下方表驱动的精确路径规则（云书包契约 §7.2）。
  const allowedPathPatterns = [
    /^\/health$/,
    /^\/api\/me$/,
    /^\/api\/usage$/,
    /^\/api\/auth\//,
    /^\/api\/community\//,
    /^\/api\/avatar\/[A-Za-z0-9]{48}\.png$/,
  ]
  const trustedHost = new URL(trustedOrigin).hostname
  const maxJsonBytes = 2 * 1024 * 1024
  const maxUploadBytes = 50 * 1024 * 1024
  // 上传规则表（云书包联调前置项，桌面契约 §7.2）：表驱动 {pattern, methods, maxBytes}，
  // 新增上传端点只改表，不改校验流程。云书包 slug 形态与后端建仓规则一致
  // （[A-Za-z0-9][A-Za-z0-9._-]{0,63}，契约 §3.2 的「全局唯一 URL 安全标识」）。
  const uploadPathRules: Array<{ pattern: RegExp; methods: string[]; maxBytes: number }> = [
    { pattern: /^\/api\/community\/posts\/\d+\/resources$/, methods: ['POST'], maxBytes: maxUploadBytes },
    { pattern: /^\/api\/community\/cloudbag\/repos\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/blobs$/, methods: ['POST'], maxBytes: maxUploadBytes },
  ]
  // 下载规则表（桌面契约 §7.2）：显式家族正则——导出 .rwmod、分享下载与帖子附件下载
  // 50MiB；云书包树内单文件 file 2MiB；其余路径退回 JSON 2MiB 上限。
  // 帖子附件（/api/community/resources/<id>/download）与上传侧同为 50MiB（communityApi
  // MAX_DOWNLOAD_BYTES），必须显式列出——否则它落进默认 2MiB，2~50MiB 的既有附件下载
  // 会在桌面端被误判为「响应过大」。
  const downloadLimitRules: Array<{ pattern: RegExp; maxBytes: number }> = [
    { pattern: /export\.rwmod$/, maxBytes: maxUploadBytes },
    { pattern: /shares\/[A-Za-z0-9]+\/download$/, maxBytes: maxUploadBytes },
    { pattern: /^\/api\/community\/resources\/\d+\/download$/, maxBytes: maxUploadBytes },
    { pattern: /\/file$/, maxBytes: 2 * 1024 * 1024 },
  ]

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
    // 显式主机校验（SSRF 防线）：即使上游源校验被改动，这里也把请求钉死在
    // 受信任的主机上；http 协议只允许显式本地开发后端（localhost）。
    if (url.hostname !== trustedHost) throw new Error('社区服务器地址不受信任')
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('社区服务器地址不受信任')
    // pathname 必须是站内绝对路径（单 / 开头）：阻止 `//host` 协议相对形式借 base 重建时逃逸到其他源
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) throw new Error('社区请求路径不允许')
    if (!allowedPathPatterns.some((pattern) => pattern.test(url.pathname))) throw new Error('社区请求路径不允许')
    if (/^\/api\/avatar\/[A-Za-z0-9]{48}\.png$/.test(url.pathname) && (request.method !== 'GET' || request.body !== undefined || request.upload)) {
      throw new Error('社区头像只允许读取')
    }
    if (url.search.length > 600) throw new Error('社区查询参数过长')
    if (typeof request.body === 'string' && Buffer.byteLength(request.body, 'utf8') > maxJsonBytes) throw new Error('社区请求体过大')
    if (request.upload !== undefined) {
      const rule = uploadPathRules.find((item) => item.pattern.test(url.pathname))
      // 既有用例文案保持可读且兼容（substring 断言），表驱动后同时覆盖帖子资源与云书包 blob
      if (!rule || !rule.methods.includes(request.method) || request.body !== undefined) {
        throw new Error('附件只能上传到帖子资源接口或云书包 blob 接口')
      }
      if (!request.upload || typeof request.upload !== 'object' || Array.isArray(request.upload)) throw new Error('社区附件参数无效')
      if (typeof request.upload.name !== 'string' || typeof request.upload.type !== 'string' || request.upload.name.length > 180 || request.upload.type.length > 200) throw new Error('社区附件参数无效')
      if (request.upload.fields !== undefined) {
        const fields = request.upload.fields
        // 先判类型再取键：fields 可能是 null（Object.keys(null) 会抛 TypeError）
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('社区附件参数无效')
        const keys = Object.keys(fields)
        if (keys.length > 8) throw new Error('社区附件参数无效')
        for (const key of keys) {
          // 拒绝保留名 file/filename：真正的 file 部件固定最后追加，同名文本字段会让
          // 服务端 multipart 解析出现歧义
          if (!/^[A-Za-z0-9_]{1,40}$/.test(key) || /^(file|filename)$/i.test(key) || typeof fields[key] !== 'string' || (fields[key] as string).length > 200) throw new Error('社区附件参数无效')
        }
      }
      const bytes = request.upload.bytes
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > rule.maxBytes) throw new Error('社区附件超过 50 MiB 限制')
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
      // 附加表单字段先行（云书包 blobs：session_id/sha256），file 恒最后追加
      for (const [key, value] of Object.entries(request.upload.fields ?? {})) {
        form.append(key, value)
      }
      form.append('file', new Blob([request.upload.bytes], { type: request.upload.type || 'application/octet-stream' }), request.upload.name)
      body = form
      headers.delete('content-type')
    }
    const controller = new AbortController()
    // 上传请求的时限按字节数放宽（与渲染层 cloudBagApi.cloudBagUploadTimeoutMs 同公式，
    // 由 tests/cloudBagApi.test.ts 的口径同源用例锁定）：固定 60s 对 50MiB 等于要求
    // ≥0.85MiB/s 的持续上行，慢链路上合法大文件永远传不完。渲染层一旦判超时放弃，
    // 主进程这次传输仍在继续，两边必须同策略。
    const timeoutMs = request.upload ? cloudBagUploadTimeoutMs(request.upload.bytes.byteLength) : 60_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const perform = async (credential?: string): Promise<Response> => {
        const requestHeaders = new Headers(headers)
        if (request.authenticated && credential) requestHeaders.set('Authorization', `Bearer ${credential}`)
        // origin 只取自已验证的 trustedOrigin；pathname/search 以属性赋值方式搬入，
        // 避免 `new URL(动态串, base)` 的协议相对形式在任何路径下改写源
        const trustedUrl = new URL(trustedOrigin)
        trustedUrl.pathname = url.pathname
        trustedUrl.search = url.search
        // 发请求前的显式主机校验：协议必须 https（或显式本地开发的 localhost），
        // 主机必须等于受信任主机——即便上游校验被改动，这里也不会成为通用代理。
        if (trustedUrl.hostname !== trustedHost || (trustedUrl.protocol !== 'https:' && trustedUrl.hostname !== 'localhost')) {
          throw new Error('社区服务器地址不受信任')
        }
        return fetch(trustedUrl, { method: request.method, headers: requestHeaders, body, signal: controller.signal, redirect: 'error' })
      }
      const response = request.authenticated
        ? await (ctx.communityAuth?.withCredential((credential) => perform(credential)) ?? Promise.reject(new Error('社区登录已失效')))
        : await perform()
      if (!response) throw new Error('社区登录已失效')
      if (response.status === 401 && request.authenticated) await ctx.communityAuth?.invalidate()
      const isAvatar = /^\/api\/avatar\/[A-Za-z0-9]{48}\.png$/.test(url.pathname)
      // 下载上限改显式家族正则（桌面契约 §7.2）：导出/分享下载 50MiB、树内单文件 2MiB，其余 JSON 2MiB
      const downloadLimit = downloadLimitRules.find((item) => item.pattern.test(url.pathname))?.maxBytes
      const limit = isAvatar ? 2 * 1024 * 1024 : (downloadLimit ?? maxJsonBytes)
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
