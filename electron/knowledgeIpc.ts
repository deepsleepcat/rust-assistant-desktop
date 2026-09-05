/**
 * 知识包 IPC（M40 巨型文件拆分批次 B2）：
 * 数据文件读取 / 更新检查 / 增量更新 / 回滚。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

/** 知识包：数据文件读取 / 更新检查 / 增量更新 / 回滚 */
export function registerKnowledgeIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('knowledge:readDataFile', (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('参数错误')
    return ctx.knowledgePack.readDataFile(name)
  })
  ipc('knowledge:info', () => ctx.knowledgePack.info())
  ipc('knowledge:checkUpdate', (_event, sourceUrl: unknown) => {
    if (typeof sourceUrl !== 'string') throw new Error('参数错误')
    return ctx.knowledgePack.checkUpdate(sourceUrl)
  })
  ipc('knowledge:update', (_event, sourceUrl: unknown) => {
    if (typeof sourceUrl !== 'string') throw new Error('参数错误')
    return ctx.knowledgePack.update(sourceUrl)
  })
  ipc('knowledge:rollback', () => ctx.knowledgePack.rollback())
}
