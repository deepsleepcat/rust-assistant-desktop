/**
 * 顶部标题栏：Logo、项目名、命令搜索（Codex 风格）、设置头像。
 * 在 Electron 中作为可拖拽区域（窗口控制按钮由系统渲染在右侧）。
 * 社区账号不再持有令牌：登录统一走独立登录门禁（loginCommunity），
 * 头像经主进程注入凭据后由 /api/me 获取，renderer 只拿到公开资料。
 */
import { useWorkspaceStore } from '../stores/workspace'
import { AppIcon } from './AppIcon'
import { LogoR } from './LogoR'
import { truncateMiddle } from '../utils/paths'
import { createCommunityApi } from '../services/communityApi'
import { CommunityAvatar } from './CommunityAvatar'
import { useEffect, useMemo, useState } from 'react'

export function TitleBar() {
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const setCommandOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const openSettings = useWorkspaceStore((s) => s.openSettings)
  const loginCommunity = useWorkspaceStore((s) => s.loginCommunity)
  const refreshCommunityAuth = useWorkspaceStore((s) => s.refreshCommunityAuth)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const signedIn = communityAuth.status === 'signed_in'
  const [avatar, setAvatar] = useState<{ key: string; path?: string }>({ key: '' })
  const endpoint = useWorkspaceStore((s) => s.settings.ai.communityEndpoint)
  const communityApi = useMemo(() => signedIn ? createCommunityApi(endpoint, undefined, undefined, () => void refreshCommunityAuth()) : null, [endpoint, refreshCommunityAuth, signedIn])

  useEffect(() => {
    if (!communityApi) return
    let alive = true
    const key = `${communityAuth.user?.id ?? 0}:${communityAuth.user?.username ?? ''}`
    void communityApi.me()
      .then((me) => alive && setAvatar({ key, path: me.avatar_url }))
      .catch(() => alive && setAvatar({ key }))
    return () => { alive = false }
  }, [communityApi, communityAuth.user])

  const avatarKey = `${communityAuth.user?.id ?? 0}:${communityAuth.user?.username ?? ''}`
  const avatarPath = signedIn && avatar.key === avatarKey ? avatar.path : communityAuth.user?.avatar_url

  return (
    <header className="titlebar">
      <div className="titlebar-inner">
        <LogoR size="header" />
        <span className="titlebar-name">铁锈工坊</span>
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
        <button
          className="community-account-btn"
          title={signedIn ? '打开社区账号设置' : '在浏览器中登录社区账号'}
          onClick={() => (signedIn ? openSettings('community') : void loginCommunity())}
        >
          <AppIcon name="user" size={13} />
          <span>{signedIn ? '社区账号' : '登录社区'}</span>
        </button>
        <button className="avatar-btn glow-hover" title="社区账号" onClick={() => openSettings('community')}>
          <CommunityAvatar api={communityApi} avatarPath={avatarPath} className="titlebar-avatar" iconSize={15} />
        </button>
      </div>
    </header>
  )
}