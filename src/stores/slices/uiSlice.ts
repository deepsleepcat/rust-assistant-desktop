/**
 * UI 状态切片（M26：从 createWorkspaceStore 拆出）：
 * 通知（toast）、确认弹窗（confirm）、各类功能弹窗开关、编辑器光标位置、
 * 「定位到文件行」跳转请求。全部是纯 set/get 操作，无外部依赖。
 */
import type { StoreApi } from 'zustand'
import type { ConfirmRequest, EditorPosition, NonSettingsSurface, SettingsTab, WorkspaceStore, WorkspaceSurface } from '../types'
import type { CommunityTab } from '../../features/community/communityData'

export function createUiSlice() {
  return (set: StoreApi<WorkspaceStore>['setState'], get: () => WorkspaceStore) => ({
    setEditorPos(pos: EditorPosition) {
      set({ editorPos: pos })
    },

    setSettingsOpen(open: boolean) {
      const current = get().activeSurface
      if (open) {
        const returnSurface: NonSettingsSurface = current === 'settings' ? get().settingsReturnSurface : current
        set({ settingsOpen: true, activeSurface: 'settings', settingsReturnSurface: returnSurface, settingsTab: 'appearance', drawerSide: null })
        return
      }
      set({
        settingsOpen: false,
        activeSurface: current === 'settings' ? get().settingsReturnSurface : current,
      })
    },
    openSettings(tab: SettingsTab = 'appearance') {
      const current = get().activeSurface
      const returnSurface: NonSettingsSurface = current === 'settings' ? get().settingsReturnSurface : current
      set({ settingsOpen: true, activeSurface: 'settings', settingsReturnSurface: returnSurface, settingsTab: tab, drawerSide: null })
    },
    setSettingsTab(tab: SettingsTab) {
      set({ settingsTab: tab })
    },
    setCommandOpen(open: boolean) {
      set({ commandOpen: open })
    },
    setDrawerSide(side: 'left' | 'right' | null) {
      set({ drawerSide: side })
    },
    setActiveSurface(surface: WorkspaceSurface) {
      const current = get().activeSurface
      if (surface === 'settings') {
        const returnSurface: NonSettingsSurface = current === 'settings' ? get().settingsReturnSurface : current
        set({ activeSurface: surface, settingsOpen: true, settingsReturnSurface: returnSurface, drawerSide: null })
        return
      }
      set({
        activeSurface: surface,
        settingsOpen: false,
        drawerSide: null,
        ...(surface === 'cloudBag' ? { communityTab: 'cloudBag' as CommunityTab } : {}),
        ...(surface === 'community' && get().communityTab === 'cloudBag' ? { communityTab: get().communityReturnTab } : {}),
      })
    },
    setCommunityTab(tab: CommunityTab) {
      const current = get().activeSurface
      const inCommunity = current === 'community' || current === 'cloudBag'
      set({
        communityTab: tab,
        ...(tab !== 'cloudBag' ? { communityReturnTab: tab } : {}),
        ...(inCommunity ? { activeSurface: tab === 'cloudBag' ? 'cloudBag' as const : 'community' as const, drawerSide: null } : {}),
      })
    },
    setCloudBagView(patch: { slug?: string | null; section?: 'files' | 'issues' | 'versions' | 'members' | 'settings' }) {
      set((state) => ({
        cloudBagSlug: patch.slug !== undefined ? patch.slug : state.cloudBagSlug,
        cloudBagSection: patch.section ?? (patch.slug !== undefined ? 'files' : state.cloudBagSection),
      }))
    },
    toggleCommunityFollow(creatorId: string) {
      const list = get().communityFollowing
      set({
        communityFollowing: list.includes(creatorId) ? list.filter((id) => id !== creatorId) : [...list, creatorId],
      })
    },
    setCodeTableOpen(open: boolean) {
      set({ codeTableOpen: open })
    },
    setVersionDiffOpen(open: boolean) {
      set({ versionDiffOpen: open })
    },
    setRelationGraphOpen(open: boolean) {
      set({ relationGraphOpen: open })
    },
    setTemplateLibraryOpen(open: boolean) {
      set({ templateLibraryOpen: open })
    },
    setGitInfoOpen(open: boolean) {
      set({ gitInfoOpen: open })
    },
    setUnitLibraryOpen(open: boolean) {
      set({ unitLibraryOpen: open })
    },
    setValueTypeOpen(open: boolean) {
      set({ valueTypeOpen: open })
    },
    setTurretEditorOpen(open: boolean) {
      set({ turretEditorOpen: open })
    },

    requestConfirm(req: ConfirmRequest) {
      // M32：新确认覆盖旧确认前，先释放旧确认挂起的调用方（如 confirmDirtySwitch 的
      // Promise）——否则旧调用方永远等不到 resolve，其善后回调（如导入失败清理解压目录）不执行
      const prev = get().confirm
      if (prev && prev !== req) prev.onCancel?.()
      set({ confirm: req })
    },
    dismissConfirm() {
      set({ confirm: null })
    },

    jumpToFileLine(path: string, line: number) {
      // 打开/激活标签页，再发定位请求（EditorPane 消费后跳转；seq 递增保证重复跳同一行也生效）
      void get().openFile(path)
      const prev = get().editorJump
      set({ editorJump: { path, line, seq: (prev?.seq ?? 0) + 1 } })
    },

    consumeEditorJump() {
      if (get().editorJump) set({ editorJump: null })
    },

    /** M5：模组工具弹窗开关 */
    setModDialog(kind: 'createMod' | 'createUnit' | 'check' | 'optimize' | 'pack' | 'globalOp' | 'import' | 'translationRepair' | null) {
      // 优化弹窗：每次打开都清掉旧扫描结果，由弹窗重新扫描（避免显示过期列表）
      if (kind === 'optimize') set({ optimizeItems: null, optimizeError: null })
      if (kind === 'translationRepair') set({ translationRepairItems: null, translationRepairError: null })
      set({ modDialog: kind })
    },

    notify(message: string) {
      set({ toast: message })
    },
    dismissToast() {
      set({ toast: null })
    },
  })
}
