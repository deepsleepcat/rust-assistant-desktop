/**
 * 编辑器屏幕（全屏）：项目文件树 → 打开文件 → CodeMirror 编辑 → 保存。
 * - 中文显示层：打开时 en→zh（记录追踪表），保存时 zh→en 精确回译；
 * - 保存后刷新文件树节点状态；
 * - 顶部：返回、当前文件名、保存按钮（dirty 时高亮）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../stores/workspace'
import { getBridge } from '../services/bridge'
import { AppIcon } from '../components/AppIcon'
import { EditorMirror } from '../features/editor/EditorMirror'
import { enToZh, zhToEn, makeDict } from '../services/translation'
import { getEnToZhDict, getZhToEnDict, loadCodeData } from '../services/codeData'
import { extname, isRustConfigFile, isPreviewableImage } from '../utils/paths'
import { invalidateResourceCache } from '../features/editor/completion'
import { scanSections } from '../features/editor/outline'

interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
  loading?: boolean
}

/** 文件树组件（懒加载目录） */
function FileTree({ rootPath, depth = 0 }: { rootPath: string; depth?: number }) {
  const [nodes, setNodes] = useState<FileNode[] | null>(null)
  const [error, setError] = useState('')
  const openEditor = useWorkspace((s) => s.openEditorFile)
  const settings = useWorkspace((s) => s.settings)

  const load = useCallback(async () => {
    try {
      const entries = await getBridge().project.readDir(rootPath, rootPath, settings.showHiddenFiles)
      const dirs = entries.filter((e) => e.isDirectory).map((e) => ({ name: e.name, path: e.path, isDirectory: true }))
      const files = entries
        .filter((e) => !e.isDirectory)
        .filter((e) => isRustConfigFile(e.name) || isPreviewableImage(e.name))
        .map((e) => ({ name: e.name, path: e.path, isDirectory: false }))
      setNodes([...dirs, ...files])
    } catch (err) {
      setError(err instanceof Error ? err.message : '目录读取失败')
    }
  }, [rootPath, settings.showHiddenFiles])

  useEffect(() => {
    setNodes(null)
    void load()
  }, [load])

  async function openFile(node: FileNode) {
    try {
      const bridge = getBridge()
      const { content: raw, hasBom } = await bridge.project.readFile(rootPath, node.path)
      await loadCodeData()
      // 中文显示层：en → zh（记录追踪表供保存回译）
      let display = raw
      let original = raw
      if (settings.translateMode && isRustConfigFile(node.name)) {
        const tracker = new Map<string, string>()
        display = enToZh(raw, makeDict(getEnToZhDict(), getZhToEnDict()), tracker)
        original = raw
        // 显示内容 + 追踪表需要跨组件传递：编码进 content（原始内容另行保存）
        // 追踪表存到模块级，保存时取用
        pendingTracker = tracker
      }
      openEditor(node.path, node.name, display, original, hasBom)
    } catch (err) {
      console.warn('[editor] 打开文件失败', err)
    }
  }

  async function toggleDir(node: FileNode) {
    setNodes((prev) => prev?.map((n) => (n.path === node.path ? { ...n, loading: !n.children } : n)) ?? null)
    if (node.children) {
      setNodes((prev) => prev?.map((n) => (n.path === node.path ? { ...n, children: undefined, loading: false } : n)) ?? null)
      return
    }
    try {
      const entries = await getBridge().project.readDir(rootPath, node.path, settings.showHiddenFiles)
      const children: FileNode[] = [
        ...entries.filter((e) => e.isDirectory).map((e) => ({ name: e.name, path: e.path, isDirectory: true })),
        ...entries.filter((e) => !e.isDirectory && (isRustConfigFile(e.name) || isPreviewableImage(e.name))).map((e) => ({ name: e.name, path: e.path, isDirectory: false })),
      ]
      setNodes((prev) => prev?.map((n) => (n.path === node.path ? { ...n, children, loading: false } : n)) ?? null)
    } catch (err) {
      console.warn('[editor] 目录展开失败', err)
      setNodes((prev) => prev?.map((n) => (n.path === node.path ? { ...n, loading: false } : n)) ?? null)
    }
  }

  if (error) return <p className="m-empty">{error}</p>
  if (!nodes) return <p className="m-empty">加载中…</p>
  if (nodes.length === 0 && depth === 0) return <p className="m-empty">项目为空，导入模组后编辑</p>

  return (
    <div className="file-tree">
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            className={`file-node${depth === 0 ? ' root' : ''}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => (node.isDirectory ? void toggleDir(node) : void openFile(node))}
          >
            <AppIcon name={node.isDirectory ? 'folder' : extname(node.name) === '.ini' || extname(node.name) === '.txt' ? 'document' : 'image'} size={15} />
            <span className="file-name">{node.name}</span>
            {node.isDirectory && node.loading && <span className="file-spin" />}
          </button>
          {node.children && <FileTree rootPath={node.path} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

/** 中文显示层追踪表（保存回译用；模块级，单编辑器实例） */
let pendingTracker: Map<string, string> | null = null

interface ModInfo {
  title: string
  description?: string
  author?: string
  version?: string
  minVersion?: string
  updateUrl?: string
}

/** mod-info.txt 结构化编辑表单 */
function ModInfoModal({ rootPath, onClose }: { rootPath: string; onClose: () => void }) {
  const [data, setData] = useState<ModInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    void getBridge()
      .mod.readModInfo(rootPath)
      .then((info) => setData({ title: info?.title ?? '', description: info?.description, author: info?.author, version: info?.version, minVersion: info?.minVersion, updateUrl: info?.updateUrl }))
  }, [rootPath])

  async function save() {
    if (!data) return
    setSaving(true)
    setError("")
    try {
      await getBridge().mod.writeModInfo(rootPath, {
        title: data.title,
        description: data.description,
        author: data.author,
        version: data.version,
        minVersion: data.minVersion,
        musicFiles: [],
        musicExclusive: false,
        mapsFiles: [],
        mapsExtra: false,
        updateUrl: data.updateUrl,
      })
      onClose()
    } catch (err) {
      setError(typeof err === "string" ? err : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (!data) return null
  const field = (key: keyof ModInfo, label: string, placeholder = "") => (
    <div className="m-field">
      <label>{label}</label>
      <input
        type="text"
        value={data[key] ?? ""}
        placeholder={placeholder}
        onChange={(e) => setData((d) => (d ? { ...d, [key]: e.target.value } : d))}
      />
    </div>
  )

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <button className="m-btn" onClick={onClose} aria-label="返回">
          <AppIcon name="close" size={16} />
        </button>
        <h1 className="m-screen-title">模组信息（mod-info.txt）</h1>
      </header>
      <div className="m-scroll">
        {field("title", "模组标题", "我的模组")}
        {field("description", "描述")}
        {field("author", "作者")}
        {field("version", "版本", "1.0")}
        {field("minVersion", "最低游戏版本", "1.15")}
        {field("updateUrl", "更新地址（可选）")}
        {error && <p className="m-empty" style={{ color: "var(--danger)" }}>{error}</p>}
        <div style={{ padding: 16 }}>
          <button className="m-btn primary block" onClick={save} disabled={saving}>
            <AppIcon name="save" size={16} />
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 编辑器大纲弹层（节列表 → 跳转） */
function OutlineModal({ path, content, onJump, onClose }: { path: string; content: string; onJump: (line: number) => void; onClose: () => void }) {
  const sections = scanSections(content)
  return (
    <div className="ai-approval-mask" onClick={onClose}>
      <div className="ai-approval" onClick={(e) => e.stopPropagation()}>
        <h3>节大纲 · {path.split("/").pop()}</h3>
        <div style={{ flex: 1, overflow: "auto", marginBottom: 12 }}>
          {sections.length === 0 && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>（无节）</p>}
          {sections.map((s) => (
            <button
              key={s.from}
              className="file-node"
              onClick={() => {
                onJump(s.line)
                onClose()
              }}
            >
              <AppIcon name="box" size={14} />
              <span className="file-name">[{s.name}]</span>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>第 {s.line} 行</span>
            </button>
          ))}
        </div>
        <div className="ai-approval-actions">
          <button className="m-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

export function EditorScreen() {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const editorFile = useWorkspace((s) => s.editorFile)
  const settings = useWorkspace((s) => s.settings)
  const updateEditorContent = useWorkspace((s) => s.updateEditorContent)
  const markSaved = useWorkspace((s) => s.markSaved)
  const closeEditor = useWorkspace((s) => s.closeEditor)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [showModInfo, setShowModInfo] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const [jump, setJump] = useState<{ line: number; seq: number } | null>(null)
  const translationMap = useMemo(() => pendingTracker ?? undefined, [editorFile?.path])

  async function handleSave() {
    if (!editorFile || !activeProject || saving) return
    setSaving(true)
    setStatus('')
    try {
      // 中文显示层：zh → en 精确回译（追踪表还原原文，未追踪中文保留）
      let toWrite = editorFile.content
      if (settings.translateMode && isRustConfigFile(editorFile.name)) {
        toWrite = zhToEn(editorFile.content, makeDict(getEnToZhDict(), getZhToEnDict()), pendingTracker ?? undefined)
      }
      await getBridge().project.writeFile(activeProject.rootPath, editorFile.path, toWrite, { hasBom: editorFile.hasBom })
      markSaved(toWrite)
      pendingTracker = null
      invalidateResourceCache()
      setStatus('已保存')
      setTimeout(() => setStatus(''), 1500)
    } catch (err) {
      setStatus(err instanceof Error ? `保存失败：${err.message}` : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // 未打开文件：文件树视图
  if (!editorFile) {
    return (
      <div className="m-screen">
        <header className="m-screen-header">
          <button className="m-btn" onClick={() => setActiveTab('projects')} aria-label="返回">
            <AppIcon name="close" size={16} />
          </button>
          <h1 className="m-screen-title">{activeProject?.name ?? '编辑器'}</h1>
          {activeProject && (
            <button className="m-btn" onClick={() => setShowModInfo(true)}>
              <AppIcon name="document" size={16} />
              模组信息
            </button>
          )}
        </header>
        <div className="m-scroll">
          {activeProject && <FileTree rootPath={activeProject.rootPath} />}
          {!activeProject && (
            <div className="m-empty">
              <AppIcon name="folder" size={36} />
              <p>先选择一个项目</p>
            </div>
          )}
        </div>
        {showModInfo && activeProject && <ModInfoModal rootPath={activeProject.rootPath} onClose={() => setShowModInfo(false)} />}
      </div>
    )
  }

  // 全屏编辑器
  return (
    <div className="m-editor">
      <header className="m-editor-header">
        <button className="m-editor-btn" onClick={closeEditor} aria-label="返回">
          <AppIcon name="close" size={18} />
        </button>
        <div className="m-editor-title">
          <span>{editorFile.name}</span>
          {editorFile.dirty && <span className="m-editor-dirty">●</span>}
          {status && <span className="m-editor-status">{status}</span>}
        </div>
        <button className="m-editor-btn" onClick={() => setShowOutline(true)} aria-label="大纲">
          <AppIcon name="menu" size={18} />
        </button>
        <button className={`m-editor-btn save${editorFile.dirty ? ' dirty' : ''}`} onClick={handleSave} disabled={saving} aria-label="保存">
          <AppIcon name="save" size={18} />
        </button>
      </header>
      <EditorMirror
        value={editorFile.content}
        onChange={updateEditorContent}
        onCursor={() => {}}
        onSave={() => void handleSave()}
        fontFamily={settings.fontFamily}
        fontSize={settings.fontSize}
        chineseMode={settings.translateMode && isRustConfigFile(editorFile.name)}
        translationMap={translationMap}
        jumpTo={jump ? { line: jump.line, seq: jump.seq } : null}
        onJumpDone={() => setJump(null)}
        rootPath={activeProject?.rootPath}
        semanticCheckers={settings.semanticCheckers}
        targetVersionName={settings.targetGameVersion}
        fileName={editorFile.name}
      />
      {showOutline && (
        <OutlineModal
          path={editorFile.path}
          content={editorFile.content}
          onJump={(line) => setJump((j) => ({ line, seq: (j?.seq ?? 0) + 1 }))}
          onClose={() => setShowOutline(false)}
        />
      )}
    </div>
  )
}
