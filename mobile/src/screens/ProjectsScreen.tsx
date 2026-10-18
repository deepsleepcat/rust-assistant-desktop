/**
 * 项目页：项目列表（最近打开排序）+ 新建 / 导入 / 示例项目 / 打包导出 / 删除。
 *
 * 导入拆成「压缩包」与「文件夹」两个显式入口（SAF 选择器限制类型，避免用户在
 * 一个混合选择器里选错）；所有确认与结果提示都用页面内弹层——
 * Android WebView 的 window.confirm/alert 不一定可用。
 */
import { useState } from 'react'
import { useWorkspace } from '../stores/workspace'
import { deleteProject, getBridge, importMod, uniqueProjectDir } from '../services/bridge'
import { AppIcon } from '../components/AppIcon'
import { ConfirmModal, PromptModal } from '../components/MobileDialog'
import { formatRelativeTime } from '../utils/conversation'
import { validateEntryName } from '../utils/entryName'
import { minimalModInfoText } from '../features/modTools/modInfo'
import { createSampleProject } from '../features/modTools/sampleProject'
import { isDirty } from '../features/editor/editSession'
import { invalidateResourceCache } from '../features/editor/completion'
import type { ProjectInfo } from '../types/domain'

type Operation = '' | 'create' | 'import-archive' | 'import-folder' | 'sample' | 'pack' | 'delete'

const OPERATION_LABEL: Record<Exclude<Operation, ''>, string> = {
  create: '正在创建项目…',
  'import-archive': '正在解压导入…',
  'import-folder': '正在复制导入…',
  sample: '正在生成示例项目…',
  pack: '正在打包…',
  delete: '正在删除…',
}

export function ProjectsScreen() {
  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const editorSession = useWorkspace((s) => s.editorSession)
  const setActiveProject = useWorkspace((s) => s.setActiveProject)
  const setActiveTab = useWorkspace((s) => s.setActiveTab)
  const addProject = useWorkspace((s) => s.addProject)
  const removeProject = useWorkspace((s) => s.removeProject)
  const closeEditor = useWorkspace((s) => s.closeEditor)

  const [operation, setOperation] = useState<Operation>('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null)

  const busy = operation !== ''

  /** 登记项目并设为当前项目 */
  function registerProject(rootPath: string, name: string) {
    addProject({ id: rootPath, name, rootPath, createdAt: Date.now(), lastOpenedAt: Date.now() })
    setActiveProject(rootPath)
    invalidateResourceCache()
  }

  async function handleCreate(name: string) {
    setOperation('create')
    setError('')
    setStatus('')
    try {
      const bridge = getBridge()
      const root = await uniqueProjectDir(name)
      await bridge.project.createFolder(root, root, '')
      await bridge.project.writeFile(root, `${root}/mod-info.txt`, minimalModInfoText(name), { hasBom: false })
      const displayName = root.split('/').pop() ?? name
      registerProject(root, displayName)
      setShowCreate(false)
      setActiveTab('editor')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败')
      setShowCreate(false)
    } finally {
      setOperation('')
    }
  }

  async function handleImport(kind: 'archive' | 'folder') {
    setShowImport(false)
    setOperation(kind === 'archive' ? 'import-archive' : 'import-folder')
    setError('')
    setStatus('')
    try {
      // 用户取消返回 null（不是错误）
      const picked = await importMod(kind)
      if (!picked) {
        setStatus('已取消导入')
        return
      }
      registerProject(picked.rootPath, picked.name)
      setStatus(picked.files !== undefined ? `已导入「${picked.name}」（${picked.files} 个文件）` : `已导入「${picked.name}」`)
      setActiveTab('editor')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setOperation('')
    }
  }

  async function handleSample() {
    setOperation('sample')
    setError('')
    setStatus('')
    try {
      const result = await createSampleProject()
      registerProject(result.rootPath, result.name)
      setStatus(`已创建「${result.name}」`)
      setActiveTab('editor')
    } catch (err) {
      setError(err instanceof Error ? err.message : '示例项目创建失败')
    } finally {
      setOperation('')
    }
  }

  async function handlePack(p: ProjectInfo) {
    setOperation('pack')
    setError('')
    setStatus('')
    try {
      const result = await getBridge().mod.pack(p.rootPath)
      if ('canceled' in result && result.canceled) {
        setStatus('已取消导出')
        return
      }
      if ('filePath' in result) {
        setNotice(`打包完成：${result.files} 个文件，${(result.size / 1024).toFixed(1)} KB`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '打包失败')
    } finally {
      setOperation('')
    }
  }

  async function handleDelete() {
    const target = pendingDelete
    if (!target) return
    setOperation('delete')
    setError('')
    setStatus('')
    try {
      try {
        await deleteProject(target.rootPath)
      } catch {
        // 目录可能已被外部清理：不阻塞列表移除
      }
      // 被删项目正是当前编辑会话所在项目 → 关闭编辑器，避免引用已删除文件
      const session = useWorkspace.getState().editorSession
      if (session && session.projectId === target.id) closeEditor()
      removeProject(target.id)
      invalidateResourceCache()
      setStatus(`已删除「${target.name}」`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setPendingDelete(null)
      setOperation('')
    }
  }

  function openProject(id: string) {
    setActiveProject(id)
    setActiveTab('editor')
  }

  /** 删除确认是否需要额外警告未保存修改 */
  const deleteWarning =
    pendingDelete && editorSession && editorSession.projectId === pendingDelete.id && isDirty(editorSession)
      ? '注意：该项目里有未保存的编辑内容，删除后无法恢复。'
      : ''

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <h1 className="m-screen-title">项目</h1>
        <button className="m-btn" onClick={() => setShowCreate(true)} disabled={busy}>
          <AppIcon name="plus" size={16} />
          新建
        </button>
        <button className="m-btn" onClick={() => setShowImport(true)} disabled={busy}>
          <AppIcon name="import" size={16} />
          导入
        </button>
      </header>

      <div className="m-scroll">
        {status && <p className="m-hint">{status}</p>}
        {error && (
          <p className="m-empty" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        {projects.length === 0 ? (
          <div className="m-empty">
            <AppIcon name="folder" size={40} />
            <p>
              还没有项目。
              <br />
              新建一个空白项目，或导入已有的模组文件夹 / .rwmod 压缩包。
            </p>
            <button className="m-btn primary" onClick={() => setShowCreate(true)} disabled={busy}>
              <AppIcon name="plus" size={16} />
              新建项目
            </button>
            <button className="m-btn" onClick={() => setShowImport(true)} disabled={busy}>
              <AppIcon name="import" size={16} />
              导入模组
            </button>
            <button className="m-btn" onClick={handleSample} disabled={busy}>
              <AppIcon name="sparkle" size={16} />
              创建示例项目
            </button>
          </div>
        ) : (
          <div className="m-list">
            {[...projects]
              .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
              .map((p) => (
                <div key={p.id} className="m-card" onClick={() => openProject(p.id)}>
                  <div className="m-card-icon">
                    <AppIcon name="box" size={20} />
                  </div>
                  <div className="m-card-body">
                    <p className="m-card-title">{p.name}</p>
                    <p className="m-card-sub">
                      {formatRelativeTime(p.lastOpenedAt)}
                      {activeProjectId === p.id ? ' · 当前项目' : ''}
                    </p>
                  </div>
                  <button
                    className="m-card-arrow"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handlePack(p)
                    }}
                    disabled={busy}
                    aria-label={`打包导出 ${p.name}`}
                  >
                    <AppIcon name="archive" size={18} />
                  </button>
                  <button
                    className="m-card-arrow"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(p)
                    }}
                    disabled={busy}
                    aria-label={`删除 ${p.name}`}
                  >
                    <AppIcon name="delete" size={18} />
                  </button>
                </div>
              ))}
            <button className="m-btn block" onClick={handleSample} disabled={busy}>
              <AppIcon name="sparkle" size={16} />
              创建示例项目
            </button>
          </div>
        )}
      </div>

      {busy && (
        <div className="m-busy-mask">
          <div className="m-busy">
            <span className="file-spin" />
            {OPERATION_LABEL[operation as Exclude<Operation, ''>]}
          </div>
        </div>
      )}

      {showCreate && (
        <PromptModal
          title="新建项目"
          label="项目名称"
          placeholder="如 我的第一个模组"
          confirmText="创建"
          validate={(value) => validateEntryName(value, projects.map((p) => p.name)).error}
          onConfirm={(value) => void handleCreate(value)}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {showImport && (
        <div className="m-modal-mask" onClick={() => setShowImport(false)}>
          <div className="m-modal sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="m-modal-title">导入模组</h3>
            <button className="m-modal-item" onClick={() => void handleImport('archive')}>
              <AppIcon name="archive" size={16} />
              压缩包（.rwmod / .zip）
            </button>
            <button className="m-modal-item" onClick={() => void handleImport('folder')}>
              <AppIcon name="folder" size={16} />
              文件夹（选择模组目录）
            </button>
            <div className="m-modal-actions">
              <button className="m-btn" onClick={() => setShowImport(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`删除项目「${pendingDelete.name}」？`}
          message={`项目目录及其中的全部文件都会被删除，无法在应用内撤销。${deleteWarning ? `\n${deleteWarning}` : ''}`}
          confirmText={operation === 'delete' ? '删除中…' : '删除'}
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {notice && (
        <ConfirmModal
          title="导出完成"
          message={notice}
          confirmText="知道了"
          cancelText={null}
          onConfirm={() => setNotice('')}
          onCancel={() => setNotice('')}
        />
      )}
    </div>
  )
}
