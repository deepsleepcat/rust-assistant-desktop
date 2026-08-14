/**
 * 顶部标题栏：Logo、项目名、命令搜索（Codex 风格）、设置头像。
 * 在 Electron 中作为可拖拽区域（窗口控制按钮由系统渲染在右侧）。
 */
import { useWorkspaceStore } from '../stores/workspace'
import { AppIcon } from './AppIcon'
import { LogoR } from './LogoR'
import { truncateMiddle } from '../utils/paths'
import { getBridge } from '../services/bridge'
import { useEffect, useState } from 'react'

export function TitleBar() {
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const setCommandOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const avatarSettings = useWorkspaceStore((s) => s.settings.avatar)
  const [avatar, setAvatar] = useState<{ path: string; url: string | null }>({ path: '', url: null })

  useEffect(() => {
    if (avatarSettings.source !== 'local' || !avatarSettings.localPath) return
    let alive = true
    void getBridge().project.readImageAsDataUrl('', avatarSettings.localPath).then((url) => alive && setAvatar({ path: avatarSettings.localPath ?? '', url })).catch(() => alive && setAvatar({ path: avatarSettings.localPath ?? '', url: null }))
    return () => { alive = false }
    // updatedAt：重新裁切头像后路径不变，也要重新读取
  }, [avatarSettings.source, avatarSettings.localPath, avatarSettings.updatedAt])

  const avatarUrl = avatar.path === avatarSettings.localPath ? avatar.url : null

  return (
    <header className="titlebar">
      <div className="titlebar-inner">
        <LogoR size="header" />
        <span className="titlebar-name">铁锈助手</span>
        {activeProject && (
          <>
            <span className="titlebar-sep">/</span>
            <span className="titlebar-project" title={activeProject.rootPath}>
              {truncateMiddle(activeProject.rootPath, 42)}
            </span>
          </>
        )}
        <div className="titlebar-search" onClick={() => setCommandOpen(true)} role="search" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setCommandOpen(true)}>
          <AppIcon name="search" size={14} />
          <span>搜索命令、打开项目…</span>
          <span className="hint">
            <kbd>Ctrl</kbd> <kbd>K</kbd>
          </span>
        </div>
        <div className="titlebar-spacer" />
        <button className="avatar-btn glow-hover" title="打开设置" onClick={() => setSettingsOpen(true)}>
          {avatarUrl ? <img src={avatarUrl} alt="用户头像" /> : '猫'}
        </button>
      </div>
    </header>
  )
}
