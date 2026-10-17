import { describe, expect, it, vi } from 'vitest'
import { createDashboardApi } from '../src/services/dashboardApi'
import { PRODUCTION_COMMUNITY_ENDPOINT } from '../src/services/communityConfig'

describe('dashboard HTTP integration contract', () => {
  it('uses trusted endpoint and expresses authentication without renderer credentials', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      expect((init as RequestInit & { authenticated?: boolean }).authenticated).toBe(true)
      return Response.json({ success: true, data: { version: 1, slots: ['balance', 'tokens'] }, message: '' })
    })
    expect(await createDashboardApi(PRODUCTION_COMMUNITY_ENDPOINT, { fetchImpl }).layout()).toEqual({ version: 1, slots: ['balance', 'tokens'] })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${PRODUCTION_COMMUNITY_ENDPOINT}/api/community/dashboard/layout`)
    expect(() => createDashboardApi('https://untrusted.invalid')).toThrow()
  })
  it('maps HTTP unauthorized to session invalidation and does not treat business failure as data', async () => {
    const onUnauthorized = vi.fn()
    const denied = createDashboardApi(PRODUCTION_COMMUNITY_ENDPOINT, { onUnauthorized, fetchImpl: async () => Response.json({ success: false, data: null }, { status: 401 }) })
    await expect(denied.layout()).rejects.toMatchObject({ status: 401, kind: 'http' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
    const failed = createDashboardApi(PRODUCTION_COMMUNITY_ENDPOINT, { fetchImpl: async () => Response.json({ success: false, message: '保存失败', data: { version: 1 } }) })
    await expect(failed.putLayout({ version: 1, slots: ['balance', 'tokens'] })).rejects.toMatchObject({ kind: 'business', message: '保存失败' })
  })
})
