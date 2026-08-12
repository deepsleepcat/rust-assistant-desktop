/**
 * 设置面板：外观（主题/彩虹）、背景（纯色/渐变/图片 + 透明度/模糊）、
 * 编辑器（字体/字号）、布局（左右栏宽度）、关于。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { DEFAULT_SETTINGS, FONT_OPTIONS } from '../../utils/settings'
import { getBridge } from '../../services/bridge'
import { IconImage } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { Modal } from '../../components/Modal'

const GRADIENT_PRESETS = [
  { name: '纸张', value: 'linear-gradient(135deg, #ffffff 0%, #f1f1f1 100%)' },
  { name: '雾灰', value: 'linear-gradient(135deg, #fafafa 0%, #e5e5e5 100%)' },
  { name: '墨色边缘', value: 'linear-gradient(135deg, #ffffff 0%, #eeeeee 70%, #d8d8d8 100%)' },
]

export function SettingsModal() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const [tab, setTab] = useState<'appearance' | 'background' | 'editor' | 'layout' | 'ai' | 'about'>('appearance')
  const [aiCheck, setAiCheck] = useState<string | null>(null)

  const bg = settings.background
  const [image, setImage] = useState<{ path: string; url: string | null }>({ path: '', url: null })

  useEffect(() => {
    if (bg.kind !== 'image' || !bg.imagePath) return
    let alive = true
    getBridge()
      .project.readImageAsDataUrl('', bg.imagePath)
      .then((url) => alive && setImage({ path: bg.imagePath ?? '', url }))
      .catch(() => alive && setImage({ path: bg.imagePath ?? '', url: null }))
    return () => {
      alive = false
    }
  }, [bg.kind, bg.imagePath])

  const imageUrl = image.path === bg.imagePath ? image.url : null

  const previewStyle: React.CSSProperties = {
    opacity: bg.opacity / 100,
    filter: bg.blur > 0 ? `blur(${bg.blur}px)` : undefined,
  }
  if (bg.kind === 'color') previewStyle.backgroundColor = bg.color
  if (bg.kind === 'gradient') previewStyle.backgroundImage = bg.gradient
  if (bg.kind === 'image' && imageUrl) previewStyle.backgroundImage = `url(${imageUrl})`

  const pickImage = async () => {
    const picked = await getBridge().project.openImageDialog()
    if (picked) updateSettings({ background: { ...bg, imagePath: picked, kind: 'image' } })
  }

  return (
      <Modal title="设置" onClose={() => setSettingsOpen(false)} wide>
      <div style={{ display: 'flex', gap: 20, minHeight: 380 }}>
        {/* 左侧导航 */}
        <nav style={{ width: 130, flexShrink: 0 }}>
          <SettingNavItem active={tab === 'appearance'} onClick={() => setTab('appearance')} icon={<AppIcon name="settings" size={14} />} label="外观" />
          <SettingNavItem active={tab === 'background'} onClick={() => setTab('background')} icon={<IconImage size={14} />} label="背景" />
          <SettingNavItem active={tab === 'editor'} onClick={() => setTab('editor')} icon={<AppIcon name="text" size={14} />} label="编辑器" />
          <SettingNavItem active={tab === 'layout'} onClick={() => setTab('layout')} icon={<AppIcon name="layout" size={14} />} label="布局" />
          <SettingNavItem active={tab === 'ai'} onClick={() => setTab('ai')} icon={<AppIcon name="tools" size={14} />} label="AI" />
          <SettingNavItem active={tab === 'about'} onClick={() => setTab('about')} icon={<AppIcon name="tools" size={14} />} label="关于" />
        </nav>

        {/* 内容 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === 'appearance' && (
            <div className="setting-section">
              <div className="setting-title">外观</div>
              <div className="setting-row">
                <span className="label">
                  黑白专业主题
                  <div className="desc">白色工作区、黑色文字与操作，不使用彩色装饰</div>
                </span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>已固定</span>
              </div>
            </div>
          )}

          {tab === 'background' && (
            <div className="setting-section">
              <div className="setting-title">背景</div>
              <div
                className="bg-preview"
                style={{
                  ...previewStyle,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />
              <div className="setting-row">
                <span className="label">
                  背景类型
                  <div className="desc">面板半透明，背景会透出来</div>
                </span>
                <div className="seg-group">
                  <button className={bg.kind === 'none' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'none' } })}>
                    无
                  </button>
                  <button className={bg.kind === 'color' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'color' } })}>
                    纯色
                  </button>
                  <button className={bg.kind === 'gradient' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'gradient' } })}>
                    渐变
                  </button>
                  <button className={bg.kind === 'image' ? 'active' : ''} onClick={() => updateSettings({ background: { ...bg, kind: 'image' } })}>
                    图片
                  </button>
                </div>
              </div>

              {bg.kind === 'color' && (
                <div className="setting-row">
                  <span className="label">颜色</span>
                  <input
                    type="color"
                    value={bg.color}
                    onChange={(e) => updateSettings({ background: { ...bg, color: e.target.value } })}
                  />
                  <code style={{ color: 'var(--text-2)', fontSize: 12 }}>{bg.color}</code>
                </div>
              )}

              {bg.kind === 'gradient' && (
                <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <span className="label">
                    预设渐变
                    <div className="desc">选择一款黑白灰阶渐变</div>
                  </span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                    {GRADIENT_PRESETS.map((g) => (
                      <button
                        key={g.name}
                        onClick={() => updateSettings({ background: { ...bg, gradient: g.value } })}
                        style={{
                          height: 46,
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border)',
                          backgroundImage: g.value,
                          cursor: 'pointer',
                          position: 'relative',
                          overflow: 'hidden',
                          display: 'grid',
                          placeItems: 'center',
                          color: 'rgba(0,0,0,0.55)',
                          fontSize: 12,
                          fontWeight: 500,
                        }}
                        title={g.name}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {bg.kind === 'image' && (
                <div className="setting-row">
                  <span className="label">
                    背景图片
                    <div className="desc">选择本地图片作为编辑器背景</div>
                  </span>
                  <button className="btn" onClick={() => void pickImage()}>
                    选择图片…
                  </button>
                </div>
              )}

              {bg.kind !== 'none' && bg.kind !== 'color' && (
                <div className="setting-row">
                  <span className="label">
                    模糊
                    <div className="desc">背景柔化程度</div>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    value={bg.blur}
                    onChange={(e) => updateSettings({ background: { ...bg, blur: Number(e.target.value) } })}
                  />
                  <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{bg.blur}px</span>
                </div>
              )}

              {bg.kind !== 'none' && (
                <div className="setting-row">
                  <span className="label">
                    透明度
                    <div className="desc">背景层的可见程度</div>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={bg.opacity}
                    onChange={(e) => updateSettings({ background: { ...bg, opacity: Number(e.target.value) } })}
                  />
                  <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{bg.opacity}%</span>
                </div>
              )}
            </div>
          )}

          {tab === 'editor' && (
            <div className="setting-section">
              <div className="setting-title">编辑器</div>
              <div className="setting-row">
                <span className="label">
                  字体
                  <div className="desc">代码显示字体</div>
                </span>
                <select value={settings.fontFamily} onChange={(e) => updateSettings({ fontFamily: e.target.value })}>
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <span className="label">
                  字号
                  <div className="desc">代码文字大小</div>
                </span>
                <input
                  type="range"
                  min={12}
                  max={20}
                  value={settings.fontSize}
                  onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                />
                <span style={{ width: 34, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.fontSize}px</span>
              </div>
            </div>
          )}

          {tab === 'layout' && (
            <div className="setting-section">
              <div className="setting-title">布局</div>
              <div className="setting-row">
                <span className="label">
                  左侧项目栏宽度
                  <div className="desc">拖动窗口中间的分隔线也可以调整</div>
                </span>
                <input
                  type="range"
                  min={220}
                  max={420}
                  value={settings.leftWidth}
                  onChange={(e) => updateSettings({ leftWidth: Number(e.target.value) })}
                />
                <span style={{ width: 40, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.leftWidth}px</span>
              </div>
              <div className="setting-row">
                <span className="label">
                  右侧对话栏宽度
                </span>
                <input
                  type="range"
                  min={260}
                  max={520}
                  value={settings.rightWidth}
                  onChange={(e) => updateSettings({ rightWidth: Number(e.target.value) })}
                />
                <span style={{ width: 40, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>{settings.rightWidth}px</span>
              </div>
              <div className="setting-row">
                <span className="label">
                  恢复默认布局
                </span>
                <button
                  className="btn"
                  onClick={() => updateSettings({ leftWidth: DEFAULT_SETTINGS.leftWidth, rightWidth: DEFAULT_SETTINGS.rightWidth })}
                >
                  恢复默认
                </button>
              </div>
            </div>
          )}

          {tab === 'ai' && (
            <div className="setting-section">
              <div className="setting-title">AI 助手</div>
              <div className="setting-row">
                <span className="label">
                  AI 提供者
                  <div className="desc">DeepSeek 使用你自己的 API Key；社区后端为预留服务</div>
                </span>
                <div className="seg-group">
                  <button className={settings.ai.provider === 'deepseek' ? 'active' : ''} onClick={() => updateSettings({ ai: { ...settings.ai, provider: 'deepseek' } })}>
                    DeepSeek
                  </button>
                  <button className={settings.ai.provider === 'community' ? 'active' : ''} onClick={() => updateSettings({ ai: { ...settings.ai, provider: 'community' } })} title="即将上线">
                    社区后端（即将上线）
                  </button>
                </div>
              </div>

              {settings.ai.provider === 'deepseek' && (
                <>
                  <div className="setting-row">
                    <span className="label">
                      API Key
                      <div className="desc">在 platform.deepseek.com 获取，仅保存在本机</div>
                    </span>
                    <input
                      type="password"
                      style={{ width: 260 }}
                      placeholder="sk-..."
                      value={settings.ai.deepseekApiKey}
                      onChange={(e) => updateSettings({ ai: { ...settings.ai, deepseekApiKey: e.target.value } })}
                    />
                  </div>
                  <div className="setting-row">
                    <span className="label">
                      模型
                      <div className="desc">v4-flash 便宜快速；v4-pro 更强（价格见 DeepSeek 官网）</div>
                    </span>
                    <select
                      value={settings.ai.deepseekModel}
                      onChange={(e) => updateSettings({ ai: { ...settings.ai, deepseekModel: e.target.value } })}
                    >
                      <option value="deepseek-v4-flash">deepseek-v4-flash（推荐）</option>
                      <option value="deepseek-v4-pro">deepseek-v4-pro</option>
                    </select>
                  </div>
                  <div className="setting-row">
                    <span className="label">连接测试</span>
                    <button
                      className="btn"
                      onClick={async () => {
                        const result = await getBridge().ai.check(settings.ai)
                        setAiCheck(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
                      }}
                    >
                      测试连接
                    </button>
                    {aiCheck && <span style={{ fontSize: 12, color: aiCheck.startsWith('✓') ? 'var(--text-secondary)' : 'var(--danger)' }}>{aiCheck}</span>}
                  </div>
                </>
              )}

              {settings.ai.provider === 'community' && (
                <div className="setting-row">
                  <span className="label">
                    社区后端
                    <div className="desc">社区 AI 服务即将上线，届时将自动接入</div>
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>预留中</span>
                </div>
              )}
            </div>
          )}

          {tab === 'about' && (
            <div className="setting-section">
              <div className="setting-title">关于</div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
                <LogoR size="about" />
                <div>
                  <div style={{ fontWeight: 600 }}>铁锈助手 Rust Assistant</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>版本 0.1.0 · 第一阶段（界面与项目骨架）</div>
                </div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.8, margin: 0 }}>
                面向《铁锈战争》模组开发的桌面工作台。
                本项目参考了开源 Pi Agent Harness、铁锈助手 Android 版与旧版 Python 工具的设计与数据，
                遵循各自开源许可。第三方资源来源见 docs/THIRD-PARTY.md。
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
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

