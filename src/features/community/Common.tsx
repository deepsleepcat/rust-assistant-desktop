import { CommunityPanel } from './CommunityPanel'
import { CloudBagPanel } from './CloudBagPanel'

/** 壳层可直接挂载；状态继续复用既有账号与社区 store。 */
export function Common() { return <CommunityPanel /> }
export const CommunitySurface = Common

export function CloudRepositorySurface() {
  return <CloudBagPanel />
}

export default Common
