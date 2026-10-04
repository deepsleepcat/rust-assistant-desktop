/**
 * 检查页：对当前项目运行语义检查（拼写/必填/引用/数值），
 * 结果列表 = 文件 + 行号 + 原因 + 修复建议，点击可跳转到编辑器打开该文件。
 */
import { useEffect, useRef, useState } from "react"
import { useWorkspace } from "../stores/workspace"
import { getBridge } from "../services/bridge"
import { runSemanticChecks } from "../features/editor/semanticChecks"
import { lintIniText } from "../features/editor/rustLint"
import { findCodeByCode, findValueType, getKeyZhToEnDict, getZhToEnDict, getAllCodes, loadCodeData } from "../services/codeData"
import { enabledRuleIds } from "../features/editor/semanticChecks/registry"
import { openFileInEditor } from "../features/editor/openFile"
import { AppIcon } from "../components/AppIcon"
import { isRustConfigFile } from "../utils/paths"

interface CheckItem {
  file: string
  line: number
  severity: "error" | "warning" | "info"
  message: string
  suggestion: string
}

export function InspectScreen() {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const settings = useWorkspace((s) => s.settings)
  const [items, setItems] = useState<CheckItem[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState("")
  /**
   * 请求版本号：检查要遍历整个项目（可能几秒），期间用户可能切换项目或再次点「重查」。
   * 没有这个守卫时，先发起的旧请求可能后返回，把 A 项目的结果显示在 B 项目的页面上
   * ——用户点进去就会用 B 的根路径打开 A 的相对路径，改到错文件上。
   */
  const runTokenRef = useRef(0)

  async function run() {
    if (!activeProject) return
    const token = (runTokenRef.current += 1)
    setRunning(true)
    setError("")
    setItems(null)
    try {
      await loadCodeData()
      const bridge = getBridge()
      const root = activeProject.rootPath
      // 收集项目内配置文件（相对路径）
      const files: string[] = []
      const stack = [""]
      const seen = new Set<string>()
      while (stack.length > 0) {
        const rel = stack.pop()!
        const entries = await bridge.project.readDir(root, rel ? `${root}/${rel}` : root, settings.showHiddenFiles)
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory) {
            if (childRel.startsWith("rules") || childRel.startsWith(".")) continue
            stack.push(childRel)
          } else if (isRustConfigFile(e.name) && !seen.has(childRel)) {
            seen.add(childRel)
            files.push(childRel)
          }
        }
      }
      // 扫描单位名（引用检查）
      const { unitNames } = await bridge.mod.scanResources(root).catch(() => ({ files: [], unitNames: [] }))
      const zhToEnDict = getZhToEnDict()
      const keyZhToEnDict = getKeyZhToEnDict()
      const lintData = {
        findCode: (k: string) => findCodeByCode(k),
        findType: (t: string) => findValueType(t),
        zhToEn: (k: string) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
      }
      const ruleIds = enabledRuleIds(settings.semanticCheckers)
      const out: CheckItem[] = []
      for (const rel of files) {
        const { content } = await bridge.project.readFile(root, `${root}/${rel}`)
        // 基础 lint（值合法性）+ 语义检查器
        const base = lintIniText(content, lintData)
        for (const d of base) {
          out.push({ file: rel, line: 0, severity: d.severity, message: d.message, suggestion: "" })
        }
        const issues = runSemanticChecks(content, {
          ruleIds,
          ctx: {
            ...lintData,
            codes: getAllCodes().map((c) => c.code),
            unitNames: new Set(unitNames),
            file: rel,
          },
        })
        for (const it of issues) {
          out.push({ file: rel, line: it.line, severity: it.severity, message: it.message, suggestion: it.suggestion })
        }
      }
      // 排序：error 优先，然后按文件/行号
      out.sort((a, b) => {
        const sev = { error: 0, warning: 1, info: 2 }
        if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
        return a.file.localeCompare(b.file) || a.line - b.line
      })
      // 过期请求（切换项目 / 又点了重查）：结果直接丢弃，不能落到界面上
      if (runTokenRef.current !== token) return
      setItems(out)
    } catch (err) {
      if (runTokenRef.current !== token) return
      setError(err instanceof Error ? err.message : "检查失败")
    } finally {
      if (runTokenRef.current === token) setRunning(false)
    }
  }

  useEffect(() => {
    setItems(null)
    if (activeProject) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  /** 点击条目 → 打开文件并定位到行（走统一打开入口，行号交给编辑器消费） */
  async function openFile(item: CheckItem) {
    if (!activeProject) return
    const result = await openFileInEditor({
      path: `${activeProject.rootPath}/${item.file}`,
      name: item.file.split("/").pop() ?? item.file,
      // line=0 表示「整档级」问题（基础 lint），不跳转
      line: item.line > 0 ? item.line : undefined,
    })
    if (!result.ok) setError(result.error)
  }

  const count = items ? { error: items.filter((i) => i.severity === "error").length, warning: items.filter((i) => i.severity === "warning").length } : null

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <h1 className="m-screen-title">检查</h1>
        {count && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {count.error > 0 && <span style={{ color: "var(--danger)" }}>{count.error} 错误</span>}
            {count.error > 0 && count.warning > 0 && " · "}
            {count.warning > 0 && <span style={{ color: "var(--warning)" }}>{count.warning} 警告</span>}
          </span>
        )}
        <button className="m-btn" onClick={run} disabled={running}>
          <AppIcon name="refresh" size={16} />
          {running ? "检查中…" : "重查"}
        </button>
      </header>
      <div className="m-scroll">
        {error && <p className="m-empty">{error}</p>}
        {!activeProject && (
          <div className="m-empty">
            <AppIcon name="check" size={36} />
            <p>先选择一个项目，再运行语义检查</p>
          </div>
        )}
        {activeProject && !items && !error && (
          <div className="m-empty">
            <AppIcon name="check" size={36} />
            <p>{running ? "检查中…" : "正在扫描项目…"}</p>
          </div>
        )}
        {items && items.length === 0 && (
          <div className="m-empty">
            <AppIcon name="check" size={36} />
            <p>没有发现问题，模组很干净 🎉</p>
          </div>
        )}
        {items && items.length > 0 && (
          <div>
            {items.map((item, idx) => (
              <button
                key={idx}
                className="inspect-item"
                style={{ width: "100%", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}
                onClick={() => void openFile(item)}
              >
                <span className={`severity ${item.severity}`} />
                <div className="body">
                  <p className="msg">{item.message}</p>
                  <p className="meta">
                    {item.file}
                    {item.line > 0 ? `:${item.line}` : ""}
                    {item.suggestion ? ` · ${item.suggestion}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
