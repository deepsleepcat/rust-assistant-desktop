/**
 * UI 状态切片（M26：从 createWorkspaceStore 拆出）：
 * 通知（toast）、确认弹窗（confirm）、各类功能弹窗开关、编辑器光标位置、
 * 「定位到文件行」跳转请求。全部是纯 set/get 操作，无外部依赖。
 */
import type { StoreApi } from 'zustand'
import type { ConfirmRequest, EditorPosition, WorkspaceStore } from '../types'

export function createUiSlice() {
  return (set: StoreApi<WorkspaceStore>['setState'], get: () => WorkspaceStore) => ({
    setEditorPos(pos: EditorPosition) {
      set({ editorPos: pos })
    },

    setSettingsOpen(open: boolean) {
      set({ settingsOpen: open })
    },
    setCommandOpen(open: boolean) {
      set({ commandOpen: open })
    },
    setDrawerSide(side: 'left' | 'right' | null) {
      set({ drawerSide: side })
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
    setModDialog(kind: 'createMod' | 'createUnit' | 'check' | 'optimize' | 'pack' | 'globalOp' | null) {
      // 优化弹窗：每次打开都清掉旧扫描结果，由弹窗重新扫描（避免显示过期列表）
      if (kind === 'optimize') set({ optimizeItems: null, optimizeError: null })
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
