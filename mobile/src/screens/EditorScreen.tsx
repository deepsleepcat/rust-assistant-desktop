/**
 * 编辑器屏幕（全屏）。
 *
 * 两种形态：
 * - 未打开文件：项目文件树（新建/重命名/删除、图片预览、模组信息入口）；
 * - 已打开文件：CodeMirror 编辑 + 保存（中文显示层精确回译）。
 *
 * 数据保护（详见 features/editor/editSession.ts）：
 * - 保存按会话快照写盘，保存期间继续输入不会被误标成已保存；
 * - 返回/退出前若有未保存修改，先让用户选「保存并继续 / 放弃修改 / 取消」；
 * - 磁盘被外部改动（其它 App、AI 工具）时先提示，用户选「重新载入」或「仍然覆盖」；
 * - Android 系统返回键接入同一套退出处理。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../stores/workspace'
import { getBridge } from '../services/bridge'
import { AppIcon } from '../components/AppIcon'
import { ConfirmModal } from '../components/MobileDialog'
import { EditorMirror, type EditorCommandApi } from '../features/editor/EditorMirror'
import { EditorToolbar } from '../features/editor/EditorToolbar'
import { AssetPreview } from '../features/editor/AssetPreview'
import { FileTreePanel } from '../features/editor/FileTreePanel'
import { loadTranslationDict, openFileInEditor } from '../features/editor/openFile'
import { applyReload, checkExternalChange, isDirty, prepareSave } from '../features/editor/editSession'
import { invalidateResourceCache } from '../features/editor/completion'
import { scanSections } from '../features/editor/outline'
import { isRustConfigFile } from '../utils/paths'

interface ModInfo {
  title: string
  description?: string
  author?: string
  version?: string
  minVersion?: string
  updateUrl?: string
}

/**
 * mod-info.txt 结构化编辑表单。
 * 写入走 bridge 的保留写回：只改这里动过的键，注释与未知键不动。
 */
function ModInfoModal({ rootPath, onClose, onSaved }: { rootPath: string; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<ModInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void getBridge()
      .mod.readModInfo(rootPath)
      .then((info) =>
        setData({
          title: info?.title ?? '',
          description: info?.description,
          author: info?.author,
          version: info?.version,
          minVersion: info?.minVersion,
          updateUrl: info?.updateUrl,
        }),
      )
  }, [rootPath])

  async function save() {
    if (!data) return
    setSaving(true)
    setError('')
    try {
      await getBridge().mod.writeModInfo(rootPath, {
        title: data.title,
        description: data.description,
        author: data.author,
        version: data.version,
        minVersion: data.minVersion,
        // 手机端表单不编辑音乐/地图字段：传空数组不会改动原文件里的同名键
        musicFiles: [],
        musicExclusive: false,
        mapsFiles: [],
        mapsExtra: false,
        updateUrl: data.updateUrl,
      })
      invalidateResourceCache()
      onSaved()
      onClose()
    } catch (err) {
      setError(typeof err === 'string' ? err : err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!data) return null
  const field = (key: keyof ModInfo, label: string, placeholder = '') => (
    <div className="m-field">
      <label>{label}</label>
      <input
        type="text"
        value={data[key] ?? ''}
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
        {field('title', '模组标题', '我的模组')}
        {field('description', '描述')}
        {field('author', '作者')}
        {field('version', '版本', '1.0')}
        {field('minVersion', '最低游戏版本', '1.15')}
        {field('updateUrl', '更新地址（可选）')}
        {error && <p className="m-empty" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div style={{ padding: 16 }}>
          <button className="m-btn primary block" onClick={save} disabled={saving}>
            <AppIcon name="save" size={16} />
            {saving ? '保存中…' : '保存'}
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
    <div className="m-modal-mask" onClick={onClose}>
      <div className="m-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="m-modal-title">节大纲 · {path.split('/').pop()}</h3>
        <div className="outline-list">
          {sections.length === 0 && <p className="m-empty">（无节）</p>}
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
              <span className="outline-line">第 {s.line} 行</span>
            </button>
          ))}
        </div>
        <div className="m-modal-actions">
          <button className="m-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/** 待执行的退出动作 */
type PendingExit = { kind: 'close' } | { kind: 'open'; path: string; name: string }

export function EditorScreen() {
  const activeProject = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const session = useWorkspace((s) => s.editorSession)
  const jump = useWorkspace((s) => s.editorJump)
  const settings = useWorkspace((s) => s.settings)
  const updateEditorContent = useWorkspace((s) => s.updateEditorContent)
  const applyEditorSaved = useWorkspace((s) => s.applyEditorSaved)
  const replaceEditorSession = useWorkspace((s) => s.replaceEditorSession)
  const clearEditorJump = useWorkspace((s) => s.clearEditorJump)
  const requestEditorJump = useWorkspace((s) => s.requestEditorJump)
  const closeEditor = useWorkspace((s) => s.closeEditor)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)

  const [asset, setAsset] = useState<{ path: string; name: string } | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [showModInfo, setShowModInfo] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [pendingExit, setPendingExit] = useState<PendingExit | null>(null)
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 })
  /** 编辑器命令句柄（工具栏按钮用） */
  const [editorApi, setEditorApi] = useState<EditorCommandApi | null>(null)
  /** 保存防重入（Ctrl+S 与弹层按钮都能绕过 saving state） */
  const savingRef = useRef(false)

  /**
   * 编辑器内容变化：同步进会话，并清掉「已保存」提示——
   * 一旦内容又变了，上一次保存的结果就不再代表当前状态，
   * 否则标题栏会同时出现「●」和「已保存」，正是要防的误判。
   */
  const handleContentChange = useCallback(
    (next: string) => {
      updateEditorContent(next)
      setStatus((prev) => (prev ? '' : prev))
    },
    [updateEditorContent],
  )

  const dirty = isDirty(session)

  /** 打开文本文件（统一入口：读盘 → 建会话 → 写入 store） */
  const doOpenText = useCallback(async (path: string, name: string) => {
    setError('')
    const result = await openFileInEditor({ path, name })
    if (!result.ok) setError(result.error)
  }, [])

  /**
   * 保存当前会话。
   * force=true 表示用户已在冲突提示里确认「仍然覆盖」。
   *
   * 防重入用 ref 而不是 `saving` state：保存按钮有 disabled，但 Ctrl+S 快捷键
   * 与未保存弹层的「保存并继续」都能绕过 state 判定。两次并发保存会各自 stat 到
   * 不同 mtime，先发起的后落地时会把基准改回旧值，导致下次保存误报「外部修改」。
   */
  const saveSession = useCallback(
    async (force = false): Promise<boolean> => {
      const current = useWorkspace.getState().editorSession
      if (!current || savingRef.current) return false
      savingRef.current = true
      setSaving(true)
      setStatus('')
      setError('')
      try {
        if (!force) {
          const info = await getBridge().project.stat(current.rootPath, current.path).catch(() => null)
          if (info && checkExternalChange(current, info.mtimeMs) === 'external-changed') {
            setConflict(true)
            return false
          }
        }
        const dict = await loadTranslationDict(current.displayMode === 'zh')
        const pending = prepareSave(current, dict)
        const bridge = getBridge()
        await bridge.project.writeFile(current.rootPath, current.path, pending.english, { hasBom: current.hasBom })
        // 写盘后推进修改时间基准，避免下次保存把自己的写入当成外部修改
        const after = await bridge.project.stat(current.rootPath, current.path).catch(() => null)
        applyEditorSaved({ path: current.path, ...pending, mtimeMs: after?.mtimeMs })
        invalidateResourceCache()
        // 保存期间用户可能又敲了字：那时内容仍比磁盘新，提示要如实说明
        setStatus(isDirty(useWorkspace.getState().editorSession) ? '已保存（其后又有修改）' : '已保存')
        setRefreshToken((t) => t + 1)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存失败')
        setStatus('')
        return false
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [applyEditorSaved],
  )

  /** 外部修改后「重新载入」：丢弃本地修改，按当前显示模式重建会话 */
  const reloadSession = useCallback(async () => {
    const current = useWorkspace.getState().editorSession
    if (!current) return
    try {
      const { content, hasBom, mtimeMs } = await getBridge().project.readFile(current.rootPath, current.path)
      const chineseMode = current.displayMode === 'zh'
      const dict = await loadTranslationDict(chineseMode)
      replaceEditorSession(applyReload(current, { raw: content, hasBom, mtimeMs, chineseMode, dict }))
      setConflict(false)
      setStatus('已重新载入')
      setError('')
      setRefreshToken((t) => t + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新载入失败')
      setConflict(false)
    }
  }, [replaceEditorSession])

  /** 执行挂起的退出动作 */
  const performExit = useCallback(
    async (pending: PendingExit) => {
      setPendingExit(null)
      if (pending.kind === 'open') await doOpenText(pending.path, pending.name)
      else closeEditor()
    },
    [closeEditor, doOpenText],
  )

  useEffect(() => {
    setStatus('')
    setError('')
    setCursor({ line: 1, col: 1 })
  }, [session?.path])

  // Android 系统返回键：WebView 会把返回键变成 history.back()，这里压一层历史并接管。
  // 有未保存修改时走「保存并继续 / 放弃修改 / 取消」，否则直接退出编辑器。
  const requestCloseRef = useRef<() => void>(() => {})
  const pushedRef = useRef(false)
  useEffect(() => {
    if (!session) return
    history.pushState({ omytxEditor: true }, '')
    pushedRef.current = true
    const onPop = () => {
      // 立刻补回一层，保证连续按返回仍由我们接管
      history.pushState({ omytxEditor: true }, '')
      requestCloseRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [Boolean(session)])

  // 退出编辑器后清掉自己压入的历史层，避免影响项目页的返回行为
  useEffect(() => {
    if (session) return
    if (!pushedRef.current) return
    pushedRef.current = false
    history.back()
  }, [Boolean(session)])

  const requestClose = useCallback(() => {
    const current = useWorkspace.getState().editorSession
    if (current && isDirty(current)) {
      setPendingExit({ kind: 'close' })
      return
    }
    closeEditor()
  }, [closeEditor])
  requestCloseRef.current = requestClose

  /** 文件树点开文本文件（有未保存修改时先确认） */
  const handleOpenText = useCallback(
    (path: string, name: string) => {
      const current = useWorkspace.getState().editorSession
      if (current && current.path !== path && isDirty(current)) {
        setPendingExit({ kind: 'open', path, name })
        return
      }
      void doOpenText(path, name)
    },
    [doOpenText],
  )

  // —— 未打开文件：文件树 + 资源预览 ——
  if (!session) {
    if (asset) {
      return <AssetPreview projectRoot={activeProject?.rootPath ?? ''} path={asset.path} name={asset.name} onClose={() => setAsset(null)} />
    }
    return (
      <div className="m-screen">
        <header className="m-screen-header">
          <button className="m-btn" onClick={() => setActiveTab('projects')} aria-label="返回项目列表">
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
          {error && <p className="m-empty" style={{ color: 'var(--danger)' }}>{error}</p>}
          {activeProject ? (
            <FileTreePanel
              key={activeProject.id}
              projectRoot={activeProject.rootPath}
              showHidden={settings.showHiddenFiles}
              refreshToken={refreshToken}
              onOpenText={handleOpenText}
              onOpenAsset={(path, name) => setAsset({ path, name })}
              onMutated={() => {
                invalidateResourceCache()
                setRefreshToken((t) => t + 1)
              }}
            />
          ) : (
            <div className="m-empty">
              <AppIcon name="folder" size={36} />
              <p>先选择一个项目</p>
            </div>
          )}
        </div>
        {showModInfo && activeProject && (
          <ModInfoModal
            rootPath={activeProject.rootPath}
            onClose={() => setShowModInfo(false)}
            onSaved={() => setRefreshToken((t) => t + 1)}
          />
        )}
      </div>
    )
  }

  // —— 已打开文件：全屏编辑器 ——
  return (
    <div className="m-editor">
      <header className="m-editor-header">
        <button className="m-editor-btn" onClick={requestClose} aria-label="返回">
          <AppIcon name="close" size={18} />
        </button>
        <div className="m-editor-title">
          <span className="m-editor-filename">{session.name}</span>
          {dirty && <span className="m-editor-dirty" aria-label="有未保存的修改">●</span>}
          {status && <span className="m-editor-status">{status}</span>}
        </div>
        <button className="m-editor-btn" onClick={() => setShowOutline(true)} aria-label="大纲">
          <AppIcon name="menu" size={18} />
        </button>
        <button
          className={`m-editor-btn save${dirty ? ' dirty' : ''}`}
          onClick={() => void saveSession()}
          disabled={saving}
          aria-label="保存"
        >
          <AppIcon name="save" size={18} />
        </button>
      </header>

      {error && (
        <div className="m-editor-error">
          <AppIcon name="warn" size={15} />
          <span>{error}</span>
          <button className="m-btn" onClick={() => setError('')}>
            知道了
          </button>
        </div>
      )}

      <EditorMirror
        value={session.content}
        onChange={handleContentChange}
        onCursor={(line, col) => setCursor({ line, col })}
        onSave={() => {
          // 弹层开着时 Ctrl+S 不应绕过审批直接写盘（否则会出现两层弹层叠加）
          if (conflict || pendingExit) return
          void saveSession()
        }}
        fontFamily={settings.fontFamily}
        fontSize={settings.fontSize}
        chineseMode={session.displayMode === 'zh'}
        translationMap={session.translationTrack}
        jumpTo={jump}
        onJumpDone={() => clearEditorJump()}
        rootPath={session.rootPath}
        semanticCheckers={settings.semanticCheckers}
        targetVersionName={settings.targetGameVersion}
        fileName={session.name}
        onReady={setEditorApi}
      />

      <EditorToolbar api={editorApi} />

      <div className="m-editor-statusbar">
        <span>
          第 {cursor.line} 行，第 {cursor.col} 列
        </span>
        <span>{session.displayMode === 'zh' && isRustConfigFile(session.name) ? '中文显示（保存自动回译）' : '原文模式'}</span>
      </div>

      {showOutline && (
        <OutlineModal
          path={session.path}
          content={session.content}
          onJump={(line) => requestEditorJump(line)}
          onClose={() => setShowOutline(false)}
        />
      )}

      {conflict && (
        <ConfirmModal
          title="文件已被外部修改"
          message="磁盘上的内容与打开时不一致（可能是其它应用或 AI 工具改写）。直接保存会覆盖这些改动。"
          confirmText="仍然覆盖"
          danger
          extraText="重新载入"
          onConfirm={() => {
            setConflict(false)
            void saveSession(true)
          }}
          onExtra={() => void reloadSession()}
          onCancel={() => setConflict(false)}
        />
      )}

      {pendingExit && (
        <ConfirmModal
          title="还有未保存的修改"
          message={`「${session.name}」的改动尚未写入磁盘。`}
          confirmText="放弃修改"
          danger
          extraText={saving ? '保存中…' : '保存并继续'}
          onConfirm={() => void performExit(pendingExit)}
          onExtra={() => {
            void (async () => {
              const ok = await saveSession()
              if (ok) await performExit(pendingExit)
            })()
          }}
          onCancel={() => setPendingExit(null)}
        />
      )}
    </div>
  )
}
