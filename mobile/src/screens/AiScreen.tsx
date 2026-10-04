/**
 * AI 对话页（BYOK）：消息流 + 流式输出 + 工具卡片 + 写文件审批弹窗。
 * 使用用户自配的 DeepSeek API Key（仅存本机，见设置页）。
 */
import { useEffect, useRef, useState } from "react"
import { useWorkspace } from "../stores/workspace"
import type { AiChatMessage } from "../types/ai"
import { runAgentChat } from "../features/ai/aiClient"
import { AppIcon } from "../components/AppIcon"
import { formatRelativeTime } from "../utils/conversation"
import { joinProjectPath } from "../utils/projectPath"

interface UiMessage {
  id: string
  role: "user" | "assistant"
  content: string
  /** 流式输出中的增量文本 */
  streaming?: boolean
  createdAt: number
  tools?: Array<{ name: string; ok: boolean; summary: string }>
}

interface Approval {
  tool: string
  path: string
  contentPreview: string
  resolve: (approved: boolean) => void
}

export function AiScreen() {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const settings = useWorkspace((s) => s.settings)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [approval, setApproval] = useState<Approval | null>(null)
  const abortRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    if (!settings.ai.deepseekApiKey) {
      setActiveTab("settings")
      return
    }
    if (!activeProject) {
      setActiveTab("projects")
      return
    }
    setInput("")
    abortRef.current = false
    const userMsg: UiMessage = { id: crypto.randomUUID(), role: "user", content: text, createdAt: Date.now() }
    const assistantMsg: UiMessage = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true, createdAt: Date.now() }
    setMessages((m) => [...m, userMsg, assistantMsg])
    setBusy(true)

    const history: AiChatMessage[] = messages
      .filter((m) => m.content)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }))

    const approveWrite = (req: { tool: string; path: string; contentPreview: string }): Promise<boolean> =>
      new Promise((resolve) => {
        setApproval({ ...req, resolve })
      })

    try {
      await runAgentChat({
        settings: settings.ai,
        projectRoot: activeProject.rootPath,
        messages: [...history, { role: "user", content: text }],
        onDelta: (delta) => {
          setMessages((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, content: x.content + delta } : x)))
        },
        onTool: (ev) => {
          setMessages((m) =>
            m.map((x) =>
              x.id === assistantMsg.id
                ? { ...x, tools: [...(x.tools ?? []), { name: ev.name, ok: ev.ok, summary: ev.summary }] }
                : x,
            ),
          )
          // AI 写盘命中「当前正在编辑的文件」时，编辑器里的内容已经过期：
          // 打上冲突哨兵，用户下次保存会先看到「重新载入 / 仍然覆盖」而不是静默覆盖 AI 的改动
          if (ev.ok && (ev.name === 'writeFile' || ev.name === 'applyDiff')) {
            try {
              const rel = String((ev.args as { path?: unknown })?.path ?? '')
              const state = useWorkspace.getState()
              const session = state.editorSession
              if (rel && session && session.path === joinProjectPath(session.rootPath, rel)) {
                state.markEditorExternallyChanged()
              }
            } catch {
              // 路径不规范（含盘符等）只是判定不出冲突，绝不能据此打断对话循环
            }
          }
        },
        approveWrite,
        isAborted: () => abortRef.current,
      })
      setMessages((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, streaming: false } : x)))
    } catch (err) {
      setMessages((m) =>
        m.map((x) =>
          x.id === assistantMsg.id
            ? { ...x, streaming: false, content: x.content || `错误：${err instanceof Error ? err.message : String(err)}` }
            : x,
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <h1 className="m-screen-title">AI 助手</h1>
        {busy && (
          <button
            className="m-btn"
            onClick={() => {
              abortRef.current = true
              setBusy(false)
            }}
          >
            <AppIcon name="stop" size={16} />
            停止
          </button>
        )}
      </header>
      <div className="m-scroll" ref={scrollRef} style={{ padding: 12 }}>
        {messages.length === 0 && (
          <div className="m-empty">
            <AppIcon name="sparkle" size={40} />
            <p>
              用 AI 生成单位代码、解释字段、检查模组问题。
              <br />
              写文件会先征求你的确认。
            </p>
            {!settings.ai.deepseekApiKey && <p style={{ fontSize: 12 }}>尚未配置 API Key：前往「设置 → AI」填写</p>}
            {!activeProject && <p style={{ fontSize: 12 }}>尚未打开项目：先到「项目」页导入或创建</p>}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <div className="ai-bubble">
              {m.content || (m.streaming ? "…" : "")}
              {m.streaming && <span className="ai-cursor" />}
              {m.tools && m.tools.length > 0 && (
                <div className="ai-tools">
                  {m.tools.map((t, i) => (
                    <div key={i} className={`ai-tool ${t.ok ? "ok" : "fail"}`}>
                      <AppIcon name={t.ok ? "check" : "cross"} size={12} />
                      <span>{t.name}</span>
                      <span className="ai-tool-summary">{t.summary.slice(0, 60)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="ai-meta">{formatRelativeTime(m.createdAt)}</div>
          </div>
        ))}
      </div>
      <div className="ai-input-bar">
        <input
          className="ai-input"
          placeholder={settings.ai.deepseekApiKey ? "问点什么…" : "先到设置填写 API Key"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={busy || !settings.ai.deepseekApiKey}
        />
        <button className="m-btn primary" onClick={send} disabled={busy || !input.trim() || !settings.ai.deepseekApiKey}>
          <AppIcon name="upload" size={16} />
        </button>
      </div>

      {approval && (
        <div className="ai-approval-mask" onClick={() => {}}>
          <div className="ai-approval">
            <h3>写文件审批</h3>
            <p className="ai-approval-tool">
              工具：{approval.tool} · 文件：{approval.path}
            </p>
            <pre className="ai-approval-preview">{approval.contentPreview}</pre>
            <div className="ai-approval-actions">
              <button
                className="m-btn"
                onClick={() => {
                  approval.resolve(false)
                  setApproval(null)
                }}
              >
                拒绝
              </button>
              <button
                className="m-btn primary"
                onClick={() => {
                  approval.resolve(true)
                  setApproval(null)
                }}
              >
                批准写入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
