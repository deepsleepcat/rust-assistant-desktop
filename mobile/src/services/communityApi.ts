/**
 * 社区 API 的共享类型与端点规范化函数。
 * 仅导出 dashboardApi.ts（以及未来其它社区客户端）所需的最小子集：
 * CommunityApiError 类 + normalizeCommunityEndpoint + isAllowedCommunityEndpoint。
 * 手机版暂不实现完整的登录/配对/注册流程。
 */
import { getCommunityEndpoint, isAllowedCommunityEndpoint } from './communityConfig'

export const DEFAULT_COMMUNITY_ENDPOINT = getCommunityEndpoint()
const MAX_ENDPOINT_LENGTH = 500

export class CommunityApiError extends Error {
  readonly status: number
  readonly kind: 'http' | 'business' | 'network' | 'invalid_response' | 'invalid_endpoint' | 'timeout'
  readonly code?: string

  constructor(message: string, options: { status?: number; kind?: CommunityApiError['kind']; code?: string } = {}) {
    super(message)
    this.name = 'CommunityApiError'
    this.status = options.status ?? 0
    this.kind = options.kind ?? 'network'
    this.code = options.code
  }
}

/**
 * 规范化社区端点：http/https，带 origin，长度 500 上限，且必须是允许的域名。
 * 抛 CommunityApiError（invalid_endpoint 类型）。
 */
export function normalizeCommunityEndpoint(input: string): string {
  const value = input.trim().replace(/\/+$/, '')
  if (!value || value.length > MAX_ENDPOINT_LENGTH || !/^https?:\/\//i.test(value)) {
    throw new CommunityApiError('云仓库服务器地址必须是 http:// 或 https:// 地址', { code: 'invalid_endpoint' })
  }
  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid origin')
    if (!isAllowedCommunityEndpoint(url.origin)) throw new Error('untrusted origin')
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new CommunityApiError('云仓库服务器地址格式无效', { code: 'invalid_endpoint' })
  }
}
