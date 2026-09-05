/**
 * AI 服务 IPC（M40 巨型文件拆分批次 B4）：
 * 检查 / 审批 / 中止 / 历史 / 流式对话 / DeepSeek 密钥保管。
 * 跨通道状态（ctx.ai）与反馈通道（createFeedbackChannel）都在本域。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { normalizePath } from './paths'
import { checkCommunity, checkDeepSeek, communityInfo, streamAgent } from './ai'
import { getHistory } from './aiHistory'
import type { AiApprovalResponse, AiChatParams, AiSettings } from '../src/types/ai'
import { requireInsideRoot, requireRealInsideRoot } from './projectTrust'

/** AI 历史路径校验：rootPath 必须已登记，relPath 必须相对且解析后在项目根内 */
function requireHistoryRelPath(ctx: IpcContext, rootPath: unknown, relPath: unknown): { root: string; rel: string } {
  if (typeof rootPath !== 'string' || typeof relPath !== 'string' || !relPath) {
    throw new Error('无效的参数')
  }
  // 与 writeFile 工具 resolveInside 对齐：剥前导斜杠（AI 可能用 /units/a.txt 写法；
  // win32 上 path.isAbsolute('/units/a.txt') === true，不剥会误拒）
  const rel = relPath.replace(/^\/+/, '')
  if (!rel || path.isAbsolute(rel) || rel.includes('..')) {
    throw new Error('无效的文件路径')
  }
  requireInsideRoot(ctx, rootPath, path.join(rootPath, rel))
  return { root: rootPath, rel }
}

/** M26-3 自纠闭环：质检反馈通道（队列 + 单等待槽）。
 * - receiver：渲染层 ai:feedback 投递；等待中直接唤醒，否则入队（上限 16 条防恶意塞爆）；
 * - wait：优先取队列（多条拼接为一次修正输入），否则挂起等待（超时/被唤醒返回 null/消息）；
 * - 被唤醒后晚到的消息入队即弃（本地队列，流结束丢弃，不跨流）。 */
export function createFeedbackChannel(): {
  receiver: (msg: string) => boolean
  wait: (timeoutMs: number) => Promise<string | null>
} {
  const queue: string[] = []
  let waiter: ((msg: string | null) => void) | null = null
  return {
    receiver: (msg) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(msg)
        return true
      }
      if (queue.length < 16) {
        queue.push(msg)
        return true
      }
      return false // 队列满：丢弃（尽力而为，渲染层忽略返回值）
    },
    wait: (timeoutMs) => {
      if (queue.length > 0) return Promise.resolve(queue.splice(0).join('\n\n'))
      if (waiter) {
        waiter(null)
        waiter = null
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = null
          resolve(null)
        }, timeoutMs)
        waiter = (msg) => {
          clearTimeout(timer)
          resolve(msg)
        }
      })
    },
  }
}

/** AI 服务：检查 / 审批 / 中止 / 历史 / 流式对话 / DeepSeek 密钥保管 */
export function registerAiIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  /** 读取已保存的 DeepSeek Key（safeStorage 解密；未配置返回空串） */
  async function resolveDeepSeekKey(): Promise<string> {
    if (!ctx.deepSeekCredentials) return ''
    return (await ctx.deepSeekCredentials.withCredential((key) => key)) ?? ''
  }

  ipc('ai:check', async (_event, settings: AiSettings) => {
    if (settings.provider === 'deepseek') {
      // Key 只存在主进程安全存储里；渲染层 settings 不再携带（防明文落盘/回传）
      return checkDeepSeek({ apiKey: await resolveDeepSeekKey(), model: settings.deepseekModel })
    }
    if (settings.provider === 'community') {
      // 社区 AI 未上线：主进程持有令牌，渲染层无 token 可传；直接走「即将上线」分支
      return checkCommunity({ endpoint: settings.communityEndpoint, token: '' })
    }
    return { ok: false, message: '未知的 AI 提供者' }
  })

  // DeepSeek API Key 保管：保存/查询/清除。Key 本体只进 safeStorage，任何响应都不回传。
  ipc('ai:credential:save', async (_event, key: unknown) => {
    if (!ctx.deepSeekCredentials) throw new Error('系统安全凭据存储不可用')
    if (typeof key !== 'string' || !key.trim()) throw new Error('API Key 不能为空')
    await ctx.deepSeekCredentials.saveCredential(key)
    return { ok: true }
  })

  ipc('ai:credential:status', async () => {
    if (!ctx.deepSeekCredentials) return { configured: false }
    return { configured: await ctx.deepSeekCredentials.hasCredential() }
  })

  ipc('ai:credential:clear', async () => {
    if (!ctx.deepSeekCredentials) return { ok: false }
    await ctx.deepSeekCredentials.clearCredential()
    return { ok: true }
  })

  ipc('ai:info', async () => {
    return {
      providers: [
        { type: 'deepseek', name: 'DeepSeek', description: '使用你自己的 DeepSeek API Key', available: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
        { ...communityInfo(), description: '我们提供的社区 AI 服务（即将上线）' },
      ],
    }
  })

  // AI 审批：界面响应写文件请求（resolver 由 ai:stream 的 beforeToolCall 挂起等待）。
  // 审批与互斥锁都归属「当前活动流」：旧流结束的 finally 只在仍持有所有权时清理，
  // 防止 abort 后新流的状态被旧流 finally 踩踏
  ipc('ai:approval:respond', (_event, response: AiApprovalResponse) => {
    // L6：只接受「当前待审批请求」的响应；过期弹窗/旧请求的响应一律忽略。
    // 返回是否被接受——渲染层据此提示「审批已过期」，避免 120s 边缘点击被静默忽略
    if (ctx.ai.pendingApproval && response && typeof response.id === 'string' && response.id === ctx.ai.pendingApproval.id) {
      ctx.ai.pendingApproval.resolve(response)
      ctx.ai.pendingApproval = null
      return true
    }
    return false
  })

  // 渲染层看门狗触发后中止当前流：置流级取消标志（旧流事件静默 + 工具调用全拒 +
  // AbortController 硬停止在途模型请求），拒绝在途审批、释放 AI 锁
  ipc('ai:stream:abort', () => {
    if (!ctx.ai.streamActive || !ctx.ai.cancel) return { aborted: false }
    ctx.ai.cancel.current = true
    ctx.ai.cancel.abort?.() // 硬停止：中断在途模型请求（停止计费）
    ctx.ai.cancel = null
    // 唤醒质检反馈等待（空串 = 不修正）+ 清掉接收器（防残留窗口吞掉新流前的消息）
    ctx.ai.feedbackReceiver?.('')
    ctx.ai.feedbackReceiver = null
    if (ctx.ai.pendingApproval) {
      ctx.ai.pendingApproval.resolve({ id: ctx.ai.pendingApproval.id, approved: false })
      ctx.ai.pendingApproval = null
    }
    ctx.ai.streamActive = false
    return { aborted: true }
  })

  // M26-3 自纠闭环：渲染层写后质检结果回传（空串 = 无问题）。
  // 只投递给「当前活动流」的等待窗口；无流/已结束返回 false（渲染层忽略）。
  // 消息上限 8KB：防恶意渲染层塞大文本进模型上下文（有费用）
  ipc('ai:feedback', (_event, message: unknown) => {
    if (typeof message !== 'string' || message.length > 8 * 1024) throw new Error('参数错误')
    if (!ctx.ai.feedbackReceiver) return false
    return ctx.ai.feedbackReceiver(message)
  })

  // AI 修改历史（任务 2）：快照在 writeFile 工具内记录（rustAgentTools），
  // 这里的两个通道只做「列出 / 恢复」。安全边界与 fs 通道一致：
  // rootPath 必须已登记，relPath 必须相对且解析后在项目根内。
  ipc('ai:history:list', async (_event, rootPath: unknown, relPath: unknown) => {
    const { root, rel } = requireHistoryRelPath(ctx, rootPath, relPath)
    return getHistory().listHistory(root, rel)
  })

  ipc('ai:history:restore', async (_event, rootPath: unknown, relPath: unknown, snapshotId: unknown) => {
    const { root, rel } = requireHistoryRelPath(ctx, rootPath, relPath)
    if (typeof snapshotId !== 'string' || !snapshotId) {
      return { ok: false, message: '无效的历史版本' }
    }
    const entry = await getHistory().getEntry(root, rel, snapshotId)
    if (!entry) {
      return { ok: false, message: '历史版本不存在或已被清理（超过保留上限）' }
    }
    const abs = path.join(root, rel)
    await requireRealInsideRoot(ctx, root, abs)
    if (entry.content === null) {
      // 快照时文件不存在（AI 新建）：恢复 = 删除该文件
      await fs.rm(abs, { force: true })
      return { ok: true, deleted: true }
    }
    // 原子写回（与 fs:writeFile 同一模式：临时文件 + rename，不破坏原文件）。
    // 临时文件落在目标文件同目录内（dirname 已过根 + 链接逃逸校验）
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.ra-h-${randomUUID()}.tmp`)
    if (!path.resolve(tmp).startsWith(path.resolve(path.dirname(abs)) + path.sep)) {
      throw new Error('无效的文件路径')
    }
    try {
      await fs.writeFile(tmp, entry.content, 'utf8')
      await fs.rename(tmp, abs)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    return { ok: true }
  })

  ipc('ai:stream', async (event: { sender: { isDestroyed(): boolean; send(channel: string, data: unknown): void } }, params: AiChatParams, settings: AiSettings, projectRoot: unknown) => {
    if (ctx.ai.streamActive) throw new Error('已有 AI 请求正在处理，请稍候再试')
    ctx.ai.streamActive = true
    // 每次流独立的取消标志：abort 只影响本流，新流不受旧流状态影响
    const cancelled: { current: boolean; abort?: () => void } = { current: false }
    ctx.ai.cancel = cancelled
    // M26-3 自纠闭环：本流的质检反馈等待窗口（渲染层 ai:feedback 投递到这里）
    const feedbackChannel = createFeedbackChannel()
    ctx.ai.feedbackReceiver = feedbackChannel.receiver
    // 主进程总时长兜底（15 分钟）：渲染层看门狗是 5 分钟无事件；若渲染层崩溃/关闭，
    // 旧流会永远占着 AI 锁——此处强制置取消 + 释放锁（工具全拒、事件静默，无副作用）
    const hardKill = setTimeout(() => {
      if (ctx.ai.cancel !== cancelled) return // 已被 abort/结束：跳过
      cancelled.current = true
      cancelled.abort?.() // 硬停止在途模型请求
      ctx.ai.cancel = null
      // 唤醒质检反馈等待（空串 = 不修正），避免 finally 被等待卡住、AI 锁迟迟不释放
      ctx.ai.feedbackReceiver?.('')
      ctx.ai.feedbackReceiver = null
      if (ctx.ai.pendingApproval) {
        ctx.ai.pendingApproval.resolve({ id: ctx.ai.pendingApproval.id, approved: false })
        ctx.ai.pendingApproval = null
      }
      ctx.ai.streamActive = false
    }, 15 * 60 * 1000)
    try {
      const sender = event.sender
      // 固定通道：单窗口应用，事件只推给发起请求的窗口
      const channel = 'ai:stream'
      // 项目根由渲染进程显式传入（持久化是防抖 300ms 写入，主进程读 store 可能拿到旧项目）。
      // 路径不可信，但只能指向用户打开过并已登记的项目。
      if (typeof projectRoot !== 'string' || !ctx.roots.has(normalizePath(projectRoot))) {
        throw new Error('项目未登记，无法使用 AI 工具，请重新打开项目')
      }
      // 消息体上限：恶意渲染层可传超大历史（内存 + API 费用）；200 条 / 2MB
      const messages = Array.isArray(params?.messages) ? params.messages : []
      if (messages.length > 200) throw new Error('对话历史过长（超过 200 条），请新建对话')
      let totalChars = 0
      for (const m of messages) {
        if (m && typeof m === 'object' && 'content' in m) totalChars += String((m as { content: unknown }).content ?? '').length
      }
      if (totalChars > 2 * 1024 * 1024) throw new Error('对话历史过大（超过 2MB），请新建对话')
      if (settings.provider === 'deepseek') {
        const deepSeekApiKey = await resolveDeepSeekKey()
        if (!deepSeekApiKey) throw new Error('尚未配置 DeepSeek API Key，请先在设置 → AI 中保存密钥')
        await streamAgent(
          sender as unknown as WebContents,
          channel,
          params,
          { apiKey: deepSeekApiKey, model: settings.deepseekModel },
          projectRoot,
          (id, resolve) => {
            // beforeToolCall 提供请求 id 与 resolve；approval:respond 按 id 匹配。
            // 本流已取消：新到的审批请求直接拒绝，不挂 UI
            if (cancelled.current) {
              resolve({ id, approved: false })
              return () => undefined
            }
            ctx.ai.pendingApproval = { id, resolve }
            // 返回清除回调：审批超时（ai.ts 120s）时清掉单槽 pendingApproval，
            // 防止过期响应命中旧 id 被误报「已批准」
            return () => {
              if (ctx.ai.pendingApproval?.id === id) ctx.ai.pendingApproval = null
            }
          },
          cancelled,
          feedbackChannel,
        )
      } else {
        // 流已取消则不发送（与 emit 静默一致，防旧流 error 命中新流监听器）
        if (!cancelled.current && !sender.isDestroyed()) sender.send(channel, { type: 'error', message: '社区 AI 服务即将上线' })
      }
      return channel
    } finally {
      clearTimeout(hardKill) // 流结束：取消强杀计时器
      // 所有权判断：只有本流仍是「当前活动流」时才清理全局状态——
      // abort 后用户已启动新流时，旧流的 finally 不能踩踏新流的审批/锁
      if (ctx.ai.cancel === cancelled) {
        ctx.ai.cancel = null
        ctx.ai.streamActive = false
        ctx.ai.pendingApproval = null
        ctx.ai.feedbackReceiver = null
      }
    }
  })
}
