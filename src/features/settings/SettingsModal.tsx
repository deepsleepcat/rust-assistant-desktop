/**
 * 设置面板（M39 巨型函数治理后为轻量壳）：左导航 + 页签内容分发。
 * 各页签内容在独立文件（GameSettingsTab / tabs/*），均自订阅工作区 store。
 * - 外观（appearance）  主题/彩虹/鼠标特效 → tabs/AppearanceSettingsTab
 * - 背景（background）  纯色/渐变/图片 + 透明度/模糊 → tabs/BackgroundSettingsTab
 * - 编辑器（editor）    字体/字号/语义检查器开关/自定义规则 → tabs/EditorSettingsTab
 * - 布局（layout）      宽度/比例/折叠/大纲 → tabs/LayoutSettingsTab
 * - AI（ai）           提供者/Key（safeStorage）/模型/用量 → tabs/AiSettingsTab
 * - 社区（community）   配对登录/邮箱认证 → tabs/CommunitySettingsTab
 * - 游戏（game）        GameSettingsTab（独立文件）
 * - 关于（about）       版本/知识包/更新 → tabs/AboutSettingsTab
 * - SettingNavItem（文件尾部）左侧导航项
 */
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { GameSettingsTab } from './GameSettingsTab'
import { AppearanceSettingsTab } from './tabs/AppearanceSettingsTab'
import { BackgroundSettingsTab } from './tabs/BackgroundSettingsTab'
import { EditorSettingsTab } from './tabs/EditorSettingsTab'
import { LayoutSettingsTab } from './tabs/LayoutSettingsTab'
import { AiSettingsTab } from './tabs/AiSettingsTab'
import { CommunitySettingsTab } from './tabs/CommunitySettingsTab'
import { AboutSettingsTab } from './tabs/AboutSettingsTab'

export function SettingsModal() {
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const tab = useWorkspaceStore((s) => s.settingsTab)
  const setTab = useWorkspaceStore((s) => s.setSettingsTab)

  const switchTab = (t: typeof tab) => setTab(t)

  return (
    <>
      <Modal title="设置" onClose={() => setSettingsOpen(false)} wide>
      <div style={{ display: 'flex', gap: 20, minHeight: 380 }}>
        {/* 左侧导航 */}
        <nav style={{ width: 130, flexShrink: 0 }}>
          <SettingNavItem active={tab === 'appearance'} onClick={() => switchTab('appearance')} icon={<AppIcon name="palette" size={14} />} label="外观" />
          <SettingNavItem active={tab === 'background'} onClick={() => switchTab('background')} icon={<AppIcon name="image" size={14} />} label="背景" />
          <SettingNavItem active={tab === 'editor'} onClick={() => switchTab('editor')} icon={<AppIcon name="text" size={14} />} label="编辑器" />
          <SettingNavItem active={tab === 'layout'} onClick={() => switchTab('layout')} icon={<AppIcon name="layout" size={14} />} label="布局" />
          <SettingNavItem active={tab === 'ai'} onClick={() => switchTab('ai')} icon={<AppIcon name="sparkle" size={14} />} label="AI" />
          <SettingNavItem active={tab === 'community'} onClick={() => switchTab('community')} icon={<AppIcon name="share" size={14} />} label="社区" />
          <SettingNavItem active={tab === 'game'} onClick={() => switchTab('game')} icon={<AppIcon name="tower" size={14} />} label="游戏" />
          <SettingNavItem active={tab === 'coming'} onClick={() => switchTab('coming')} icon={<AppIcon name="clock" size={14} />} label="计划中" />
          <SettingNavItem active={tab === 'about'} onClick={() => switchTab('about')} icon={<AppIcon name="info" size={14} />} label="关于" />
        </nav>

        {/* 内容 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === 'appearance' && <AppearanceSettingsTab />}
          {tab === 'background' && <BackgroundSettingsTab />}
          {tab === 'editor' && <EditorSettingsTab />}
          {tab === 'layout' && <LayoutSettingsTab />}
          {tab === 'ai' && <AiSettingsTab />}
          {tab === 'community' && <CommunitySettingsTab />}
          {tab === 'game' && <GameSettingsTab />}

          {tab === 'coming' && (
            <div className="setting-section">
              <div className="setting-title">计划中（即将上线）</div>
              <div className="desc" style={{ marginBottom: 12 }}>
                以下功能正在规划与开发中，上线后入口将在这里开放：
              </div>
              {[
                { icon: 'share' as const, name: '手机版 · 随身编辑', desc: '手机端本地模组编辑器，模板/检查/AI 随身带' },
                { icon: 'cloud' as const, name: '云书包 · 多端同步', desc: '同一账号下手机与电脑接力同一份模组' },
                { icon: 'sparkle' as const, name: '社区 AI', desc: '免配置的多模型 AI 服务，无需自己填 Key' },
                { icon: 'lock' as const, name: '模组加密', desc: '服务器端加密保护，防解包与盗用' },
                { icon: 'box' as const, name: '模板市场', desc: '社区模板浏览与一键下载' },
              ].map((f) => (
                <div key={f.name} className="setting-row">
                  <span className="label">
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <AppIcon name={f.icon} size={13} />
                      {f.name}
                    </span>
                    <div className="desc">{f.desc}</div>
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>规划中</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'about' && <AboutSettingsTab />}
        </div>
      </div>
    </Modal>
    </>
  )
}

function SettingNavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        marginBottom: 2,
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--bg-active)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-2)',
        font: '13.5px var(--font-ui)',
        cursor: 'pointer',
        fontWeight: active ? 500 : 400,
      }}
    >
      {icon}
      {label}
    </button>
  )
}
