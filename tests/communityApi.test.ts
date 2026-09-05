import { describe, expect, it, vi } from 'vitest'
import {
  CommunityApiError,
  createCommunityApi,
  DEFAULT_COMMUNITY_ENDPOINT,
  normalizeCommunityEndpoint,
  resolveCommunityUrl,
} from '../src/services/communityApi'

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('communityApi', () => {
  it('规范化服务器地址并拒绝危险协议', () => {
    expect(normalizeCommunityEndpoint(`${DEFAULT_COMMUNITY_ENDPOINT}///`)).toBe(DEFAULT_COMMUNITY_ENDPOINT)
    expect(() => normalizeCommunityEndpoint('file:///tmp/community')).toThrow(CommunityApiError)
    expect(() => normalizeCommunityEndpoint('not-a-url')).toThrow('http:// 或 https://')
  })

  it('健康检查只发送公开 GET，并解析版本', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/health`)
      expect(init?.method).toBeUndefined()
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return response({ ok: true, message: 'ok', version: 'v0.8.7.5' })
    })
    const result = await createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-secret', fetcher).health()
    expect(result).toEqual({ ok: true, message: 'ok', version: 'v0.8.7.5' })
  })

  it('帖子列表带分页和筛选参数，公开请求不携带令牌', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/api/community/posts')
      expect(url.searchParams.get('board')).toBe('discussion')
      expect(url.searchParams.get('keyword')).toBe('坦克')
      expect(url.searchParams.get('feed')).toBe('hot')
      expect(url.searchParams.get('tag')).toBe('陆军')
      expect(url.searchParams.get('page')).toBe('2')
      expect(url.searchParams.get('page_size')).toBe('12')
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return response({ success: true, message: '', data: { items: [], total: 0, page: 2, page_size: 12 } })
    })
    const result = await createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-secret', fetcher).posts({
      board: 'discussion', keyword: '坦克', feed: 'hot', tag: '陆军', page: 2,
    })
    expect(result.page).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('登录使用公开 POST，业务成功后返回令牌和用户', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/api/auth/login`)
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      expect(JSON.parse(String(init?.body))).toEqual({ username: 'alice', password: 'password123' })
      return response({ success: true, message: '', data: { token: 'sk-token', user: { id: 1, username: 'alice' } } })
    })
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, '', fetcher).login('alice', 'password123')).resolves.toEqual({
      token: 'sk-token', user: { id: 1, username: 'alice' },
    })
  })

  it('注册可传邮箱验证码，验证码请求与绑定遵守认证约定', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/auth/register') {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false)
        expect(JSON.parse(String(init?.body))).toEqual({
          username: 'alice', password: 'password123', email: 'alice@example.com', verification_code: '123456',
        })
        return response({ success: true, message: '', data: { token: 'sk-token', user: { id: 1, username: 'alice' } } })
      }
      if (url.pathname === '/api/auth/verification') {
        expect(url.searchParams.get('email')).toBe('alice@example.com')
        expect(new Headers(init?.headers).has('Authorization')).toBe(false)
        return response({ success: true, message: '', data: null })
      }
      expect(url.pathname).toBe('/api/auth/email/bind')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-token')
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'alice@example.com', verification_code: '123456' })
      return response({ success: true, message: '', data: { id: 1, username: 'alice', email_verified: true } })
    })
    const anonymous = createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, '', fetcher)
    await anonymous.register('alice', 'password123', { email: 'alice@example.com', verificationCode: '123456' })
    await expect(anonymous.requestVerification('alice@example.com')).resolves.toBeNull()
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher).bindEmail('alice@example.com', '123456')).resolves.toMatchObject({ email_verified: true })
  })

  it('头像 URL 只能解析为社区服务器同源的规范头像路径', () => {
    const key = 'a'.repeat(48)
    expect(resolveCommunityUrl(DEFAULT_COMMUNITY_ENDPOINT, `/api/avatar/${key}.png`)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/api/avatar/${key}.png`)
    expect(resolveCommunityUrl(DEFAULT_COMMUNITY_ENDPOINT, '/api/avatar/avatar-key.png')).toBeNull()
    expect(resolveCommunityUrl(DEFAULT_COMMUNITY_ENDPOINT, 'https://example.com/avatar.png')).toBeNull()
    expect(resolveCommunityUrl(DEFAULT_COMMUNITY_ENDPOINT, 'javascript:alert(1)')).toBeNull()
  })

  it('头像请求通过认证凭据读取图片二进制', async () => {
    const key = 'b'.repeat(48)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/api/avatar/${key}.png`)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-token')
      expect((init as RequestInit & { authenticated?: boolean }).authenticated).toBe(true)
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const result = await createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher).avatar(`/api/avatar/${key}.png`)
    expect(result?.contentType).toBe('image/png')
    expect([...new Uint8Array(result?.bytes ?? new ArrayBuffer(0))]).toEqual([...png])
  })

  it('注销使用带 Bearer 的 POST，401 会统一通知会话清理', async () => {
    const onUnauthorized = vi.fn()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/api/auth/logout`)
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-token')
      return response({ success: true, message: '', data: null })
    })
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher, onUnauthorized).logout()).resolves.toBeNull()
    expect(onUnauthorized).not.toHaveBeenCalled()

    const unauthorized = vi.fn(async () => response({ success: false, message: '无效令牌', data: null }, 401))
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', unauthorized, onUnauthorized).me()).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('认证请求发送 Bearer，业务失败和 HTTP 401 都转成可读错误', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-token')
      return response({ success: false, message: '用户名或密码错误', data: null })
    })
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher).me()).rejects.toMatchObject({
      code: 'business', message: '用户名或密码错误',
    })

    const unauthorized = vi.fn(async () => response({ success: false, message: '无效的令牌', data: null }, 401))
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', unauthorized).me()).rejects.toMatchObject({
      status: 401, message: '社区登录已失效，请重新登录',
    })
  })

  it('兼容板块和排行的 data.items 响应包装', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/boards')) return response({ success: true, message: '', data: { items: ['discussion', 'help'] } })
      return response({ success: true, message: '', data: { items: [{ author_user_id: 1, author_name: 'alice', post_count: 2 }], total: 1, page: 1, page_size: 12, type: 'authors' } })
    })
    const api = createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, '', fetcher)
    await expect(api.boards()).resolves.toEqual(['discussion', 'help'])
    await expect(api.rankings('authors')).resolves.toEqual([{ author_user_id: 1, author_name: 'alice', post_count: 2 }])
  })

  it('帖子和评论修改、删除使用文档规定的方法与路径', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
      return response({ success: true, message: '', data: init?.method === 'PUT' ? { id: 42, body: '已修改' } : null })
    })
    const api = createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher)
    await api.updatePost(42, { board: 'discussion', title: '标题', body: '正文' })
    await api.deletePost(42)
    await api.updateComment(7, '已修改')
    await api.deleteComment(7)
    expect(calls).toEqual([
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/posts/42`, method: 'PUT', body: '{"board":"discussion","title":"标题","body":"正文"}' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/posts/42`, method: 'DELETE' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/comments/7`, method: 'PUT', body: '{"body":"已修改"}' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/comments/7`, method: 'DELETE' },
    ])
  })

  it('资源上传使用 multipart，并保留 Bearer 认证', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/api/community/posts/42/resources`)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-token')
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false)
      expect(init?.body).toBeInstanceOf(FormData)
      return response({ success: true, message: '', data: { id: 9, post_id: 42, display_name: 'unit.zip' } })
    })
    const file = new File(['unit-data'], 'unit.zip', { type: 'application/zip' })
    await expect(createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher).uploadResource(42, file)).resolves.toMatchObject({ id: 9, display_name: 'unit.zip' })
  })

  it('我的帖子、审核和问答采纳使用精确路径与请求载荷', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
      return response({ success: true, message: '', data: { items: [], total: 0, page: 1, page_size: 20 } })
    })
    const api = createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher)
    await api.mine(2, 12)
    await api.moderationPosts('hidden', 3, 20)
    await api.moderationComments('all', 1, 20)
    await api.moderationResources('visible', 1, 20)
    await api.moderatePost(12, { status: 'hidden', reason: '违规内容' })
    await api.moderateComment(13, { status: 'visible', reason: '复核通过' })
    await api.moderateResource(14, { status: 'hidden', reason: '资源违规' })
    await api.setPostCuration(12, { featured: false, reason: '取消精选' })
    await api.acceptComment(12, 13)
    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/posts/mine?page=2&page_size=12`, method: 'GET' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/posts?status=hidden&page=3&page_size=20`, method: 'GET' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/comments?status=all&page=1&page_size=20`, method: 'GET' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/resources?status=visible&page=1&page_size=20`, method: 'GET' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/posts/12`, method: 'PUT', body: '{"status":"hidden","reason":"违规内容"}' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/comments/13`, method: 'PUT', body: '{"status":"visible","reason":"复核通过"}' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/resources/14`, method: 'PUT', body: '{"status":"hidden","reason":"资源违规"}' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/moderation/posts/12/curation`, method: 'PUT', body: '{"featured":false,"reason":"取消精选"}' },
      { url: `${DEFAULT_COMMUNITY_ENDPOINT}/api/community/posts/12/comments/13/accept`, method: 'PUT', body: '{}' },
    ])
  })

  it('资源下载限制大小并解析附件文件名', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${DEFAULT_COMMUNITY_ENDPOINT}/api/community/resources/9/download`)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-token')
      expect((init as RequestInit & { authenticated?: boolean }).authenticated).toBe(true)
      return new Response(new Blob(['unit-data'], { type: 'application/zip' }), {
        status: 200,
        headers: { 'content-disposition': "attachment; filename*=UTF-8''..\\evil.zip", 'content-type': 'application/zip' },
      })
    })
    const result = await createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, 'sk-token', fetcher).download(9)
    expect(result.filename).toBe('.._evil.zip')
    expect(result.contentType).toBe('application/zip')
    expect(await result.blob.text()).toBe('unit-data')
  })
})
