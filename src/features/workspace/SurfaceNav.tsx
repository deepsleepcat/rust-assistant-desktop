import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { CommunityAvatar } from '../../components/CommunityAvatar'
import { runGameAction } from '../../components/desktop/runGame'
import { DESKTOP_NAV_ITEMS, navigationSurface } from '../../components/desktop/shellContract'
import { createCommunityApi } from '../../services/communityApi'
import { useWorkspaceStore } from '../../stores/workspace'
import { useEscapeHandler } from '../../utils/modalStack'

export function SurfaceNav() {
  const activeSurface = useWorkspaceStore((state) => state.activeSurface)
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface)
  const openSettings = useWorkspaceStore((state) => state.openSettings)
  const auth = useWorkspaceStore((state) => state.communityAuth)
  const login = useWorkspaceStore((state) => state.loginCommunity)
  const logout = useWorkspaceStore((state) => state.logoutCommunity)
  const refreshAuth = useWorkspaceStore((state) => state.refreshCommunityAuth)
  const checkPairing = useWorkspaceStore((state) => state.checkCommunityPairing)
  const cancelPairing = useWorkspaceStore((state) => state.cancelCommunityPairing)
  const endpoint = useWorkspaceStore((state) => state.settings.ai.communityEndpoint)
  const [accountOpen, setAccountOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const accountTrigger = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const signedIn = auth.status === 'signed_in'
  const busy = auth.status === 'loading' || auth.status === 'checking'
  const accountLabel = signedIn ? auth.user?.display_name || auth.user?.username || '社区账号' : '未登录'
  const avatarApi = useMemo(() => signedIn
    ? createCommunityApi(endpoint, undefined, undefined, () => void refreshAuth())
    : null, [endpoint, refreshAuth, signedIn])
  const closeMenu = () => {
    setAccountOpen(false)
    accountTrigger.current?.focus()
  }
  useEscapeHandler(closeMenu, accountOpen)

  useEffect(() => {
    if (!accountOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [accountOpen])

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { setAccountOpen(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  const accountSettings = () => { closeMenu(); openSettings('community') }

  return (
    <aside className="desktop-rail" aria-label="主导航">
      <div className="desktop-rail-brand" aria-label="铁锈工坊"><LogoR size="header" /></div>
      <nav className="desktop-rail-nav" aria-label="工作面">
        {DESKTOP_NAV_ITEMS.map((item) => {
          const active = navigationSurface(activeSurface) === item.id
          return (
            <button key={item.id} type="button" className={`desktop-rail-button${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined} aria-label={`${item.label} ${item.en}`} title={`${item.label} · ${item.en}`}
              onClick={() => {
                setAccountOpen(false)
                if (item.id === 'launchGame') void runGameAction()
                else setActiveSurface(item.id)
              }}>
              <AppIcon name={item.icon} size={18} />
              <span className="desktop-rail-tooltip" aria-hidden="true">
                <span>{item.label}</span>
                <small lang="en">{item.en}</small>
              </span>
            </button>
          )
        })}
      </nav>
      <div className="desktop-rail-footer" ref={accountRef}>
        {accountOpen && (
          <div ref={menuRef} id="desktop-account-menu" className="desktop-account-menu" role="menu" aria-label="账号菜单" onKeyDown={onMenuKey}>
            <div className="desktop-account-summary">
              <span className="desktop-account-name">{accountLabel}</span>
              <span className="desktop-account-status">{signedIn ? '已登录社区账号' : auth.status === 'loading' ? '正在配对' : auth.status === 'checking' ? '正在检查会话' : auth.status === 'error' ? '会话检查失败' : '本地编辑可用'}</span>
            </div>
            <button type="button" role="menuitem" onClick={accountSettings}><AppIcon name="settings" size={14} /><Bilingual zh="账号设置" en="Account settings" /></button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => { closeMenu(); openSettings('community'); void login() }}>
              <AppIcon name="link" size={14} /><Bilingual zh={signedIn ? '重新登录 / 配对设备' : '在浏览器中登录'} en={signedIn ? 'Re-login / pair device' : 'Sign in browser'} />
            </button>
            <button type="button" role="menuitem" onClick={accountSettings}><AppIcon name="message" size={14} /><Bilingual zh="邮箱绑定与认证" en="Email & verification" /></button>
            {auth.status === 'loading' && <>
              <button type="button" role="menuitem" onClick={() => { closeMenu(); openSettings('community'); void checkPairing() }}><AppIcon name="refresh" size={14} /><Bilingual zh="检查设备配对" en="Check pairing" /></button>
              <button type="button" role="menuitem" onClick={() => { closeMenu(); void cancelPairing() }}><AppIcon name="close" size={14} /><Bilingual zh="取消配对" en="Cancel pairing" /></button>
            </>}
            {signedIn && <button type="button" role="menuitem" onClick={() => { closeMenu(); void logout() }}><AppIcon name="lock" size={14} /><Bilingual zh="退出登录" en="Sign out" /></button>}
          </div>
        )}
        <button ref={accountTrigger} type="button" className={`desktop-rail-account${accountOpen ? ' open' : ''}`}
          aria-label={`${accountLabel}，打开账号菜单`} aria-haspopup="menu" aria-expanded={accountOpen} aria-controls="desktop-account-menu"
          title="账号：登录、邮箱认证与设备配对 · Account menu" onClick={() => setAccountOpen((open) => !open)}>
          <CommunityAvatar api={avatarApi} avatarPath={auth.user?.avatar_url} className="desktop-account-avatar" iconSize={18} />
          <span className="desktop-rail-tooltip" aria-hidden="true">
            <span>账号</span>
            <small lang="en">Account</small>
          </span>
        </button>
      </div>
    </aside>
  )
}

/** 中文在上、小号英文在下（T9：字段/菜单/提示双语展示，展示层实现）。 */
function Bilingual({ zh, en }: { zh: string; en: string }) {
  return (
    <span className="bilingual">
      <span>{zh}</span>
      <small lang="en">{en}</small>
    </span>
  )
}
