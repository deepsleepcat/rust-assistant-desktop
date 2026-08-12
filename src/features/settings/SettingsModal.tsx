/**
 * 设置面板：外观（主题/彩虹）、背景（纯色/渐变/图片 + 透明度/模糊）、
 * 编辑器（字体/字号）、布局（左右栏宽度）、关于。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { DEFAULT_SETTINGS, FONT_OPTIONS } from '../../utils/settings'
import { getBridge } from '../../services/bridge'
import { IconImage, IconLayout, IconSparkle, IconSun, IconType } from '../../components/icons'
import { Modal } from '../../components/Modal'

const GRADIENT_PRESETS = [
  { name: '谷歌晴空', value: 'linear-gradient(135deg, #e8f0fe 0%, #fce8e6 33%, #fef7e0 66%, #e6f4ea 100%)' },
  { name: '黎明薄雾', value: 'linear-gradient(135deg, #fdfbfb 0%, #ebedee 50%, #e3f2fd 100%)' },
  { name: '樱色黄昏', value: 'linear-gradient(135deg, #ffe9ec 0%, #ffe3d0 45%, #fef3d8 100%)' },
  { name: '极地蓝调', value: 'linear-gradient(135deg, #e7f0fd 0%, #dbe9f8 50%, #eef4fb 100%)' },
  { name: '薄荷晨光', value: 'linear-gradient(135deg, #e6f4ea 0%, #e4f7f0 50%, #eefbf3 100%)' },
]

export function SettingsModal() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const [tab, setTab] = useState<'appearance' | 'background' | 'editor' | 'layout' | 'about'>('appearance')

  const bg = settings.background
  const [image, setImage] = useState<{ path: string; url: string | null }>({ path: '', url: null })

  useEffect(() => {
    if (bg.kind !== 'image' || !bg.imagePath) return
    let alive = true
    getBridge()
      .project.readImageAsDataUrl(bg.imagePath)
      .then((url) => alive && setImage({ path: bg.imagePath ?? '', url }))
      .catch(() => alive && setImage({ path: bg.imagePath ?? '', url: null }))
    return () => {
      alive = false
    }
  }, [bg.kind, bg.imagePath])

  const imageUrl = image.path === bg.imagePath ? image.url : null

  const previewStyle: React.CSSProperties = {}
  if (bg.kind === 'color') previewStyle.backgroundColor = bg.color
  if (bg.kind === 'gradient') previewStyle.backgroundImage = bg.gradient
  if (bg.kind === 'image' && imageUrl) previewStyle.backgroundImage = `url(${imageUrl})`

  const pickImage = async () => {
    const picked = await getBridge().project.openImageDialog()
    if (picked) updateSettings({ background: { ...bg, imagePath: picked, kind: 'image' } })
  }

  return (
    <Modal title={<span className="rainbow-text">设置</span>} onClose={() => setSettingsOpen(false)} wide>
      <div style={{ display: 'flex', gap: 20, minHeight: 380 }}>
        {/* 左侧导航 */}
        <nav style={{ width: 130, flexShrink: 0 }}>
          <SettingNavItem active={tab === 'appearance'} onClick={() => setTab('appearance')} icon={<IconSun size={14} />} label="外观" />
          <SettingNavItem active={tab === 'background'} onClick={() => setTab('background')} icon={<IconImage size={14} />} label="背景" />
          <SettingNavItem active={tab === 'editor'} onClick={() => setTab('editor')} icon={<IconType size={14} />} label="编辑器" />
          <SettingNavItem active={tab === 'layout'} onClick={() => setTab('layout')} icon={<IconLayout size={14} />} label="布局" />
          <SettingNavItem active={tab === 'about'} onClick={() => setTab('about')} icon={<IconSparkle size={14} />} label="关于" />
        </nav>

        {/* 内容 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === 'appearance' && (
            <div className="setting-section">
              <div className="setting-title">外观</div>
              <div className="setting-row">
                <span className="label">
                  主题
                  <div className="desc">浅色、深色或跟随系统</div>
                </span>
                <div className="seg-group">
                  <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => updateSettings({ theme: 'light' })}>
                    浅色
                  </button>
                  <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => updateSettings({ theme: 'dark' })}>
                    深色
                  </button>
                  <button className={settings.theme === 'system' ? 'active' : ''} onClick={() => updateSettings({ theme: 'system' })}>
                    跟随系统
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <span className="label">
                  Google 彩虹装饰
                  <div className="desc">顶部渐变线、彩虹按钮、彩虹 Logo</div>
                </span>
                <Switch checked={settings.rainbow} onChange={(v) => updateSettings({ rainbow: v })} />
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
                  opacity: 1,
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
                    <div className="desc">选择一款柔和的多彩渐变</div>
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
                          background: g.value,
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

          {tab === 'about' && (
            <div className="setting-section">
              <div className="setting-title">关于</div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
                <div className="titlebar-logo" style={{ width: 42, height: 42, borderRadius: 12, fontSize: 24 }}>
                  R
                </div>
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

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span className="thumb" />
    </label>
  )
}
