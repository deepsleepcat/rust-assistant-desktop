/**
 * 全局状态仓库（Zustand）：整个应用唯一的「数据中枢」。
 * - 界面组件只从这里读取/修改状态，不直接碰文件系统；
 * - 所有持久化动作（设置、项目、对话）都会自动写入本地存储；
 * - 测试时传入 Mock 桥即可验证完整业务流。
 *
 * M26 重构：状态与动作按领域拆到 slices/ 下（aiSlice 对话流 / projectSlice 项目与编辑器 /
 * conversationSlice 对话管理 / uiSlice 通知与弹窗），本文件只保留：
 * 组合根（createWorkspaceStore）、跨领域基建（persist/flushPersist）、init、选择器。
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { BridgeApi, CommunityAuthStatus, CommunityAuthUser } from '../types/bridge'
import type { Conversation } from '../types/domain'
import { getBridge } from '../services/bridge'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../utils/settings'
import { sortConversations } from '../utils/conversation'
import { createAiSlice } from './slices/aiSlice'
import { createConversationSlice } from './slices/conversationSlice'
import { createProjectSlice } from './slices/projectSlice'
import { createUiSlice } from './slices/uiSlice'
import type { WorkspaceStore, WorkspaceStoreState } from './types'

export type { WorkspaceStore, WorkspaceStoreState, WorkspaceStoreActions, ConfirmRequest, EditorPosition } from './types'

function mapBridgeAuthState(state: CommunityAuthStatus['state']): 'signed_out' | 'signed_in' | 'checking' | 'error' {
  if (state === 'signed-in') return 'signed_in'
  if (state === 'unavailable') return 'error'
  return 'signed_out'
}

function mapBridgeUser(user: CommunityAuthUser | undefined) {
  return user
    ? { id: user.id, username: user.username, display_name: user.displayName, avatar_url: user.avatarUrl }
    : null
}

/** 持久化裁剪后仍超限的提示标志（本次会话只提示一次，防噪音） */
let trimNotified = false

export function createWorkspaceStore(bridge: BridgeApi) {
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  // L1：init 幂等（StrictMode 双挂载/重复调用只执行一次，避免重复订阅更新事件）
  let initPromise: Promise<void> | null = null
  let pairingCheckInFlight = false

  return create<WorkspaceStore>()((set, get) => {
    function persist(): void {
      const s = get()
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        // IPC 通道级失败（窗口销毁途中等）不产生 unhandled rejection；
        // 真实拒绝（如 store 超限）要提示，避免对话/项目记录静默丢失
        void bridge.store.set('settings', s.settings).catch(() => undefined)
        void persistWorkspace({
          projects: s.projects,
          activeProjectId: s.activeProjectId,
          conversations: s.conversations,
          lastActiveConversationByProject: s.lastActiveConversationByProject,
          bookmarks: s.bookmarks,
        })
      }, 300)
    }

    /** 写 workspace 持久化：被主进程以「过大」拒绝时，按对话裁剪旧消息后重试一次。
     * 长期使用 AI 后对话历史可能超 50MB 上限——整体拒绝会让项目列表/收藏一起停止落盘。 */
    async function persistWorkspace(payload: Parameters<BridgeApi['store']['set']>[1]): Promise<void> {
      const doSet = () => bridge.store.set('workspace', payload)
      try {
        await doSet()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/过大|超过/.test(msg)) {
          get().notify(`数据保存失败，部分内容可能未写入：${msg}`)
          return
        }
        // 超限：每个对话只保留最近 100 条消息（旧消息在长对话里价值最低），重试一次
        const trimmed = {
          ...(payload as Record<string, unknown>),
          conversations: ((payload as { conversations?: Conversation[] }).conversations ?? []).map((c) => ({
            ...c,
            messages: c.messages.length > 100 ? c.messages.slice(-100) : c.messages,
          })),
        }
        try {
          await bridge.store.set('workspace', trimmed)
          // 成功：本地也同步裁剪（避免下次 persist 再次超限）
          set({
            conversations: ((payload as { conversations?: Conversation[] }).conversations ?? []).map((c) =>
              c.messages.length > 100 ? { ...c, messages: c.messages.slice(-100) } : c,
            ),
          })
          get().notify('对话历史过长，已自动保留每个对话最近 100 条消息')
        } catch (err2) {
          // 裁剪后仍超限：本次会话只提示一次（每次 persist 都弹会形成噪音）
          if (!trimNotified) {
            trimNotified = true
            get().notify(`数据保存失败（对话历史过大且裁剪后仍超限）：${err2 instanceof Error ? err2.message : String(err2)}`)
          }
        }
      }
    }

    /** LOW-3b：应用关闭前同步落盘（取消防抖立即写入，主进程 before-quit 再兜底 flush）。
     * 两个键独立写：settings 失败不阻断 workspace（否则退出时项目/对话整块丢失） */
    async function flushPersist(): Promise<void> {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      const s = get()
      const results = await Promise.allSettled([
        bridge.store.set('settings', s.settings),
        persistWorkspace({
          projects: s.projects,
          activeProjectId: s.activeProjectId,
          conversations: s.conversations,
          lastActiveConversationByProject: s.lastActiveConversationByProject,
          bookmarks: s.bookmarks,
        }),
      ])
      for (const r of results) {
        if (r.status === 'rejected') {
          get().notify(`数据保存失败，部分内容可能未写入：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
      }
    }

    return {
      // ── 初始状态（各 slice 只提供动作，状态默认值集中在组合根）──
      ready: false,
      version: '0.1.0',
      settings: DEFAULT_SETTINGS,
      projects: [],
      activeProjectId: null,
      conversations: [],
      lastActiveConversationByProject: {},
      activeConversationId: null,
      treeRoot: null,
      treeError: null,
      bookmarks: [],
      openTabs: [],
      activeTabId: null,
      editorPos: { line: 1, col: 1 },
      settingsOpen: false,
      settingsTab: 'appearance',
      commandOpen: false,
      drawerSide: null,
      activeSurface: 'editor',
      communityTab: 'recommend',
      communityFollowing: [],
      communityAuth: { status: 'checking', user: null, error: null, pairing: null },
      codeTableOpen: false,
      versionDiffOpen: false,
      relationGraphOpen: false,
      templateLibraryOpen: false,
      gitInfoOpen: false,
      unitLibraryOpen: false,
      valueTypeOpen: false,
      turretEditorOpen: false,
      confirm: null,
      toast: null,
      aiStreamingConversationId: null,
      pendingApproval: null,
      editorJump: null,
      modDialog: null,
      modCheckResult: null,
      modReport: null,
      modReportOpen: false,
      modReportBusy: false,
      modReportError: null,
      modReportProgress: null,
      optimizeItems: null,
      optimizeError: null,
      translationRepairItems: null,
      translationRepairError: null,
      updateState: { status: 'idle' },

      // ── 领域切片（按域拆分，见 slices/）──
      ...createUiSlice()(set, get),
      async refreshCommunityAuth() {
        const bridgeAuth = bridge.auth
        if (!bridgeAuth) {
          // 浏览器预览模式：真实社区认证只属于桌面端，预览继续使用本地示例数据
          set({ communityAuth: { status: 'signed_out', user: null, error: null, pairing: null } })
          return
        }
        set({ communityAuth: { status: 'checking', user: get().communityAuth.user, error: null, pairing: get().communityAuth.pairing } })
        try {
          const status = await bridgeAuth.status()
          set({ communityAuth: { status: mapBridgeAuthState(status.state), user: mapBridgeUser(status.user), error: null, pairing: null } })
        } catch (error) {
          set({ communityAuth: { status: 'error', user: null, error: error instanceof Error ? error.message : String(error), pairing: null } })
        }
      },
      async loginCommunity() {
        if (get().communityAuth.status === 'loading') return
        set({ communityAuth: { status: 'loading', user: get().communityAuth.user, error: null, pairing: get().communityAuth.pairing } })
        try {
          const bridgeAuth = bridge.auth
          if (!bridgeAuth) throw new Error('社区登录仅支持桌面端')
          const pairing = await bridgeAuth.startPairing()
          set({ communityAuth: { status: 'loading', user: null, error: null, pairing: { userCode: pairing.userCode, expiresAt: pairing.expiresAt } } })
        } catch (error) {
          set({ communityAuth: { status: 'error', user: get().communityAuth.user, error: error instanceof Error ? error.message : String(error), pairing: null } })
        }
      },
      async checkCommunityPairing() {
        if (pairingCheckInFlight || get().communityAuth.status !== 'loading') return
        pairingCheckInFlight = true
        try {
          const bridgeAuth = bridge.auth
          if (!bridgeAuth) throw new Error('社区登录仅支持桌面端')
          const status = await bridgeAuth.pollPairing()
          if (status.state === 'signed-in') {
            set({ communityAuth: { status: 'signed_in', user: mapBridgeUser(status.user), error: null, pairing: null } })
            return
          }
          if (status.state === 'signed-out') {
            set({ communityAuth: { status: 'error', user: null, error: '配对已结束或已过期，请重新开始', pairing: null } })
          }
        } catch (error) {
          set({ communityAuth: { status: 'error', user: get().communityAuth.user, error: error instanceof Error ? error.message : String(error), pairing: null } })
        } finally {
          pairingCheckInFlight = false
        }
      },
      async cancelCommunityPairing() {
        try { await bridge.auth?.cancelPairing() } finally {
          set({ communityAuth: { status: 'signed_out', user: null, error: null, pairing: null } })
        }
      },
      async logoutCommunity() {
        if (bridge.auth) {
          try { await bridge.auth.logout() } catch { /* 本地仍清除会话 */ }
        }
        set({ communityAuth: { status: 'signed_out', user: null, error: null, pairing: null } })
      },
      ...createConversationSlice({ persist })(set, get),
      ...createAiSlice({ bridge, persist })(set, get),
      ...createProjectSlice({ bridge, persist })(set, get),

      async init() {
        // 幂等：进行中/已完成都直接返回，避免重复订阅更新事件；
        // 失败后重置 initPromise，允许后续重试（否则永久卡在「正在启动…」）
        if (initPromise) return initPromise
        initPromise = (async () => {
          const [settings, workspace, info] = await Promise.all([
            bridge.store.get('settings'),
            bridge.store.get('workspace'),
            bridge.appInfo(),
          ])
          const ws = (workspace ?? {}) as Partial<Pick<WorkspaceStoreState, 'projects' | 'activeProjectId' | 'conversations' | 'lastActiveConversationByProject' | 'bookmarks'>>
          set({
            version: info?.version ?? '0.1.0',
            settings: sanitizeSettings(settings),
            projects: Array.isArray(ws.projects) ? ws.projects : [],
            activeProjectId: typeof ws.activeProjectId === 'string' ? ws.activeProjectId : null,
            conversations: Array.isArray(ws.conversations) ? ws.conversations : [],
            lastActiveConversationByProject:
              ws.lastActiveConversationByProject && typeof ws.lastActiveConversationByProject === 'object'
                ? ws.lastActiveConversationByProject
                : {},
            bookmarks: Array.isArray(ws.bookmarks)
              ? (ws.bookmarks as Array<{ path?: string; name?: string; projectId?: string; isDirectory?: boolean }>)
                  // 旧版本收藏没有 projectId/isDirectory：无法归属项目，丢弃避免误操作
                  .filter((b) => typeof b.projectId === 'string' && typeof b.path === 'string')
                  .map((b) => ({ path: b.path as string, name: b.name ?? '', projectId: b.projectId as string, isDirectory: b.isDirectory ?? false }))
              : [],
          })
          const roots = get().projects.map((p) => p.rootPath)
          await bridge.project.registerRoots(roots)
          await get().refreshTree()
          set({ ready: true })
          void get().refreshCommunityAuth()

          // M6：订阅主进程的自动更新事件（设置 → 关于 展示状态）
          bridge.app.onUpdateEvent((event) => {
            if (event.type === 'update_available') set({ updateState: { status: 'available', version: event.version } })
            if (event.type === 'update_not_available') set({ updateState: { status: 'not_available', message: `已是最新版本（v${event.currentVersion}）` } })
            if (event.type === 'download_progress') set({ updateState: { status: 'downloading', percent: event.percent } })
            if (event.type === 'downloaded') set({ updateState: { status: 'downloaded', version: event.version } })
            if (event.type === 'update_error') set({ updateState: { status: 'error', message: event.message } })
          })
        })()
        // 失败：重置幂等标记（允许重试），错误抛给调用方处理
        initPromise = initPromise.catch((err) => {
          initPromise = null
          throw err
        })
        return initPromise
      },

      flushPersist,
    }
  })
}

/** 应用默认使用的全局仓库（真实桥） */
export const useWorkspaceStore = createWorkspaceStore(getBridge())

export const useSortedConversations = (projectId: string | null) =>
  useWorkspaceStore(
    useShallow((s) => {
      const list = projectId ? s.conversations.filter((c) => c.projectId === projectId) : []
      return sortConversations(list)
    }),
  )
