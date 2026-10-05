/**
 * 模板库页：内置官方单位模板浏览 + 新建单位向导。
 * 选模板 → 填名称/参数（模板声明的 action 字段）→ 创建到当前项目 → 打开编辑器。
 */
import { useEffect, useState } from "react"
import { useWorkspace } from "../stores/workspace"
import { getBridge } from "../services/bridge"
import type { TemplateMeta } from "../types/mod"
import { AppIcon } from "../components/AppIcon"
import { invalidateResourceCache } from "../features/editor/completion"

function UnitWizard({ template, onDone }: { template: TemplateMeta; onDone: () => void }) {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const [name, setName] = useState("")
  const [values, setValues] = useState<Record<string, string>>({ ...template.defaults })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function create() {
    if (!activeProject) {
      setError("请先在「项目」页导入或创建一个项目")
      return
    }
    const safeName = name.trim()
    if (!safeName) {
      setError("请填写单位名称（英文唯一标识，如 myTank）")
      return
    }
    setBusy(true)
    setError("")
    try {
      await getBridge().mod.createUnitFromTemplate(activeProject.rootPath, {
        name: safeName,
        templateKey: template.key,
        values,
      })
      invalidateResourceCache()
      setActiveTab("editor")
      onDone()
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "创建失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <button className="m-btn" onClick={onDone} aria-label="返回">
          <AppIcon name="close" size={16} />
        </button>
        <h1 className="m-screen-title">新建单位 · {template.name}</h1>
      </header>
      <div className="m-scroll">
        <div className="m-field">
          <label>单位名称（英文唯一标识，小驼峰）</label>
          <input
            type="text"
            placeholder="如 myTank"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {template.actions.map((a) => (
          <div className="m-field" key={a.tag}>
            <label>{a.label}</label>
            <input
              type="text"
              value={values[a.tag] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [a.tag]: e.target.value }))}
            />
          </div>
        ))}
        {error && <p className="m-empty" style={{ color: "var(--danger)" }}>{error}</p>}
        <div style={{ padding: 16 }}>
          <button className="m-btn primary block" onClick={create} disabled={busy}>
            <AppIcon name="check" size={16} />
            {busy ? "创建中…" : "创建单位"}
          </button>
        </div>
      </div>
    </div>
  )
}

export function LibraryScreen() {
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(null)
  const [error, setError] = useState("")
  const [active, setActive] = useState<TemplateMeta | null>(null)

  useEffect(() => {
    let alive = true
    getBridge()
      .mod.listTemplates()
      .then((list) => alive && setTemplates(list))
      .catch((err) => alive && setError(typeof err === "string" ? err : "模板加载失败"))
    return () => {
      alive = false
    }
  }, [])

  if (active) return <UnitWizard template={active} onDone={() => setActive(null)} />

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <h1 className="m-screen-title">模板库</h1>
      </header>
      <div className="m-scroll">
        {error && <p className="m-empty">{error}</p>}
        {templates === null && !error && (
          <div className="m-empty">
            <AppIcon name="tower" size={36} />
            <p>模板加载中…</p>
          </div>
        )}
        <div className="m-list">
          {(templates ?? []).map((t) => (
            <div key={t.key} className="m-card" onClick={() => setActive(t)}>
              <div className="m-card-icon">
                <AppIcon name="tower" size={20} />
              </div>
              <div className="m-card-body">
                <p className="m-card-title">{t.name}</p>
                <p className="m-card-sub">
                  {t.nameEn} · {t.actions.length} 个可调参数
                </p>
              </div>
              <span className="m-card-arrow">›</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
