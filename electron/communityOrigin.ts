export const PRODUCTION_COMMUNITY_ORIGIN = 'https://xn--gmqtc392bzw0a.xn--6qq986b3xl'
export const LOCAL_COMMUNITY_ORIGIN = 'http://localhost:3000'

export function getConfiguredCommunityOrigin(): string {
  const value = process.env.OHMYTX_COMMUNITY_ORIGIN?.trim()
  if (process.env.VITE_DEV_SERVER_URL && value === LOCAL_COMMUNITY_ORIGIN) return LOCAL_COMMUNITY_ORIGIN
  return PRODUCTION_COMMUNITY_ORIGIN
}

export function validateCommunityOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('社区服务器地址无效') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port && url.origin === PRODUCTION_COMMUNITY_ORIGIN) {
    throw new Error('社区服务器地址不受信任')
  }
  if (url.origin !== PRODUCTION_COMMUNITY_ORIGIN && url.origin !== LOCAL_COMMUNITY_ORIGIN) {
    throw new Error('社区服务器地址不受信任')
  }
  if (url.origin === LOCAL_COMMUNITY_ORIGIN && !process.env.VITE_DEV_SERVER_URL) {
    throw new Error('生产环境禁止使用本地社区地址')
  }
  return url.origin
}
