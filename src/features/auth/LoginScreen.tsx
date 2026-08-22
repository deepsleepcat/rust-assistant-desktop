import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { useWorkspaceStore } from '../../stores/workspace'

/** Desktop launch gate. Browser preview intentionally bypasses this screen. */
export function LoginScreen() {
  const auth = useWorkspaceStore((state) => state.communityAuth)
  const login = useWorkspaceStore((state) => state.loginCommunity)
  const checkPairing = useWorkspaceStore((state) => state.checkCommunityPairing)
  const cancelPairing = useWorkspaceStore((state) => state.cancelCommunityPairing)
  const retry = useWorkspaceStore((state) => state.refreshCommunityAuth)
  const endpoint = useWorkspaceStore((state) => state.settings.ai.communityEndpoint)
  const busy = auth.status === 'loading' || auth.status === 'checking'
  const pairingActive = auth.status === 'loading' && Boolean(auth.pairing)

  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-brand">
          <LogoR size="about" />
          <span>铁锈工坊</span>
        </div>
        <div className="auth-mark"><AppIcon name="lock" size={18} /></div>
        <h1 id="auth-title">登录后开始工作</h1>
        <p className="auth-copy">使用社区账号登录，跨设备同步社区身份与创作记录。</p>
        {!pairingActive && <button className="btn primary auth-login" disabled={busy} onClick={() => void login()}>
          <AppIcon name="link" size={14} />
          {busy ? '正在检查登录状态…' : '在浏览器中登录'}
        </button>}
        {pairingActive && auth.pairing && <div className="auth-pairing" role="status" aria-live="polite">
          <p>浏览器已打开，请登录后在批准页手动点击“批准设备”。</p>
          <code>配对码：{auth.pairing.userCode}</code>
          <div className="auth-actions">
            <button className="btn primary" onClick={() => void checkPairing()}>我已批准，检查状态</button>
            <button className="btn" onClick={() => void cancelPairing()}>取消配对</button>
          </div>
        </div>}
        <div className="auth-status" role="status" aria-live="polite">
          {auth.status === 'error' && <><span className="auth-error">{auth.error}</span><button className="btn auth-retry" onClick={() => void retry()}>重新检查</button></>}
          {auth.status === 'checking' && '正在恢复已有登录状态…'}
          {auth.status === 'signed_out' && '登录窗口会在系统浏览器中打开。'}
        </div>
        <div className="auth-endpoint"><span>服务</span><code>{endpoint}</code></div>
      </section>
    </main>
  )
}
