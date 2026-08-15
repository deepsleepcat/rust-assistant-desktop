/**
 * AI 对话流切片（M26：从 createWorkspaceStore 拆出——原最大单块）：
 * - sendAiMessage：发消息 → 流式事件（delta/reasoning/工具调用/审批/写后质检/完成/错误）
 *   → 5 分钟看门狗释放通道；本地 AI 用量统计
 * - respondApproval：审批响应（写文件请求），批准后刷新文件树与补全缓存
 * - aiRestoreFileVersion：恢复到 AI 写盘前快照（有未保存修改时先确认）
 */
import type { StoreApi } from 'zustand'
import type { BridgeApi } from '../../types/bridge'
import type { AiStreamEvent } from '../../types/ai'
import type { WorkspaceStore } from '../types'
import { getBridge } from '../../services/bridge'
import { invalidateResourceCache } from '../../features/editor/completion'
import { checkAiWrittenFile, lintItemsToFeedback } from '../../features/ai/aiQualityCheck'
import { parseStoredUsage } from '../../features/ai/usageStats'
import { RUST_ASSISTANT_SYSTEM_PROMPT } from '../../ai/rustSystemPrompt'

export interface AiSliceDeps {
  bridge: BridgeApi
  /** 持久化（由组合根注入：防抖写 settings + workspace） */
  persist: () => void
}

/** 质检用单位名扫描的短窗口缓存（2s）：AI 连续写文件时避免重复全项目扫描 */
let lastQualityScan: { root: string; at: number; result: { unitNames: string[] } | null } | null = null

export function createAiSlice(deps: AiSliceDeps) {
  return (set: StoreApi<WorkspaceStore>['setState'], get: () => WorkspaceStore) => ({
    async respondApproval(approved: boolean) {
      const req = get().pendingApproval
      if (!req) return
      set({ pendingApproval: null })
      try {
        const accepted = await deps.bridge.ai.approve({ id: req.id, approved })
        if (!accepted) {
          // 120s 超时边缘：主进程已按拒绝处理，本次点击未生效——明确告知，避免用户以为写入了
          get().notify(approved ? '审批已过期（超过 120 秒未响应），本次写入未执行' : '审批已过期，已按拒绝处理')
        }
        // AI 写文件后刷新文件树与补全缓存：新文件/修改要立即可见，否则 @file 补全查不到
        if (approved && accepted) {
          invalidateResourceCache()
          await get().refreshTree()
        }
      } catch (err) {
        get().notify(`审批处理失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    /** 恢复到指定历史版本（任务 2）：主进程写回磁盘 → 刷新树 → 重读打开中的标签页。
     * 打开标签有未保存修改时先确认（恢复会覆盖这些修改），用户拒绝则不动作。
     * 注意：该版本若为「文件创建前」的快照，恢复 = 删除文件（主进程删除后返回 deleted）。 */
    async aiRestoreFileVersion(relPath: string, snapshotId: string) {
      const s = get()
      const project = s.projects.find((p) => p.id === s.activeProjectId)
      if (!project) return
      const restore = async (): Promise<boolean> => {
        try {
          const res = await deps.bridge.ai.historyRestore(project.rootPath, relPath, snapshotId)
          if (!res?.ok) {
            get().notify(res?.message ?? '恢复失败：历史版本不可用')
            return false
          }
          invalidateResourceCache()
          await get().refreshTree()
          const tab = get().openTabs.find((t) => t.path === relPath)
          if (tab) await get().reloadTab(tab.id)
          get().notify(res.deleted ? '已恢复到所选历史版本（该版本为文件创建前，文件已删除）' : '已恢复到所选历史版本')
          return true
        } catch (err) {
          get().notify(`恢复失败：${err instanceof Error ? err.message : String(err)}`)
          return false
        }
      }
      const tab = s.openTabs.find((t) => t.path === relPath)
      if (tab?.dirty) {
        s.requestConfirm({
          title: '恢复历史版本',
          message: `恢复历史版本会用所选版本替换「${tab.name}」的当前内容；若该版本为文件创建前，文件将被删除。当前未保存的修改会丢失。`,
          danger: true,
          confirmText: '覆盖并恢复',
          cancelText: '取消',
          onConfirm: () => {
            void restore()
          },
        })
      } else {
        await restore()
      }
    },

    async sendAiMessage(conversationId: string, text: string) {
      const s = get()
      const conversation = s.conversations.find((c) => c.id === conversationId)
      const project = s.projects.find((p) => p.id === s.activeProjectId)
      if (!conversation || !project) return
      const now = Date.now()
      const settings = s.settings.ai
      const trimmed = text.trim()
      if (!trimmed) return
      if (s.aiStreamingConversationId) {
        get().notify('AI 正在回复中，请稍候')
        return
      }

      // 1. 加入用户消息
      const userMessage = { id: crypto.randomUUID(), role: 'user' as const, content: trimmed, createdAt: now }
      set({
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, messages: [...c.messages, userMessage], updatedAt: now } : c,
        ),
        aiStreamingConversationId: conversationId,
      })
      deps.persist()

      // 活动看门狗：流启动后若主进程崩溃/挂死且无终态事件，AI 通道会被永久锁死。
      // 任意事件（delta/tool/approval）都会重置计时——健康的长流不会被误判超时；
      // 5 分钟无任何事件才触发。触发时注销旧订阅 + 通知主进程 abort（拒绝在途/后续
      // 审批，释放主进程 AI 锁），避免「超时后陈旧审批仍可批准写盘 / 新请求被主进程误拒」
      let unsubscribe: () => void = () => undefined // 订阅句柄（executor 内赋值，guard/终态共用）
      let guardTimer: ReturnType<typeof setTimeout> | null = null
      const armGuard = () => {
        if (guardTimer) clearTimeout(guardTimer)
        guardTimer = setTimeout(() => {
          unsubscribe()
          set({ aiStreamingConversationId: null, pendingApproval: null })
          void deps.bridge.ai.streamAbort().catch(() => {
            // abort 失败：主进程 AI 锁可能未释放，明确告知（否则下次发送被拒且无解释）
            get().notify('AI 通道可能仍被占用：如发送失败请重启应用')
          })
          get().notify('AI 回复超时（5 分钟无响应），已释放输入通道；如有问题请重试')
        }, 5 * 60 * 1000)
      }
      armGuard()
      const clearGuard = () => {
        if (guardTimer) {
          clearTimeout(guardTimer)
          guardTimer = null
        }
      }

      // 2. 加入空的 AI 消息（流式填充）
      const aiMessageId = crypto.randomUUID()
      set({
        conversations: get().conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: [...c.messages, { id: aiMessageId, role: 'assistant' as const, content: '', createdAt: Date.now() }] }
            : c,
        ),
      })

      // 3. 组装历史消息（包含本次用户消息与占位 AI 消息）
      const history = get().conversations.find((c) => c.id === conversationId)?.messages ?? []
      const messages = history
        .filter((m) => m.content.length > 0)
        .map((m) => ({ role: m.role, content: m.content }))

      // 4. 流式请求：订阅事件，用 Promise 等待结束
      const appendDelta = (delta: string) => {
        set({
          conversations: get().conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: c.messages.map((m) => (m.id === aiMessageId ? { ...m, content: m.content + delta } : m)) }
              : c,
          ),
        })
      }

      await new Promise<void>((resolve) => {
        // P3：onAiEvent 注册同步抛错（契约违反）的防御——不锁死 AI 通道
        try {
          unsubscribe = deps.bridge.ai.onAiEvent((event: AiStreamEvent) => {
            if (event.type === 'delta') { appendDelta(event.text); armGuard() }
            if (event.type === 'reasoning') {
              set({
                conversations: get().conversations.map((c) =>
                  c.id === conversationId
                    ? { ...c, messages: c.messages.map((m) => (m.id === aiMessageId ? { ...m, reasoning: (m.reasoning ?? '') + event.text } : m)) }
                    : c,
                ),
              })
              armGuard()
            }
            if (event.type === 'tool_start') {
              // writeFile 的 args 含完整写入内容：剥离后随对话持久化（防 workspace store
              // 长期使用后膨胀到主进程体积上限；工具卡片只需要 path 等元信息）
              const args = { ...(event.args ?? {}) }
              if (event.name === 'writeFile' && 'content' in args) delete (args as Record<string, unknown>).content
              const toolEvent: import('../../types/domain').ToolEvent = { id: crypto.randomUUID(), type: 'tool_start', name: event.name, args, createdAt: Date.now() }
              set({
                conversations: get().conversations.map((c) =>
                  c.id === conversationId ? { ...c, toolEvents: [...(c.toolEvents ?? []), toolEvent] } : c,
                ),
              })
              armGuard()
            }
            if (event.type === 'tool_end') {
              // M19：generateCheckCases 等工具卡片需要参数（规则/目标文件）——
              // tool_end 事件本身不带 args，从同名的最近一次 tool_start 取（配对还原）
              const startArgs = [...(get().conversations.find((c) => c.id === conversationId)?.toolEvents ?? [])]
                .reverse()
                .find((t) => t.type === 'tool_start' && t.name === event.name)?.args
              const toolEvent: import('../../types/domain').ToolEvent = { id: crypto.randomUUID(), type: 'tool_end', name: event.name, ok: event.ok, summary: event.summary, createdAt: Date.now(), path: event.path, snapshotId: event.snapshotId, snapshotSkipped: event.snapshotSkipped, args: startArgs }
              set({
                conversations: get().conversations.map((c) =>
                  c.id === conversationId ? { ...c, toolEvents: [...(c.toolEvents ?? []), toolEvent] } : c,
                ),
              })
              // 任务 3 + M10：AI 写文件成功后自动质检（异步，不阻塞流；结果挂到该工具卡片上）。
              // 与撤销/历史完全独立——质检发现问题不影响撤销能力；
              // 语义检查器按设置开关过滤，引用完整性检查使用项目单位名（扫描后传入）
              if (event.name === 'writeFile') {
                if (!event.ok || !event.path) {
                  // 被拒/执行失败：不会质检 → 立即释放主进程的反馈等待窗口（空串 = 不修正）
                  void deps.bridge.ai.feedbackLint('').catch(() => undefined)
                } else {
                  const relPath = event.path
                  void (async () => {
                  // 流进行中项目可能已切换/关闭：重新取当前项目，避免陈旧 rootPath；
                  // 提前退出也要释放主进程的反馈等待（空串 = 不修正），避免干等 10s 兜底
                  const current = get().projects.find((p) => p.id === project.id)
                  if (!current) {
                    void deps.bridge.ai.feedbackLint('').catch(() => undefined)
                    return
                  }
                  const semanticCheckers = get().settings.semanticCheckers
                  const targetVersionName = get().settings.targetGameVersion
                  // 质检必须用最新单位名（AI 刚写的单位要在引用检查中立即可见）。
                  // 同项目 2s 窗口内共享一次扫描（AI 一个流连续写 N 个文件只扫一次）：
                  // 每次扫描都在 writeFile 完成后触发，已包含此前全部写入，共享结果安全
                  const now = Date.now()
                  let scan = lastQualityScan && lastQualityScan.root === current.rootPath && now - lastQualityScan.at < 2000 ? lastQualityScan.result : null
                  if (!scan) {
                    scan = await getBridge().mod.scanResources(current.rootPath).catch(() => null)
                    lastQualityScan = { root: current.rootPath, at: now, result: scan }
                  }
                  // 扫描失败/空项目时传 undefined → 引用检查整体跳过，
                  // 避免「扫描失败被当作空项目」导致 builtFrom/convertTo 全部误报
                  const unitNames = scan && scan.unitNames.length > 0 ? new Set(scan.unitNames) : undefined
                  const items = await checkAiWrittenFile(current.rootPath, relPath, { semanticCheckers, unitNames, targetVersionName })
                  if (items && items.length > 0) {
                    set({
                      conversations: get().conversations.map((c) =>
                        c.id === conversationId
                          ? { ...c, toolEvents: (c.toolEvents ?? []).map((t) => (t.id === toolEvent.id ? { ...t, lint: items } : t)) }
                          : c,
                      ),
                    })
                    // M26-3 自纠闭环：把质检问题回传给主进程 → AI 自动修正（主进程最多追加 1 次修正对话）
                    void deps.bridge.ai.feedbackLint(lintItemsToFeedback(items)).catch(() => undefined)
                  } else {
                    // 质检完成但无问题，或无法检查（非 ini/读取失败）：都立即释放主进程等待窗口
                    void deps.bridge.ai.feedbackLint('').catch(() => undefined)
                  }
                  })()
                }
              }
              armGuard()
            }
            if (event.type === 'approval_request') {
              set({
                pendingApproval: {
                  id: event.id,
                  path: event.path,
                  contentPreview: event.contentPreview,
                  contentLength: event.contentLength,
                  diff: event.diff ?? null,
                  diffSummary: event.diffSummary ?? null,
                  oldExists: event.oldExists ?? false,
                  newFile: event.newFile ?? false,
                },
              })
              armGuard()
            }
            if (event.type === 'approval_expired') {
              // 审批超时（用户未响应）：关闭弹窗，不打扰后续对话
              set({ pendingApproval: get().pendingApproval?.id === event.id ? null : get().pendingApproval })
            }
            if (event.type === 'done') {
              clearGuard()
              unsubscribe()
              // M23：本地 AI 用量统计（调用次数 + 估算 token；纯本地，供未来服务器阶段对接成本核算）
              void (async () => {
                const { addUsageRecord, estimateTokens } = await import('../../features/ai/usageStats')
                const aiSettings = get().settings.ai
                const assistantMsg = get().conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.id === aiMessageId)
                const usage = {
                  at: Date.now(),
                  provider: aiSettings.provider,
                  model: aiSettings.provider === 'deepseek' ? aiSettings.deepseekModel : aiSettings.communityModel,
                  inputTokens: estimateTokens(trimmed),
                  outputTokens: estimateTokens(assistantMsg?.content ?? ''),
                }
                const records = addUsageRecord(parseStoredUsage(await getBridge().store.get('aiUsage').catch(() => null)), usage)
                await getBridge().store.set('aiUsage', records).catch(() => undefined)
              })()
              set({ aiStreamingConversationId: null })
              resolve()
            }
            if (event.type === 'error') {
              clearGuard()
              unsubscribe()
              set({
                aiStreamingConversationId: null,
                pendingApproval: null,
                conversations: get().conversations.map((c) => c.id === conversationId
                  ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: `AI 请求失败：${event.message}` } : m) }
                  : c),
              })
              get().notify(event.message)
              resolve()
            }
          })
        } catch (err) {
          // onAiEvent 同步抛错：释放 AI 锁并提示（不锁死通道）
          clearGuard()
          const message = `AI 请求失败：${err instanceof Error ? err.message : String(err)}`
          set({
            aiStreamingConversationId: null,
            pendingApproval: null,
            conversations: get().conversations.map((c) => c.id === conversationId
              ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: message } : m) }
              : c),
          })
          get().notify(message)
          resolve()
          return
        }
        // stream 同步抛错（违反契约）的防御：不锁死 AI 通道（aiStreamingConversationId 释放）
        let streamSyncError: unknown = null
        try {
          void deps.bridge.ai
            .stream(
              {
                provider: settings.provider,
                model: settings.provider === 'deepseek' ? settings.deepseekModel : settings.communityModel,
                systemPrompt: RUST_ASSISTANT_SYSTEM_PROMPT,
                messages,
              },
              settings,
              // 显式传当前项目根：主进程持久化有 300ms 防抖，读 store 可能拿到旧项目
              project.rootPath,
            )
            .catch((err) => {
              clearGuard()
              unsubscribe()
              const message = `AI 请求失败：${err instanceof Error ? err.message : String(err)}`
              set({
                aiStreamingConversationId: null,
                pendingApproval: null,
                conversations: get().conversations.map((c) => c.id === conversationId
                  ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: message } : m) }
                  : c),
              })
              get().notify(message)
              resolve()
            })
        } catch (err) {
          streamSyncError = err
        }
        if (streamSyncError !== null) {
          clearGuard()
          unsubscribe()
          const message = `AI 请求失败：${streamSyncError instanceof Error ? streamSyncError.message : String(streamSyncError)}`
          set({
            aiStreamingConversationId: null,
            pendingApproval: null,
            conversations: get().conversations.map((c) => c.id === conversationId
              ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: message } : m) }
              : c),
          })
          get().notify(message)
          resolve()
        }
      })
      set({
        conversations: get().conversations.map((c) =>
          c.id === conversationId ? { ...c, updatedAt: Date.now() } : c,
        ),
      })
      deps.persist()
    },
  })
}
