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
import { createCommunityApi, resolveCommunityUrl } from '../services/communityApi'
import { useEffect, useState } from 'react'

export function TitleBar() {
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const setCommandOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const openSettings = useWorkspaceStore((s) => s.openSettings)
  const loginCommunity = useWorkspaceStore((s) => s.loginCommunity)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const signedIn = communityAuth.status === 'signed_in'
  const [avatar, setAvatar] = useState<{ key: string; url: string | null }>({ key: '', url: null })

  useEffect(() => {
    if (!signedIn) return
    let alive = true
    const key = `${communityAuth.user?.id ?? 0}:${communityAuth.user?.username ?? ''}`
    void createCommunityApi(useWorkspaceStore.getState().settings.ai.communityEndpoint)
      .me()
      .then((me) => {
        if (!alive) return
        const endpoint = useWorkspaceStore.getState().settings.ai.communityEndpoint
        setAvatar({ key, url: resolveCommunityUrl(endpoint, me.avatar_url) })
      })
      .catch(() => alive && setAvatar({ key, url: null }))
    return () => { alive = false }
  }, [signedIn, communityAuth.user])

  const avatarKey = `${communityAuth.user?.id ?? 0}:${communityAuth.user?.username ?? ''}`
  const avatarUrl = signedIn && avatar.key === avatarKey ? avatar.url : null

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
          {avatarUrl ? <img src={avatarUrl} alt="社区账号头像" /> : '猫'}
        </button>
      </div>
    </header>
  )
}