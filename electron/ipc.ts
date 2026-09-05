/**
 * IPC 组合入口（M40 巨型文件拆分批次 B）：
 * 实现按域拆分到独立文件，本文件只保留 registerIpc 组合与兼容 re-export——
 * main.ts 与 tests/ipc.test.ts 的导入路径全部不变。
 *
 * 依赖分层（域文件绝不 import ./ipc，防止隐性循环）：
 * - ipcTypes        RegisterHandler 类型
 * - ipcContext      IpcContext / createIpcContext（注入式依赖与可变状态）
 * - projectTrust    项目根信任锚（登记/恢复/词法+真实路径校验）
 * - mediaPolicy     媒体允许集合（登记/恢复/data URL 读取）
 * - *Ipc 域文件     各通道注册（store/community/communityAuth/knowledge/git/
 *                   plugin/dialog/fs/mod/game/app/ai）
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { registerStoreIpc } from './storeIpc'
import { registerCommunityAuthIpc } from './communityAuthIpc'
import { registerCommunityIpc } from './communityIpc'
import { registerKnowledgeIpc } from './knowledgeIpc'
import { registerGitIpc } from './gitIpc'
import { registerDialogIpc } from './dialogIpc'
import { registerPluginIpc } from './pluginIpc'
import { registerFsIpc } from './fsIpc'
import { registerModIpc } from './modIpc'
import { registerGameIpc } from './gameIpc'
import { registerAppIpc } from './appIpc'
import { registerAiIpc } from './aiIpc'

// ── 兼容 re-export（main.ts / tests 既有导入路径不变）─────────────────
export type { RegisterHandler } from './ipcTypes'
export { createIpcContext, type IpcContext } from './ipcContext'
export { ANCHOR_MIGRATED_KEY, PROJECT_ROOTS_KEY, registerRoot, restoreProjectRoots } from './projectTrust'
export { MEDIA_ALLOWLIST_KEY, MEDIA_MIGRATED_KEY, registerMediaFromSettings, restoreMediaAllowlist } from './mediaPolicy'
export { createFeedbackChannel } from './aiIpc'
export { registerAiIpc } from './aiIpc'
export { registerAppIpc } from './appIpc'
export { registerCommunityAuthIpc } from './communityAuthIpc'
export { registerCommunityIpc } from './communityIpc'
export { registerDialogIpc } from './dialogIpc'
export { registerFsIpc } from './fsIpc'
export { registerGameIpc } from './gameIpc'
export { registerGitIpc } from './gitIpc'
export { registerKnowledgeIpc } from './knowledgeIpc'
export { registerModIpc } from './modIpc'
export { registerPluginIpc } from './pluginIpc'
export { registerStoreIpc } from './storeIpc'

/** 注册全部 IPC 通道（按域拆分，便于测试与维护） */
export function registerIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  registerStoreIpc(ctx, ipc)
  registerCommunityAuthIpc(ctx, ipc)
  registerCommunityIpc(ctx, ipc)
  registerKnowledgeIpc(ctx, ipc)
  registerGitIpc(ctx, ipc)
  registerDialogIpc(ctx, ipc)
  registerPluginIpc(ctx, ipc)
  registerFsIpc(ctx, ipc)
  registerModIpc(ctx, ipc)
  registerGameIpc(ctx, ipc)
  registerAppIpc(ctx, ipc)
  registerAiIpc(ctx, ipc)
}
