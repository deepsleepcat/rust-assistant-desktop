import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { GameSettingsTab } from './GameSettingsTab'
import { AppearanceSettingsTab } from './tabs/AppearanceSettingsTab'
import { BackgroundSettingsTab } from './tabs/BackgroundSettingsTab'
import { EditorSettingsTab } from './tabs/EditorSettingsTab'
import { LayoutSettingsTab } from './tabs/LayoutSettingsTab'
import { CommunitySettingsTab } from './tabs/CommunitySettingsTab'
import { PluginsSettingsTab } from './tabs/PluginsSettingsTab'
import { EngineDlcSettingsTab } from './tabs/EngineDlcSettingsTab'
import { AboutSettingsTab } from './tabs/AboutSettingsTab'
import { ShortcutSettingsTab } from './tabs/ShortcutSettingsTab'

export function SettingsContent() {
  const storeTab = useWorkspaceStore((state) => state.settingsTab)
  const setTab = useWorkspaceStore((state) => state.setSettingsTab)
  // T9：新界面完全不显示 AI 入口；AiSettingsTab 源码保留，旧入口收到 'ai' 时回落外观。
  const tab = storeTab === 'ai' || storeTab === 'background' || storeTab === 'layout' ? 'appearance'
    : storeTab === 'engineDlc' ? 'plugins'
    : storeTab === 'coming' ? 'about' : storeTab

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分区">
        <SettingNavItem active={tab === 'appearance'} onClick={() => setTab('appearance')} icon={<AppIcon name="palette" size={14} />} label="外观与布局" />
        <SettingNavItem active={tab === 'editor'} onClick={() => setTab('editor')} icon={<AppIcon name="text" size={14} />} label="编辑器" />
        <SettingNavItem active={tab === 'shortcuts'} onClick={() => setTab('shortcuts')} icon={<AppIcon name="bolt" size={14} />} label="快捷键" />
        <SettingNavItem active={tab === 'community'} onClick={() => setTab('community')} icon={<AppIcon name="user" size={14} />} label="账号" />
        <SettingNavItem active={tab === 'plugins'} onClick={() => setTab('plugins')} icon={<AppIcon name="box" size={14} />} label="插件与 DLC" />
        <SettingNavItem active={tab === 'game'} onClick={() => setTab('game')} icon={<AppIcon name="tower" size={14} />} label="游戏" />
        <SettingNavItem active={tab === 'about'} onClick={() => setTab('about')} icon={<AppIcon name="info" size={14} />} label="关于" />
      </nav>

      <div className="settings-content">
        {tab === 'appearance' && <><AppearanceSettingsTab /><BackgroundSettingsTab /><LayoutSettingsTab /></>}
        {tab === 'editor' && <EditorSettingsTab />}
        {tab === 'shortcuts' && <ShortcutSettingsTab />}
        {tab === 'community' && <CommunitySettingsTab />}
        {tab === 'plugins' && <><PluginsSettingsTab /><EngineDlcSettingsTab /></>}
        {tab === 'game' && <GameSettingsTab />}
        {tab === 'about' && <><AboutSettingsTab /><ComingSettingsTab /></>}
      </div>
    </div>
  )
}

function SettingNavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className={`settings-nav-item${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function ComingSettingsTab() {
  return (
    <div className="setting-section">
      <div className="setting-title">计划中（即将上线）</div>
      <div className="desc" style={{ marginBottom: 12 }}>
        以下功能正在规划与开发中，上线后入口将在这里开放：
      </div>
      {[
        { icon: 'share' as const, name: '手机版 · 随身编辑', desc: '手机端本地模组编辑器，模板/检查/AI 随身带' },
        { icon: 'cloud' as const, name: '云仓库 · 多端同步', desc: '同一账号下手机与电脑接力同一份模组' },
        { icon: 'sparkle' as const, name: '社区 AI', desc: '免配置的多模型 AI 服务，无需自己填 Key' },
        { icon: 'lock' as const, name: '模组加密', desc: '服务器端加密保护，防解包与盗用' },
        { icon: 'box' as const, name: '模板市场', desc: '社区模板浏览与一键下载' },
      ].map((feature) => (
        <div key={feature.name} className="setting-row">
          <span className="label">
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <AppIcon name={feature.icon} size={13} />
              {feature.name}
            </span>
            <div className="desc">{feature.desc}</div>
          </span>
          <span className="setting-muted">规划中</span>
        </div>
      ))}
    </div>
  )
}
