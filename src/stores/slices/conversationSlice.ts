/**
 * 对话管理切片（M26：从 createWorkspaceStore 拆出）：
 * 对话的创建/重命名/归档/删除/切换，以及「项目最后活跃对话」记录。
 */
import type { StoreApi } from 'zustand'
import type { WorkspaceStore } from '../types'
import type { Conversation } from '../../types/domain'
import { nextConversationTitle } from '../../utils/conversation'

export interface ConversationSliceDeps {
  /** 持久化（由组合根注入：防抖写 settings + workspace） */
  persist: () => void
}

export function createConversationSlice(deps: ConversationSliceDeps) {
  return (set: StoreApi<WorkspaceStore>['setState'], get: () => WorkspaceStore) => ({
    createConversation() {
      const projectId = get().activeProjectId
      if (!projectId) return
      const projectConversations = get().conversations.filter((c) => c.projectId === projectId)
      const now = Date.now()
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        projectId,
        title: nextConversationTitle(projectConversations),
        createdAt: now,
        updatedAt: now,
        archived: false,
        messages: [],
      }
      set({
        conversations: [...get().conversations, conversation],
        activeConversationId: conversation.id,
        lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [projectId]: conversation.id },
      })
      deps.persist()
      get().notify(`已创建「${conversation.title}」`)
    },

    renameConversation(id: string, title: string) {
      const trimmed = title.trim()
      if (!trimmed) return
      set({
        conversations: get().conversations.map((c) => (c.id === id ? { ...c, title: trimmed, updatedAt: Date.now() } : c)),
      })
      deps.persist()
    },

    toggleArchiveConversation(id: string) {
      const s = get()
      const target = s.conversations.find((c) => c.id === id)
      if (!target) return
      const archived = !target.archived
      set({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, archived, updatedAt: Date.now() } : c)),
      })
      if (archived && s.activeConversationId === id) {
        const projectConvs = get().conversations.filter((c) => c.projectId === target.projectId && !c.archived)
        const next = projectConvs[0]?.id ?? null
        set({
          activeConversationId: next,
          lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [target.projectId]: next },
        })
      }
      deps.persist()
    },

    deleteConversation(id: string) {
      const s = get()
      const target = s.conversations.find((c) => c.id === id)
      set({ conversations: s.conversations.filter((c) => c.id !== id) })
      if (target && s.activeConversationId === id) {
        const projectConvs = get().conversations.filter((c) => c.projectId === target.projectId)
        const next = projectConvs[0]?.id ?? null
        set({
          activeConversationId: next,
          lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [target.projectId]: next },
        })
      }
      deps.persist()
    },

    selectConversation(id: string) {
      const projectId = get().activeProjectId
      if (!projectId) return
      set({
        activeConversationId: id,
        lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [projectId]: id },
      })
      deps.persist()
    },
  })
}
