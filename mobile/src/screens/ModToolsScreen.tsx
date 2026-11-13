/**
 * 模组工具页：优化扫描（空文件/空文件夹/备份/末尾空行/注释）+
 * 全局操作（批量替换 / 头部附加 / 尾部附加）。
 * 两个子页面通过 state 切换，共享同一页顶栏。
 */
import { useMemo, useState } from "react"
import { useWorkspace } from "../stores/workspace"
import { getBridge } from "../services/bridge"
import { AppIcon } from "../components/AppIcon"
import { ConfirmModal } from "../components/MobileDialog"

type View = "home" | "optimize" | "globalOp"

interface OptItem {
  id: string
  kind: "emptyFile" | "emptyFolder" | "backupFile" | "emptyLine" | "comment"
  rel: string
  detail?: string
}

const KIND_LABEL: Record<OptItem["kind"], { label: string; desc: string; icon: import("../components/AppIcon").AppIconName }> = {
  emptyFile: { label: "空文件", desc: "0 字节，可安全删除", icon: "file" },
  emptyFolder: { label: "空文件夹", desc: "目录下无有效文件", icon: "folder" },
  backupFile: { label: "备份文件", desc: ".bak/.old/.tmp/~ 结尾", icon: "archive" },
  emptyLine: { label: "末尾空行", desc: ".ini 文件末尾多余空行", icon: "document" },
  comment: { label: "注释行", desc: "# 开头的注释行", icon: "text" },
}

export function ModToolsScreen() {
  const [view, setView] = useState<View>("home")

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        {view !== "home" && (
          <button className="m-btn" onClick={() => setView("home")} aria-label="返回">
            <AppIcon name="close" size={16} />
          </button>
        )}
        <h1 className="m-screen-title">{view === "home" ? "模组工具" : view === "optimize" ? "优化" : "全局操作"}</h1>
      </header>
      <div className="m-scroll">
        {view === "home" && <HomeView onPick={setView} />}
        {view === "optimize" && <OptimizeView />}
        {view === "globalOp" && <GlobalOpView />}
      </div>
    </div>
  )
}

function HomeView({ onPick }: { onPick: (v: View) => void }) {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)

  if (!activeProject) {
    return (
      <div className="m-empty">
        <AppIcon name="tools" size={36} />
        <p>先选择一个项目，再使用模组工具</p>
      </div>
    )
  }

  const items = [
    { key: "optimize" as View, icon: "sparkle" as const, title: "优化", sub: "扫描项目内空文件/空文件夹/备份/空行/注释行，一键清理" },
    { key: "globalOp" as View, icon: "bolt" as const, title: "全局操作", sub: "对全部 .ini / .template 文件批量替换文本、头部或尾部附加内容" },
  ]

  return (
    <div className="m-list" style={{ padding: 12 }}>
      <p className="m-group-title">项目：{activeProject.name}</p>
      {items.map((it) => (
        <div key={it.key} className="m-card" onClick={() => onPick(it.key)}>
          <div className="m-card-icon">
            <AppIcon name={it.icon} size={20} />
          </div>
          <div className="m-card-body">
            <p className="m-card-title">{it.title}</p>
            <p className="m-card-sub">{it.sub}</p>
          </div>
          <span className="m-card-arrow">›</span>
        </div>
      ))}
    </div>
  )
}

function OptimizeView() {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [items, setItems] = useState<OptItem[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [error, setError] = useState("")
  const [result, setResult] = useState<{ done: number; failed: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function scan() {
    if (!activeProject) return
    setScanning(true)
    setError("")
    setItems(null)
    setChecked(new Set())
    setResult(null)
    try {
      const list = await getBridge().mod.optimizeScan(activeProject.rootPath)
      setItems(list as OptItem[])
      // 默认全部勾选
      setChecked(new Set(list.map((i) => i.id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : "扫描失败")
    } finally {
      setScanning(false)
    }
  }

  // 自动扫描：进入页面即触发
  useMemo(() => {
    if (activeProject && items === null && !scanning && !error) {
      void scan()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  const grouped = useMemo(() => {
    if (!items) return null
    const map = new Map<OptItem["kind"], OptItem[]>()
    for (const it of items) {
      const arr = map.get(it.kind) ?? []
      arr.push(it)
      map.set(it.kind, arr)
    }
    return map
  }, [items])

  const totalChecked = checked.size

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleKind(kind: OptItem["kind"]) {
    if (!items) return
    const kindIds = items.filter((i) => i.kind === kind).map((i) => i.id)
    const allChecked = kindIds.every((id) => checked.has(id))
    setChecked((prev) => {
      const next = new Set(prev)
      if (allChecked) kindIds.forEach((id) => next.delete(id))
      else kindIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function apply() {
    if (!activeProject || checked.size === 0) return
    setApplying(true)
    setError("")
    setResult(null)
    try {
      const r = await getBridge().mod.optimizeApply(activeProject.rootPath, [...checked])
      setResult(r)
      // 移除已成功处理的项
      if (r.done > 0) {
        setItems((prev) => prev ? prev.filter((i) => !checked.has(i.id)) : prev)
        setChecked(new Set())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "优化失败")
    } finally {
      setApplying(false)
      setConfirming(false)
    }
  }

  if (!activeProject) return null

  return (
    <div style={{ padding: 12 }}>
      {error && <p className="m-empty" style={{ color: "var(--danger)" }}>{error}</p>}
      {scanning && !items && (
        <div className="m-empty">
          <AppIcon name="sparkle" size={36} />
          <p>正在扫描项目…</p>
        </div>
      )}
      {items !== null && items.length === 0 && (
        <div className="m-empty">
          <AppIcon name="check" size={36} />
          <p>没有发现可优化项 ✨</p>
        </div>
      )}

      {result && (
        <p className="m-hint">
          优化完成：{result.done} 项成功
          {result.failed > 0 && <span style={{ color: "var(--danger)" }}> · {result.failed} 项失败</span>}
        </p>
      )}

      {grouped && items && items.length > 0 && (
        <>
          {Array.from(grouped.entries()).map(([kind, list]) => {
            const meta = KIND_LABEL[kind]
            const allChecked = list.every((i) => checked.has(i.id))
            return (
              <div key={kind} style={{ marginBottom: 16 }}>
                <div className="m-card" style={{ padding: "10px 12px", marginBottom: 4 }} onClick={() => toggleKind(kind)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={allChecked} readOnly style={{ pointerEvents: "none" }} />
                    <AppIcon name={meta.icon} size={16} />
                    <span style={{ fontWeight: 500 }}>{meta.label}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: "auto" }}>
                      {list.length} 项
                    </span>
                  </div>
                </div>
                <div style={{ paddingLeft: 8 }}>
                  {list.map((it) => (
                    <label
                      key={it.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(it.id)}
                        onChange={() => toggle(it.id)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {it.rel}
                        </div>
                        {it.detail && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{it.detail}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}

          <div style={{ display: "flex", gap: 8, padding: "12px 0" }}>
            <button className="m-btn" onClick={scan} disabled={scanning || applying}>
              <AppIcon name="refresh" size={16} />
              重新扫描
            </button>
            <button
              className="m-btn primary"
              onClick={() => setConfirming(true)}
              disabled={applying || totalChecked === 0}
              style={{ flex: 1 }}
            >
              <AppIcon name="sparkle" size={16} />
              {applying ? "处理中…" : `优化选中 ${totalChecked} 项`}
            </button>
          </div>
        </>
      )}

      {confirming && (
        <ConfirmModal
          title="确认优化"
          message={`将对项目执行 ${totalChecked} 项优化操作（删除/修改文件）。此操作会直接写入磁盘，建议先备份项目。是否继续？`}
          confirmText={applying ? "处理中…" : "开始优化"}
          cancelText="取消"
          onConfirm={() => void apply()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

function GlobalOpView() {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [kind, setKind] = useState<"replace" | "prepend" | "append">("replace")
  const [find, setFind] = useState("")
  const [text, setText] = useState("")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<{ files: number; changed: number; skipped: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (!activeProject) return null

  const kinds: Array<{ value: typeof kind; label: string; desc: string }> = [
    { value: "replace", label: "替换文本", desc: "把所有匹配的文本替换为指定内容（支持中英文）" },
    { value: "prepend", label: "头部附加", desc: "在每个源文件开头插入一段文本" },
    { value: "append", label: "尾部附加", desc: "在每个源文件末尾追加一段文本" },
  ]

  const currentKind = kinds.find((k) => k.value === kind)!

  async function run() {
    if (!activeProject) return
    setConfirming(false)
    setRunning(true)
    setError("")
    setResult(null)
    try {
      const r = await getBridge().mod.globalOp(activeProject.rootPath, {
        kind,
        find: kind === "replace" ? find : undefined,
        text,
      })
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行失败")
    } finally {
      setRunning(false)
    }
  }

  const canRun = kind === "replace" ? find.trim().length > 0 : text.length > 0

  return (
    <div style={{ padding: 12 }}>
      <p className="m-group-title">操作类型</p>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {kinds.map((k) => (
          <button
            key={k.value}
            type="button"
            className={kind === k.value ? "m-btn primary" : "m-btn"}
            style={{ flex: 1, fontSize: 12, padding: "6px 4px" }}
            onClick={() => { setKind(k.value); setResult(null) }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>{currentKind.desc}</p>

      {kind === "replace" && (
        <div className="m-field">
          <label>查找文本 <em>*</em></label>
          <textarea
            rows={3}
            placeholder="要替换掉的文本"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        </div>
      )}

      <div className="m-field">
        <label>{kind === "replace" ? "替换为" : "文本内容"} {kind !== "replace" && <em>*</em>}</label>
        <textarea
          rows={4}
          placeholder={kind === "replace" ? "替换成的新文本（留空 = 删除匹配项）" : "要附加的文本"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {error && <p className="m-empty" style={{ color: "var(--danger)" }}>{error}</p>}

      {result && (
        <p className="m-hint">
          处理完成：扫描 {result.files} 个文件
          {result.changed > 0 && <span> · 修改 {result.changed}</span>}
          {result.skipped > 0 && <span style={{ color: "var(--text-muted)" }}> · 跳过 {result.skipped}</span>}
        </p>
      )}

      <div style={{ paddingTop: 8 }}>
        <button
          className="m-btn primary block"
          onClick={() => setConfirming(true)}
          disabled={running || !canRun}
        >
          <AppIcon name="bolt" size={16} />
          {running ? "执行中…" : "执行全局操作"}
        </button>
      </div>

      {confirming && (
        <ConfirmModal
          title="确认执行"
          message={`将对「${activeProject.name}」内所有 .ini / .template 文件执行「${currentKind.label}」。此操作会直接写入磁盘，建议先备份项目。是否继续？`}
          confirmText={running ? "执行中…" : "执行"}
          cancelText="取消"
          onConfirm={() => void run()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
