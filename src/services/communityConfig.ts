export const PRODUCTION_COMMUNITY_ENDPOINT = 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
export const LOCAL_COMMUNITY_ENDPOINT = 'http://localhost:3000'

/**
 * 开发桌面默认连接本地后端；生产构建固定连接正式社区，避免把任意地址变成出站代理。
 * OHMYTX_COMMUNITY_ENDPOINT 只接受明确的本地测试地址或正式地址。
 */
export function getCommunityEndpoint(): string {
  const configured = typeof import.meta !== 'undefined' && import.meta.env?.VITE_COMMUNITY_ENDPOINT
  if (configured === LOCAL_COMMUNITY_ENDPOINT) return LOCAL_COMMUNITY_ENDPOINT
  return PRODUCTION_COMMUNITY_ENDPOINT
}

export function isAllowedCommunityEndpoint(value: string): boolean {
  return value === PRODUCTION_COMMUNITY_ENDPOINT || value === LOCAL_COMMUNITY_ENDPOINT
}
