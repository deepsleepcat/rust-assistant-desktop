/**
 * 项目文件树面板（手机端）。
 *
 * 关键修正：
 * - 递归子目录时项目根不再被替换（旧实现把 `rootPath` 传成子目录，导致
 *   展开后所有文件操作被桥的「超出项目目录范围」拒绝）；
 * - 每层目录只加载一次并缓存，展开/折叠不再重复请求；
 * - 异步返回按请求序号校验，切换项目/刷新后丢弃过期结果；
 * - 区分文本与资源：只有铁锈配置文件进编辑器，图片等走只读预览；
 * - 新建 / 重命名 / 删除入口（名称先过 validateEntryName，同名不覆盖）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirEntry } from '../../types/bridge'
import { getBridge } from '../../services/bridge'
import { AppIcon, type AppIconName } from '../../components/AppIcon'
import { ConfirmModal, PromptModal } from '../../components/MobileDialog'
import { validateEntryName } from '../../utils/entryName'
import { decideOpenMode, isPreviewableImage, isRustConfigFile } from '../../utils/paths'

interface FileTreePanelProps {
  projectRoot: string
  showHidden: boolean
  /** 变化时重载已展开目录（AI 写入 / 模板创建 / 保存后由父层自增） */
  refreshToken: number
  /** 打开文本文件（进编辑器） */
  onOpenText: (path: string, name: string) => void
  /** 打开资源（图片预览 / 资源信息） */
  onOpenAsset: (path: string, name: string) => void
  /** 文件树发生变更（新建/改名/删除）后通知父层 */
  onMutated?: () => void
}

type PromptMode = 'file' | 'folder' | 'rename'

interface PromptState {
  mode: PromptMode
  /** 目标所在目录（新建时是目录，重命名时是被改条目所在目录） */
  dir: string
  /** 重命名时的原条目 */
  target?: DirEntry
}

function entryIcon(entry: DirEntry): AppIconName {
  if (entry.isDirectory) return 'folder'
  if (isPreviewableImage(entry.name)) return 'image'
  if (isRustConfigFile(entry.name)) return 'document'
  return 'file'
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : path
}

export function FileTreePanel({ projectRoot, showHidden, refreshToken, onOpenText, onOpenAsset, onMutated }: FileTreePanelProps) {
  const [dirs, setDirs] = useState<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set([projectRoot]))
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuFor, setMenuFor] = useState<DirEntry | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DirEntry | null>(null)

  // 每个目录的请求序号：过期响应（切项目/刷新/连续展开）直接丢弃
  const seqRef = useRef(new Map<string, number>())
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadDir = useCallback(
    async (dirPath: string): Promise<DirEntry[] | null> => {
      const seq = (seqRef.current.get(dirPath) ?? 0) + 1
      seqRef.current.set(dirPath, seq)
      setLoadingDirs((prev) => new Set(prev).add(dirPath))
      try {
        const entries = await getBridge().project.readDir(projectRoot, dirPath, showHidden)
        if (!aliveRef.current || seqRef.current.get(dirPath) !== seq) return null
        setDirs((prev) => new Map(prev).set(dirPath, entries))
        setError('')
        return entries
      } catch (err) {
        if (aliveRef.current && seqRef.current.get(dirPath) === seq) {
          setError(err instanceof Error ? err.message : '目录读取失败')
        }
        return null
      } finally {
        if (aliveRef.current && seqRef.current.get(dirPath) === seq) {
          setLoadingDirs((prev) => {
            const next = new Set(prev)
            next.delete(dirPath)
            return next
          })
        }
      }
    },
    [projectRoot, showHidden],
  )

  /**
   * 重载根目录与所有已展开目录（首次进入、刷新令牌变化、文件变更后都要用）。
   * 删除目录后调用方要传 dirsOverride：state 更新是异步的，直接读 expanded 会去加载
   * 已经不存在的目录并报错。
   */
  const reloadAll = useCallback(
    async (dirsOverride?: string[]) => {
      const expandedList = dirsOverride ?? [...expanded]
      const targets = [projectRoot, ...expandedList.filter((d) => d !== projectRoot)]
      setDirs(new Map())
      for (const dir of targets) {
        if (!aliveRef.current) return
        await loadDir(dir)
      }
    },
    [projectRoot, expanded, loadDir],
  )

  // 首次进入 + 刷新令牌变化：整体重载
  useEffect(() => {
    void reloadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在项目根/刷新令牌/隐藏开关变化时整体重载
  }, [projectRoot, refreshToken, showHidden])

  async function toggleDir(entry: DirEntry) {
    const wasExpanded = expanded.has(entry.path)
    // 函数式更新：同一批次里连续切换多个目录不会互相覆盖
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (!wasExpanded && !dirs.has(entry.path)) await loadDir(entry.path)
  }

  function handleEntryClick(entry: DirEntry) {
    if (entry.isDirectory) {
      void toggleDir(entry)
      return
    }
    if (decideOpenMode(entry.name) === 'editor') onOpenText(entry.path, entry.name)
    else onOpenAsset(entry.path, entry.name)
  }

  /** 同层已有名称（校验重名用；重命名时排除自己） */
  function siblingsOf(dirPath: string, exclude?: string): string[] {
    return (dirs.get(dirPath) ?? []).map((e) => e.name).filter((n) => n !== exclude)
  }

  async function handlePromptConfirm(value: string) {
    if (!prompt) return
    const bridge = getBridge()
    setBusy(true)
    setError('')
    try {
      if (prompt.mode === 'file') {
        await bridge.project.createFile(projectRoot, prompt.dir, value)
      } else if (prompt.mode === 'folder') {
        await bridge.project.createFolder(projectRoot, prompt.dir, value)
      } else if (prompt.target) {
        const target = prompt.target
        await bridge.project.rename(projectRoot, target.path, `${prompt.dir}/${value}`)
      }
      setPrompt(null)
      setMenuFor(null)
      // 重命名可能跨目录、删除可能带走子目录：整体重载而不是只刷一个目录，
      // 否则其它已展开目录会短暂空白（缓存被清、又没有重新加载）
      await reloadAll()
      onMutated?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
      setPrompt(null)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    const target = pendingDelete
    if (!target) return
    setBusy(true)
    setError('')
    try {
      await getBridge().project.delete(projectRoot, target.path)
      setPendingDelete(null)
      setMenuFor(null)
      // 删目录会带走其子目录：折叠状态与重载列表都要先剔除被删路径
      const remaining = [...expanded].filter((dir) => dir !== target.path && !dir.startsWith(`${target.path}/`))
      setExpanded(new Set(remaining))
      await reloadAll(remaining)
      onMutated?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setPendingDelete(null)
    } finally {
      setBusy(false)
    }
  }

  function renderLevel(dirPath: string, depth: number): React.ReactNode {
    if (!dirs.has(dirPath)) {
      return loadingDirs.has(dirPath) ? (
        <p className="m-empty" key={`${dirPath}-loading`}>
          加载中…
        </p>
      ) : null
    }
    const entries = dirs.get(dirPath) ?? []
    if (entries.length === 0) {
      return (
        <p className="file-empty" key={`${dirPath}-empty`} style={{ paddingLeft: 16 + depth * 16 }}>
          {depth === 0 ? '项目为空，先用「新建」或「模板」创建内容' : '（空目录）'}
        </p>
      )
    }
    return entries.map((entry) => (
      <div key={entry.path}>
        <div className="file-node-row">
          <button
            className={`file-node${depth === 0 ? ' root' : ''}`}
            style={{ paddingLeft: 10 + depth * 16 }}
            onClick={() => handleEntryClick(entry)}
          >
            {entry.isDirectory && <span className="file-chevron">{expanded.has(entry.path) ? '▾' : '▸'}</span>}
            <AppIcon name={entryIcon(entry)} size={15} />
            <span className="file-name">{entry.name}</span>
            {loadingDirs.has(entry.path) && <span className="file-spin" />}
          </button>
          <button className="file-node-more" onClick={() => setMenuFor(entry)} aria-label={`${entry.name} 的更多操作`}>
            <AppIcon name="menu" size={16} />
          </button>
        </div>
        {entry.isDirectory && expanded.has(entry.path) && renderLevel(entry.path, depth + 1)}
      </div>
    ))
  }

  return (
    <div className="file-tree">
      {error && <p className="m-empty" style={{ color: 'var(--danger)' }}>{error}</p>}
      {renderLevel(projectRoot, 0)}

      {menuFor && (
        <div className="m-modal-mask" onClick={() => setMenuFor(null)}>
          <div className="m-modal sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="m-modal-title">{menuFor.name}</h3>
            {menuFor.isDirectory && (
              <>
                <button
                  className="m-modal-item"
                  onClick={() => {
                    // 先收起操作菜单：否则菜单与后续弹层同时挂在 DOM 上，关掉一个还剩一个
                    setMenuFor(null)
                    setPrompt({ mode: 'file', dir: menuFor.path })
                  }}
                >
                  <AppIcon name="file" size={16} />
                  新建文件
                </button>
                <button
                  className="m-modal-item"
                  onClick={() => {
                    setMenuFor(null)
                    setPrompt({ mode: 'folder', dir: menuFor.path })
                  }}
                >
                  <AppIcon name="folder" size={16} />
                  新建文件夹
                </button>
              </>
            )}
            <button
              className="m-modal-item"
              onClick={() => {
                setMenuFor(null)
                setPrompt({ mode: 'rename', dir: parentOf(menuFor.path), target: menuFor })
              }}
            >
              <AppIcon name="rename" size={16} />
              重命名
            </button>
            <button
              className="m-modal-item danger"
              onClick={() => {
                setMenuFor(null)
                setPendingDelete(menuFor)
              }}
            >
              <AppIcon name="delete" size={16} />
              删除
            </button>
            <div className="m-modal-actions">
              <button className="m-btn" onClick={() => setMenuFor(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {prompt && (
        <PromptModal
          title={prompt.mode === 'file' ? '新建文件' : prompt.mode === 'folder' ? '新建文件夹' : '重命名'}
          label={prompt.mode === 'file' ? '文件名（含扩展名，如 myUnit.ini）' : '名称'}
          defaultValue={prompt.mode === 'rename' ? prompt.target?.name : ''}
          confirmText={busy ? '处理中…' : prompt.mode === 'rename' ? '重命名' : '创建'}
          validate={(value) => {
            const check = validateEntryName(value, siblingsOf(prompt.dir, prompt.mode === 'rename' ? prompt.target?.name : undefined))
            return check.error
          }}
          onConfirm={(value) => void handlePromptConfirm(value)}
          onCancel={() => setPrompt(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`删除「${pendingDelete.name}」？`}
          message={pendingDelete.isDirectory ? '该文件夹及其中的全部文件都会被删除，无法在应用内撤销。' : '文件会被永久删除，无法在应用内撤销。'}
          confirmText={busy ? '删除中…' : '删除'}
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
