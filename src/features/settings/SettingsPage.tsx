import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { SettingsContent } from './SettingsContent'
import { surfaceLabel } from '../../components/desktop/shellContract'

/** Full work surface for settings. It owns the same tab content as the legacy modal. */
export function SettingsPage() {
  const setSettingsOpen = useWorkspaceStore((state) => state.setSettingsOpen)
  const communityAuth = useWorkspaceStore((state) => state.communityAuth)
  const returnSurface = useWorkspaceStore((state) => state.settingsReturnSurface)
  const returnLabel = surfaceLabel(returnSurface)

  return (
    <section className="settings-page" aria-labelledby="settings-page-title">
      <header className="settings-page-header">
        <div>
          <span className="surface-eyebrow">铁锈工坊 / SETTINGS</span>
          <h1 id="settings-page-title">设置</h1>
          <p>管理外观、编辑器、账号与游戏连接。更改会自动保存到本机。</p>
        </div>
        <div className="settings-page-actions">
          <span className={`settings-session-badge${communityAuth.status === 'signed_in' ? ' connected' : ''}`}>
            <span className="sb-dot" aria-hidden="true" />
            {communityAuth.status === 'signed_in' ? '账号已连接' : '离线可用'}
          </span>
          <button type="button" className="icon-btn settings-close" aria-label={`返回${returnLabel}`} title={`返回${returnLabel}`} onClick={() => setSettingsOpen(false)}>
            <AppIcon name="close" size={16} />
          </button>
        </div>
      </header>
      <div className="settings-page-body">
        <SettingsContent />
      </div>
    </section>
  )
}
