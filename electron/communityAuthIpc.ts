/**
 * 设备配对认证 IPC（M40 巨型文件拆分批次 B2）：
 * 令牌只在主进程 safeStorage 内存/密文间流转。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

/** 设备配对认证：令牌只在主进程 safeStorage 内存/密文间流转。 */
export function registerCommunityAuthIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  const auth = (): NonNullable<IpcContext['communityAuth']> => {
    if (!ctx.communityAuth) throw new Error('社区设备认证不可用')
    return ctx.communityAuth
  }
  ipc('auth:status', () => auth().status())
  ipc('auth:startPairing', () => auth().startPairing())
  ipc('auth:pollPairing', () => auth().pollPairing())
  ipc('auth:cancelPairing', () => auth().cancelPairing())
  ipc('auth:logout', () => auth().logout())
}
