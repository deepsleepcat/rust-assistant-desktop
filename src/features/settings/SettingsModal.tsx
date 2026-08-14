/**
 * 设置面板：外观（主题/彩虹）、背景（纯色/渐变/图片 + 透明度/模糊）、
 * 编辑器（字体/字号）、布局（左右栏宽度）、关于。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { CURSOR_EFFECT_COLORS, DEFAULT_SETTINGS, FONT_OPTIONS } from '../../utils/settings'
import { getBridge } from '../../services/bridge'
import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { Modal } from '../../components/Modal'
import { AvatarCropModal } from './AvatarCropModal'
import { GameSettingsTab } from './GameSettingsTab'
import { ALL_SEMANTIC_CHECKERS } from '../editor/semanticChecks/registry'
import { getGameVersions, loadCodeData } from '../../services/codeData'

const GRADIENT_PRESETS = [
  { name: '纸张', value: 'linear-gradient(135deg, #ffffff 0%, #f1f1f1 100%)' },
  { name: '雾灰', value: 'linear-gradient(135deg, #fafafa 0%, #e5e5e5 100%)' },
  { name: '墨色边缘', value: 'linear-gradient(135deg, #ffffff 0%, #eeeeee 70%, #d8d8d8 100%)' },
]

export function SettingsModal() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const updateState = useWorkspaceStore((s) => s.updateState)
  const checkUpdate = useWorkspaceStore((s) => s.checkUpdate)
  const downloadUpdate = useWorkspaceStore((s) => s.downloadUpdate)
  const installUpdate = useWorkspaceStore((s) => s.installUpdate)
  const version = useWorkspaceStore((s) => s.version)
  const [tab, setTab] = useState<'appearance' | 'background' | 'editor' | 'layout' | 'ai' | 'avatar' | 'game' | 'about'>('appearance')
  const [aiCheck, setAiCheck] = useState<string | null>(null)
  const [aiChecking, setAiChecking] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  // M8 头像裁切：待裁剪的原图 data URL（null = 未在裁切）
  const [cropSource, setCropSource] = useState<string | null>(null)

  const bg = settings.background
  const [image, setImage] = useState<{ path: string; url: string | null }>({ path: '', url: null })
  const [gameVersions, setGameVersions] = useState<Array<{ versionName: string; versionNumber: number }>>([])

  // M11：目标游戏版本下拉数据（异步加载版本表；失败时只显示「跟随最新」）
  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => {
      if (alive) setGameVersions(getGameVersions())
    })
    return () => {
      alive = false
    }
  }, [])

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

  useEffect(() => {
    if (settings.avatar.source !== 'local' || !settings.avatar.localPath) return
    let alive = true
    void getBridge().project.readImageAsDataUrl('', settings.avatar.localPath).then((url) => alive && setAvatarUrl(url)).catch(() => alive && setAvatarUrl(null))
    return () => { alive = false }
  }, [settings.avatar.source, settings.avatar.localPath, settings.avatar.updatedAt])

  const pickImage = async () => {
    const picked = await getBridge().project.openImageDialog()
    if (picked) updateSettings({ background: { ...bg, imagePath: picked, kind: 'image' } })
  }

  return (
    <>
      <Modal title="设置" onClose={() => setSettingsOpen(false)} wide>
      <div style={{ display: 'flex', gap: 20, minHeight: 380 }}>
        {/* 左侧导航 */}
        <nav style={{ width: 130, flexShrink: 0 }}>
          <SettingNavItem active={tab === 'appearance'} onClick={() => setTab('appearance')} icon={<AppIcon name="palette" size={14} />} label="外观" />
          <SettingNavItem active={tab === 'background'} onClick={() => setTab('background')} icon={<AppIcon name="image" size={14} />} label="背景" />
          <SettingNavItem active={tab === 'editor'} onClick={() => setTab('editor')} icon={<AppIcon name="text" size={14} />} label="编辑器" />
          <SettingNavItem active={tab === 'layout'} onClick={() => setTab('layout')} icon={<AppIcon name="layout" size={14} />} label="布局" />
          <SettingNavItem active={tab === 'ai'} onClick={() => setTab('ai')} icon={<AppIcon name="sparkle" size={14} />} label="AI" />
          <SettingNavItem active={tab === 'avatar'} onClick={() => setTab('avatar')} icon={<AppIcon name="avatar" size={14} />} label="头像" />
          <SettingNavItem active={tab === 'game'} onClick={() => setTab('game')} icon={<AppIcon name="tower" size={14} />} label="游戏" />
          <SettingNavItem active={tab === 'about'} onClick={() => setTab('about')} icon={<AppIcon name="info" size={14} />} label="关于" />
        </nav>

        {/* 内容 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === 'appearance' && (
            <div className="setting-section">
              <div className="setting-title">外观</div>
              <div className="setting-row">
                <span className="label">
                  主题
                  <div className="desc">浅色为白色工作区；深色为暗色工作区；跟随系统则随 Windows 深浅色自动切换</div>
                </span>
                <div className="seg-group">
                  {([
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                    { value: 'system', label: '跟随系统' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      className={settings.theme === opt.value ? 'active' : ''}
                      onClick={() => updateSettings({ theme: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span className="label">
                  鼠标粒子特效
                  <div className="desc">移动鼠标时出现柔和光点尾迹（跟随指针，不影响操作）</div>
                </span>
                <button
                  className={`switch${settings.cursorEffect ? ' on' : ''}`}
                  role="switch"
                  aria-checked={settings.cursorEffect}
                  onClick={() => updateSettings({ cursorEffect: !settings.cursorEffect })}
                >
                  <span className="knob" />
                </button>
              </div>
              {settings.cursorEffect && (
                <div className="setting-row">
                  <span className="label">
                    特效强度
                    <div className="desc">光点数量：弱 / 中 / 强</div>
                  </span>
                  <div className="seg-group">
                    {([1, 2, 3] as const).map((level) => (
                      <button
                        key={level}
                        className={settings.cursorEffectIntensity === level ? 'active' : ''}
                        onClick={() => updateSettings({ cursorEffectIntensity: level })}
                      >
                        {level === 1 ? '弱' : level === 2 ? '中' : '强'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {settings.cursorEffect && (
                <div className="setting-row">
                  <span className="label">
                    特效颜色
                    <div className="desc">黑色为默认，也可选樱花粉 / 浅海蓝或自定义</div>
                  </span>
                  <div className="color-presets">
                    {CURSOR_EFFECT_COLORS.map((c) => (
                      <button
                        key={c.value}
                        className={`color-swatch${settings.cursorEffectColor.toLowerCase() === c.value.toLowerCase() ? ' active' : ''}`}
                        title={c.label}
                        aria-label={c.label}
                        onClick={() => updateSettings({ cursorEffectColor: c.value })}
                        style={{ background: c.value }}
                      />
                    ))}
                    <input
                      type="color"
                      className="color-custom"
                      aria-label="自定义颜色"
                      value={settings.cursorEffectColor}
                      onChange={(e) => updateSettings({ cursorEffectColor: e.target.value })}
                    />
                  </div>
                </div>
              )}
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
              <div className="setting-divider" />
              <div className="setting-title">语义检查器（M10）</div>
              <div className="desc" style={{ marginBottom: 8 }}>
                编辑器波浪线、AI 写后质检与项目检查共用这些规则，可单独开关。
              </div>
              <div className="setting-row">
                <span className="label">
                  目标游戏版本
                  <div className="desc">写入的字段若超出该版本会提示（版本兼容检查）</div>
                </span>
                <select
                  value={settings.targetGameVersion}
                  onChange={(e) => updateSettings({ targetGameVersion: e.target.value })}
                >
                  <option value="">跟随最新（1.15-p10）</option>
                  {gameVersions.map((v) => (
                    <option key={v.versionNumber} value={v.versionName}>
                      {v.versionName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="checker-list">
                {ALL_SEMANTIC_CHECKERS.map((c) => {
                  const on = settings.semanticCheckers[c.id] !== false
                  return (
                    <label key={c.id} className="checker-item">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          updateSettings({ semanticCheckers: { ...settings.semanticCheckers, [c.id]: e.target.checked } })
                        }
                      />
                      <span className="checker-name">{c.title}</span>
                      <span className="checker-desc">{c.description}</span>
                    </label>
                  )
                })}
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
                  max={640}
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
              <div className="setting-row">
                <span className="label">
                  显示隐藏文件
                  <div className="desc">在文件树中显示以 . 开头的文件（如 .nomedia），默认隐藏</div>
                </span>
                <button
                  className={`switch${settings.showHiddenFiles ? ' on' : ''}`}
                  role="switch"
                  aria-checked={settings.showHiddenFiles}
                  onClick={() => {
                    updateSettings({ showHiddenFiles: !settings.showHiddenFiles })
                    // 重载文件树（隐藏文件过滤在主进程读取时生效，需重新读取目录）
                    void useWorkspaceStore.getState().refreshTree()
                  }}
                >
                  <span className="knob" />
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
                      disabled={aiChecking}
                      onClick={async () => {
                        setAiChecking(true)
                        setAiCheck(null)
                        try {
                          const result = await getBridge().ai.check(settings.ai)
                          setAiCheck(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
                        } catch (err) {
                          setAiCheck(`✗ 测试失败：${err instanceof Error ? err.message : String(err)}`)
                        } finally {
                          setAiChecking(false)
                        }
                      }}
                    >
                      {aiChecking ? '测试中…' : '测试连接'}
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

          {tab === 'avatar' && (
            <div className="setting-section">
              <div className="setting-title">头像</div>
              <div className="setting-row">
                <span className="label">
                  自定义头像
                  <div className="desc">选择图片后可裁剪成正方形头像，只保存在你的电脑；社区上传接口预留中</div>
                </span>
                {avatarUrl && <img src={avatarUrl} alt="头像预览" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover' }} />}
                <button className="btn" onClick={async () => {
                  try {
                    const path = await getBridge().avatar.chooseLocal()
                    if (!path) return
                    // 读取原图 → 弹裁切窗口（圆形裁切框，可拖动/缩放选自己喜欢的部分）
                    const dataUrl = await getBridge().project.readImageAsDataUrl('', path)
                    setCropSource(dataUrl)
                  } catch (err) {
                    useWorkspaceStore.getState().notify(`读取图片失败：${err instanceof Error ? err.message : String(err)}`)
                  }
                }}>选择图片</button>
                <button className="btn" onClick={() => updateSettings({ avatar: { source: 'default', localPath: null, remoteUrl: null } })}>恢复默认</button>
              </div>
              <div className="setting-row">
                <span className="label">社区头像上传</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>社区服务即将上线</span>
              </div>
            </div>
          )}

          {tab === 'game' && <GameSettingsTab />}

          {tab === 'about' && (
            <div className="setting-section">
              <div className="setting-title">关于</div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
                <LogoR size="about" />
                <div>
                  <div style={{ fontWeight: 600 }}>铁锈助手 Rust Assistant</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>版本 v{version} · 编辑器 · AI 对话 · 模组工具</div>
                </div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.8, margin: '0 0 16px' }}>
                面向《铁锈战争》模组开发的桌面工作台。
                本项目参考了开源 Pi Agent Harness、铁锈助手 Android 版与旧版 Python 工具的设计与数据，
                遵循各自开源许可。
              </p>
              <div className="setting-row">
                <span className="label">
                  自动更新
                  <div className="desc">更新包托管在 GitHub Releases，免费下载安装</div>
                </span>
                <button
                  className="btn"
                  disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
                  onClick={() => void checkUpdate()}
                >
                  {updateState.status === 'checking' ? '检查中…' : updateState.status === 'downloading' ? `下载中 ${updateState.percent ?? 0}%` : '检查更新'}
                </button>
              </div>
              {updateState.status === 'available' && (
                <div className="setting-row">
                  <span className="label">
                    发现新版本 v{updateState.version}
                    <div className="desc">下载完成后可立即安装并重启</div>
                  </span>
                  <button className="btn primary" onClick={() => void downloadUpdate()}>
                    <AppIcon name="download" size={13} />
                    下载更新
                  </button>
                </div>
              )}
              {updateState.status === 'downloaded' && (
                <div className="setting-row">
                  <span className="label">
                    新版本 v{updateState.version} 已就绪
                    <div className="desc">安装会关闭当前应用并自动重启</div>
                  </span>
                  <button className="btn primary" onClick={() => installUpdate()}>
                    立即安装
                  </button>
                </div>
              )}
              {updateState.status === 'not_available' && (
                <div className="setting-row">
                  <span className="label">
                    <AppIcon name="check" size={13} />
                    {updateState.message ?? '已是最新版本'}
                  </span>
                </div>
              )}
              {updateState.status === 'error' && (
                <div className="setting-row">
                  <span className="label" style={{ color: 'var(--text-secondary)' }}>
                    检查更新失败：{updateState.message}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
      {cropSource && (
        <AvatarCropModal
          imageSrc={cropSource}
          onCancel={() => setCropSource(null)}
          onConfirm={async (croppedDataUrl) => {
            setCropSource(null)
            try {
              // 裁剪结果写为本地文件并登记（返回路径），设置指向它 → 标题栏/预览都能读；
              // updatedAt 递增：裁切弹窗每次生成同一个 avatar.png，依赖路径不变也要触发刷新
              const path = await getBridge().avatar.saveCropped(croppedDataUrl)
              updateSettings({ avatar: { source: 'local', localPath: path, remoteUrl: null, updatedAt: Date.now() } })
            } catch (err) {
              useWorkspaceStore.getState().notify(`保存头像失败：${err instanceof Error ? err.message : String(err)}`)
            }
          }}
        />
      )}
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

