/**
 * 创建/编辑模组自述文件弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）。
 * 已存在 mod-info.txt 时进入编辑模式（覆盖式写回），否则创建。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'
import { getBridge } from '../../../services/bridge'

/** 编辑模式的回填数据（来自 mod:readModInfo） */
export interface ModInfoEditorData {
  title: string
  description?: string
  author?: string
  version?: string
  thumbnail?: string
  minVersion?: string
  musicFiles: string[]
  musicExclusive: boolean
  mapsFiles: string[]
  mapsExtra: boolean
  /** M8：自定义音乐/地图目录（编辑保存时原样传回，防止覆盖用户手改的 sourceFolder） */
  musicSourceFolder?: string
  mapsSourceFolder?: string
  /** M8：更新链接（写入 [mod] update: 键） */
  updateUrl?: string
}

export function CreateModModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [author, setAuthor] = useState('')
  const [version, setVersion] = useState('1.0')
  // M8 更新链接（http/https，写入 [mod] update: 键）
  const [updateUrl, setUpdateUrl] = useState('')
  // M6.5 背景音乐：源文件绝对路径列表 + 独占播放开关
  const [musicFiles, setMusicFiles] = useState<string[]>([])
  const [musicExclusive, setMusicExclusive] = useState(true)
  // M7 编辑模式：已有 mod-info.txt 时回填，保存走覆盖式写回。
  // 初始即 'loading'：读取完成前不渲染表单、提交按钮禁用（此前从 null 起步，
  // 'loading' 分支永不成立，读取期间快速点击会误走创建分支）
  const [existing, setExisting] = useState<ModInfoEditorData | null | 'loading'>('loading')

  useEscapeHandler(onClose)

  // 打开时读取已有自述文件（存在则进入编辑模式）
  useEffect(() => {
    let alive = true
    const project = useWorkspaceStore.getState().projects.find((p) => p.id === useWorkspaceStore.getState().activeProjectId)
    if (!project) return
    void getBridge()
      .mod.readModInfo(project.rootPath)
      .then((info) => {
        if (!alive) return
        if (info) {
          setExisting(info)
          setTitle(info.title)
          setDescription(info.description ?? '')
          setAuthor(info.author ?? '')
          setVersion(info.version ?? '1.0')
          setUpdateUrl(info.updateUrl ?? '')
          setMusicExclusive(info.musicExclusive)
          // 已存在的 music/ 文件作为只读展示（源路径不可反推，仅展示）
        } else {
          setExisting(null)
        }
      })
      .catch(() => alive && setExisting(null))
    return () => { alive = false }
  }, [])

  const chooseMusic = async () => {
    try {
      const files = await getBridge().mod.chooseMusic()
      if (files.length > 0) setMusicFiles((prev) => [...prev, ...files.filter((f) => !prev.includes(f))])
    } catch {
      /* 用户取消或失败：保持原状 */
    }
  }

  const submit = () => {
    if (!title.trim()) return
    if (existing === 'loading') return // 加载中不允许提交
    // 更新链接校验：为空或合法 http(s) 链接（不符合就拦截并提示，避免写入脏数据）
    if (updateUrl.trim() && !/^https?:\/\/\S+$/i.test(updateUrl.trim())) {
      useWorkspaceStore.getState().notify('更新链接需以 http:// 或 https:// 开头')
      return
    }
    if (existing) {
      // 编辑模式：覆盖式写回
      void useWorkspaceStore.getState().saveModInfo({
        title: title.trim(),
        description: description.trim() || undefined,
        author: author.trim() || undefined,
        version: version.trim() || undefined,
        thumbnail: existing.thumbnail,
        minVersion: existing.minVersion,
        musicFiles: existing.musicFiles,
        musicExclusive: musicExclusive,
        mapsFiles: existing.mapsFiles,
        mapsExtra: existing.mapsExtra,
        // M8：原样传回自定义目录，防止覆盖用户手改的 sourceFolder
        musicSourceFolder: existing.musicSourceFolder,
        mapsSourceFolder: existing.mapsSourceFolder,
        updateUrl: updateUrl.trim() || undefined,
      })
      onClose()
      return
    }
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      author: author.trim() || undefined,
      version: version.trim() || undefined,
      musicFiles: musicFiles.length > 0 ? musicFiles : undefined,
      musicExclusive: musicFiles.length > 0 ? musicExclusive : undefined,
      updateUrl: updateUrl.trim() || undefined,
    })
    onClose()
  }

  const musicNames = musicFiles.map((f) => f.split(/[\\/]/).pop() ?? f)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{existing === 'loading' ? '模组自述文件' : existing ? '编辑模组自述文件' : '创建模组自述文件'}</div>
        <div className="modal-body mod-form">
          {existing === 'loading' ? (
            <p className="mod-tip">正在读取 mod-info.txt…</p>
          ) : (
          <>
          <p className="mod-tip">
            {existing
              ? '已检测到 mod-info.txt，保存将覆盖原内容（游戏内显示的模组标题与信息）。'
              : '模组自述文件（mod-info.txt）用于描述模组信息，游戏会读取它显示模组标题。已存在时不会覆盖。'}
          </p>
          <label className="mod-field">
            <span>模组标题（游戏内显示）<em>*</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如 我的模组" autoFocus />
          </label>
          <label className="mod-field">
            <span>描述（可选）</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="模组介绍，将写入 mod-info.txt" />
          </label>
          <div className="mod-row">
            <label className="mod-field">
              <span>作者</span>
              <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="可选" />
            </label>
            <label className="mod-field">
              <span>版本</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0" />
            </label>
          </div>
          <label className="mod-field">
            <span>更新链接（可选）</span>
            <input value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} placeholder="https://…（写入 mod-info.txt 的 update 键）" />
          </label>
          {!existing && (
            <div className="mod-field">
              <span>背景音乐（可选）</span>
              <button type="button" className="btn" onClick={() => void chooseMusic()}>选择音乐…</button>
              {musicNames.length > 0 && (
                <ul className="music-list">
                  {musicNames.map((n, i) => (
                    <li key={`${n}-${i}`}>
                      <span title={musicFiles[i]}>{n}</span>
                      <button type="button" className="icon-btn" title="移除" onClick={() => setMusicFiles((prev) => prev.filter((_, j) => j !== i))}>
                        <AppIcon name="close" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mod-tip">支持 mp3 / wav / flac / m4a / ogg，将自动转换为 ogg 并放入 music/ 目录。</div>
            </div>
          )}
          {existing && existing.musicFiles.length > 0 && (
            <div className="mod-field">
              <span>背景音乐（music/ 目录）</span>
              <ul className="music-list">
                {existing.musicFiles.map((f) => (
                  <li key={f}>
                    <span title={f}>{f.split('/').pop()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {existing && existing.mapsFiles.length > 0 && (
            <div className="mod-field">
              <span>地图（maps/ 目录）</span>
              <ul className="music-list">
                {existing.mapsFiles.map((f) => (
                  <li key={f}>
                    <span title={f}>{f.split('/').pop()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(existing ? existing.musicFiles.length > 0 : musicFiles.length > 0) && (
            <div className="setting-row">
              <span className="label">
                独占播放
                <div className="desc">使用本模组单位时独占播放背景音乐</div>
              </span>
              <button
                className={`switch${musicExclusive ? ' on' : ''}`}
                role="switch"
                aria-checked={musicExclusive}
                onClick={() => setMusicExclusive(!musicExclusive)}
              >
                <span className="knob" />
              </button>
            </div>
          )}
          <p className="mod-tip">{existing ? '保存将覆盖 mod-info.txt，音乐/地图清单来自 music/ 与 maps/ 目录。' : '将在项目根目录生成 mod-info.txt（模组自述文件），不创建示例单位。'}</p>
          </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={existing === 'loading' || !title.trim()} onClick={submit}>
            {existing === 'loading' ? '读取中…' : existing ? '保存修改' : '创建自述文件'}
          </button>
        </div>
      </div>
    </div>
  )
}
