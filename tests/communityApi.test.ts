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

  it('头像 URL 只能解析为云仓库服务器同源的规范头像路径', () => {
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
      status: 401, message: '云仓库登录已失效，请重新登录',
    })
  })

  it('社区内容 API 已裁撤：客户端只保留认证、账号与头像能力', () => {
    const api = createCommunityApi(DEFAULT_COMMUNITY_ENDPOINT, '', async () => new Response('{}'))
    expect('posts' in api).toBe(false)
    expect('comments' in api).toBe(false)
    expect('like' in api).toBe(false)
    expect('follow' in api).toBe(false)
    expect('rankingPage' in api).toBe(false)
    expect(typeof api.health).toBe('function')
    expect(typeof api.login).toBe('function')
    expect(typeof api.avatar).toBe('function')
  })
})
