import { AppIcon } from '../AppIcon'
import { useWorkspaceStore } from '../../stores/workspace'

export function SurfaceAuthGate({ surfaceLabel, description }: { surfaceLabel: string; description: string }) {
  const auth = useWorkspaceStore((state) => state.communityAuth)
  const login = useWorkspaceStore((state) => state.loginCommunity)
  const retry = useWorkspaceStore((state) => state.refreshCommunityAuth)
  const checkPairing = useWorkspaceStore((state) => state.checkCommunityPairing)
  const cancelPairing = useWorkspaceStore((state) => state.cancelCommunityPairing)
  const enterOffline = useWorkspaceStore((state) => state.enterOfflineMode)
  const setSurface = useWorkspaceStore((state) => state.setActiveSurface)
  const openSettings = useWorkspaceStore((state) => state.openSettings)
  const pairingActive = auth.status === 'loading' && Boolean(auth.pairing)
  const checking = auth.status === 'checking'

  return (
    <section className="surface-auth-gate" aria-labelledby="surface-auth-title">
      <div className="surface-auth-mark"><AppIcon name="lock" size={18} /></div>
      <span className="surface-eyebrow">{surfaceLabel} / ONLINE ACCESS</span>
      <h1 id="surface-auth-title">登录后打开{surfaceLabel}</h1>
      <p>{description}</p>
      <p className="surface-auth-note">应用不会接收或保存浏览器密码，配对凭据继续由桌面安全存储管理。</p>
      {!pairingActive && (
        <div className="surface-auth-actions">
          <button type="button" className="btn primary" disabled={checking} onClick={() => void login()}>
            <AppIcon name="link" size={14} />{checking ? '正在检查…' : '在浏览器中登录'}
          </button>
          <button type="button" className="btn" onClick={() => { enterOffline(); setSurface('editor') }}>
            离线回到工作区
          </button>
        </div>
      )}
      {pairingActive && auth.pairing && (
        <div className="surface-auth-pairing" role="status" aria-live="polite">
          <p>浏览器已打开，请登录后在批准页点击“批准设备”。</p>
          <code>配对码：{auth.pairing.userCode}</code>
          <div className="surface-auth-actions">
            <button type="button" className="btn primary" onClick={() => void checkPairing()}>我已批准，检查状态</button>
            <button type="button" className="btn" onClick={() => void cancelPairing()}>取消配对</button>
          </div>
        </div>
      )}
      <div className="surface-auth-status" role="status" aria-live="polite">
        {auth.status === 'error' && <><span className="surface-auth-error">{auth.error}</span><button type="button" className="btn" onClick={() => void retry()}>重新检查</button></>}
        {auth.status === 'checking' && '正在恢复已有登录状态…'}
        {auth.status === 'signed_out' && '登录窗口会在系统浏览器中打开。'}
        {auth.status === 'offline' && '当前为离线状态。'}
      </div>
      <button type="button" className="surface-auth-settings" onClick={() => openSettings('community')}>
        <AppIcon name="settings" size={13} />打开账号设置
      </button>
    </section>
  )
}
