/**
 * IPC 注入上下文（M40 巨型文件拆分批次 B1）：
 * 各域注册函数共享的依赖与可变状态（集中在一处，可注入、可断言）。
 * 本文件不 import 任何 IPC 域文件——依赖方向始终是 域文件 → ipcContext。
 */
import type { App, Dialog, Shell, WebContents } from 'electron'
import type { JsonStore } from './store'
import { COMMUNITY_AUTH_CREDENTIAL_KEY, DEEPSEEK_CREDENTIAL_KEY, type SecureCredentials } from './secureCredentials'
import type { CommunityAuthService } from './communityAuth'
import { createKnowledgePack } from './knowledgePack'
import type { AiApprovalResponse } from '../src/types/ai'

export type { RegisterHandler } from './ipcTypes'

/** 各域注册函数共享的依赖与可变状态（集中在一处，可注入、可断言） */
export interface IpcContext {
  /** 本地 JSON 存储（信任锚也存这里） */
  store: JsonStore
  /** 知识包（数据文件读取/更新/回滚） */
  knowledgePack: ReturnType<typeof createKnowledgePack>
  /** 已登记允许操作的项目根目录（规范化后的绝对路径） */
  roots: Set<string>
  /** 允许读取的媒体路径集合（仅对话框/自写文件来源） */
  media: Set<string>
  /** 打包/优化/全局操作互斥（批量 IO，防并发互相覆盖） */
  packing: { active: boolean }
  /** 背景音乐源（会话内登记，mod:create 只接受集合内文件） */
  musicSources: Set<string>
  /** 本会话导入创建的目录（mod:discardImport 只清理这些） */
  importedDirs: Set<string>
  /** 退出/关闭流程共享状态 */
  lifecycle: {
    /** before-quit 已进入退出流程（installUpdate 不再弹框、close 直接放行） */
    quitting: boolean
    /** 渲染层落盘确认 resolve（app:flush-done 触发） */
    flushResolve: (() => void) | null
    /** before-quit 落盘确认超时兜底 */
    flushConfirmTimer: ReturnType<typeof setTimeout> | null
    /** 窗口 close 落盘兜底定时器 */
    closeFlushTimer: ReturnType<typeof setTimeout> | null
  }
  /** AI 流互斥与审批（ai:* 处理器共享；跨通道状态集中在 ctx 才能注入/断言） */
  ai: {
    pendingApproval: { id: string; resolve: (r: AiApprovalResponse) => void } | null
    streamActive: boolean
    cancel: { current: boolean; abort?: () => void } | null
    /** M26-3 自纠闭环：当前流的质检反馈接收器（ai:feedback → 当前流；无流时返回 false） */
    feedbackReceiver: ((message: string) => boolean) | null
  }
  /** Electron 对话框（测试注入假实现） */
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog' | 'showMessageBox'>
  /** 系统能力（测试注入假实现） */
  shell: Pick<Shell, 'trashItem'>
  /** 应用信息（测试注入假实现） */
  app: Pick<App, 'getVersion' | 'getPath'>
  /** 自动更新（依赖 electron-updater，测试注入假实现） */
  updater: {
    checkForUpdates: () => Promise<void>
    downloadUpdate: () => Promise<void>
    quitAndInstall: () => void
    isPackaged: () => boolean
  }
  /** 窗口访问（app:flush-done 销毁窗口用；测试注入假实现） */
  windows: {
    getAllWindows: () => Array<{ isDestroyed(): boolean; destroy(): void }>
  }
  /** 设备配对认证（主进程私有令牌；渲染层只拿公开状态） */
  communityAuth: CommunityAuthService | null
  /** DeepSeek API Key（safeStorage 加密存储；渲染层只拿「已配置」状态，永不见 Key 本身） */
  deepSeekCredentials: SecureCredentials | null
}

/** 组装上下文：外部传入真实/假能力，可变状态在此初始化 */
export function createIpcContext(deps: {
  store: JsonStore
  knowledgePack: ReturnType<typeof createKnowledgePack>
  dialog: IpcContext['dialog']
  shell: IpcContext['shell']
  app: IpcContext['app']
  updater: IpcContext['updater']
  windows: IpcContext['windows']
  communityAuth?: CommunityAuthService | null
  deepSeekCredentials?: SecureCredentials | null
}): IpcContext {
  return {
    ...deps,
    roots: new Set<string>(),
    media: new Set<string>(),
    packing: { active: false },
    musicSources: new Set<string>(),
    importedDirs: new Set<string>(),
    lifecycle: { quitting: false, flushResolve: null, flushConfirmTimer: null, closeFlushTimer: null },
    ai: { pendingApproval: null, streamActive: false, cancel: null, feedbackReceiver: null },
    communityAuth: deps.communityAuth ?? null,
    deepSeekCredentials: deps.deepSeekCredentials ?? null,
  }
}

export { COMMUNITY_AUTH_CREDENTIAL_KEY, DEEPSEEK_CREDENTIAL_KEY }
export type { WebContents }
