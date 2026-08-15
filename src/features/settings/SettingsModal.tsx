/**
 * 设置面板（Tab 内联渲染，未拆子组件；结构标注便于定位）：
 * - SettingsModal（主）——左导航 + 右内容区，tab 状态驱动
 * - 外观（appearance）  主题/彩虹/鼠标特效
 * - 背景（background）  纯色/渐变/图片 + 透明度/模糊
 * - 编辑器（editor）    字体/字号/语义检查器开关/自定义规则
 * - 布局（layout）      左右栏宽度
 * - AI（ai）           提供者/Key/模型/用量统计
 * - 头像（avatar）      本地图片裁切（AvatarCropModal）
 * - 游戏（game）        游戏目录/版本兼容（GameSettingsTab，独立文件）
 * - 关于（about）       版本/数据源/更新
 * - SettingNavItem（文件尾部）左侧导航项
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
import { loadProjectRuleSets, type ProjectRuleSet } from '../editor/semanticChecks/customRules'
import { parseStoredUsage, summarizeUsage, type AiUsageSummary } from '../ai/usageStats'
import { getDataVersionInfo, getGameVersions, loadCodeData, reloadCodeData, type DataVersionInfo } from '../../services/codeData'

const GRADIENT_PRESETS = [
  { name: '纸张', value: 'linear-gradient(135deg, #ffffff 0%, #f1f1f1 100%)' },
  { name: '雾灰', value: 'linear-gradient(135deg, #fafafa 0%, #e5e5e5 100%)' },
  { name: '墨色边缘', value: 'linear-gradient(135deg, #ffffff 0%, #eeeeee 70%, #d8d8d8 100%)' },
]

export function SettingsModal() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const notify = useWorkspaceStore((s) => s.notify)
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
  // M16：离线知识包数据版本信息（关于页展示）
  const [dataVersion, setDataVersion] = useState<DataVersionInfo | null>(null)
  // M18：知识包更新器状态（检查结果/更新中/本地信息）
  const [kpInfo, setKpInfo] = useState<{ currentVersion: string | null; updatedAt: number; availableVersions: string[] } | null>(null)
  const [kpCheck, setKpCheck] = useState<{ hasUpdate: boolean; latestVersion: string; changedFiles: string[]; error?: string } | null>(null)
  const [kpBusy, setKpBusy] = useState(false)
  const [newMirror, setNewMirror] = useState('')
  // M21：项目自定义规则（rules/*.json；编辑器页签展示，可单独开关）
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [projectRules, setProjectRules] = useState<{ sets: ProjectRuleSet[]; errors: Array<{ file: string; errors: string[] }> } | null>(null)
  // M23：本地 AI 用量统计（AI 页签加载）
  const [usage, setUsage] = useState<AiUsageSummary | null>(null)

  // M23：进入「AI」页签时加载本地用量统计
  useEffect(() => {
    if (tab !== 'ai') return
    let alive = true
    void getBridge()
      .store.get('aiUsage')
      .then((raw) => alive && setUsage(summarizeUsage(parseStoredUsage(raw))))
      .catch(() => alive && setUsage({ totalCalls: 0, totalTokens: 0, todayCalls: 0, todayTokens: 0, weekCalls: 0, weekTokens: 0 }))
    return () => {
      alive = false
    }
  }, [tab])

  /** 清空本地用量统计（不影响对话历史） */
  const clearUsage = async () => {
    try {
      await getBridge().store.set('aiUsage', [])
      setUsage({ totalCalls: 0, totalTokens: 0, todayCalls: 0, todayTokens: 0, weekCalls: 0, weekTokens: 0 })
      notify('本地 AI 用量统计已清空')
    } catch (err) {
      notify(`清空失败：${err instanceof Error ? err.message : String(err)}（统计记录保留）`)
    }
  }

  // M21：进入「编辑器」页签时加载项目自定义规则（无项目/无 rules 目录时为空）。
  // 切走页签时由 switchTab 清空缓存结果，避免显示陈旧数据
  useEffect(() => {
    if (tab !== 'editor') return
    let alive = true
    if (!activeProject) return
    void loadProjectRuleSets(activeProject.rootPath)
      .then((r) => alive && setProjectRules(r))
      .catch(() => alive && setProjectRules({ sets: [], errors: [] }))
    return () => {
      alive = false
    }
  }, [tab, activeProject])

  /** 页签切换（M21：离开编辑器页签时清空自定义规则缓存结果） */
  const switchTab = (t: typeof tab) => {
    setTab(t)
    if (t !== 'editor') setProjectRules(null)
  }

  // M11：目标游戏版本下拉数据（异步加载版本表；失败时只显示「跟随最新」）
  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => {
      if (!alive) return
      const versions = getGameVersions()
      setGameVersions(versions)
      setDataVersion(getDataVersionInfo())
      // M18：读取知识包本地状态（更新版本/回滚入口）
      void getBridge()
        .knowledge?.info()
        .then((info) => alive && setKpInfo(info))
        .catch(() => undefined)
      // 存储的版本名不在当前版本表（数据更新后旧值残留）→ 归一化回「跟随最新」，
      // 避免 select 显示与实际存储脱节
      const stored = useWorkspaceStore.getState().settings.targetGameVersion
      if (stored && versions.length > 0 && !versions.some((v) => v.versionName === stored)) {
        useWorkspaceStore.getState().updateSettings({ targetGameVersion: '' })
      }
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

  // M18：知识包更新操作（检查/更新/回滚；更新成功后重载数据，补全与检查立即生效）
  const activeSource = settings.knowledgeSourceUrl.trim() || settings.knowledgeSources[0] || ''
  const refreshKpInfo = async () => {
    const info = await getBridge().knowledge?.info()
    if (info) setKpInfo(info)
  }
  const checkKp = async () => {
    if (!activeSource) {
      notify('请先配置知识包数据源（官方源或镜像地址）')
      return
    }
    setKpBusy(true)
    setKpCheck(null)
    try {
      const r = await getBridge().knowledge!.checkUpdate(activeSource)
      setKpCheck({ hasUpdate: r.hasUpdate, latestVersion: r.latestVersion, changedFiles: r.changedFiles, error: r.error })
    } catch (err) {
      setKpCheck({ hasUpdate: false, latestVersion: '', changedFiles: [], error: err instanceof Error ? err.message : String(err) })
    } finally {
      setKpBusy(false)
    }
  }
  const updateKp = async () => {
    setKpBusy(true)
    try {
      const r = await getBridge().knowledge!.update(activeSource)
      if (r.ok) {
        // 更新成功：清缓存重载数据（补全/检查/翻译立即用新数据）
        reloadCodeData()
        setDataVersion(null)
        void loadCodeData().then(() => setDataVersion(getDataVersionInfo()))
        await refreshKpInfo()
        notify(r.updatedFiles === 0 ? '知识包已是最新版本' : `知识包更新完成（${r.updatedFiles} 个文件），数据已重新加载`)
      } else {
        notify(`更新失败：${r.error ?? '未知错误'}（旧版不受影响）`)
      }
    } catch (err) {
      notify(`更新失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setKpBusy(false)
    }
  }
  const rollbackKp = async () => {
    setKpBusy(true)
    try {
      const r = await getBridge().knowledge!.rollback()
      if (r.ok) {
        reloadCodeData()
        await refreshKpInfo()
        notify(`已回滚到知识包版本 ${r.version ?? '内置包'}，数据已重新加载`)
      } else {
        notify(`回滚失败：${r.error ?? '未知错误'}`)
      }
    } catch (err) {
      notify(`回滚失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setKpBusy(false)
    }
  }
  const addMirror = () => {
    const url = newMirror.trim()
    if (!/^https?:\/\//i.test(url)) {
      notify('镜像地址需以 http:// 或 https:// 开头')
      return
    }
    if (settings.knowledgeSources.includes(url)) {
      notify('该镜像已在列表中')
      return
    }
    updateSettings({ knowledgeSources: [...settings.knowledgeSources, url] })
    setNewMirror('')
  }

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
          <SettingNavItem active={tab === 'appearance'} onClick={() => switchTab('appearance')} icon={<AppIcon name="palette" size={14} />} label="外观" />
          <SettingNavItem active={tab === 'background'} onClick={() => switchTab('background')} icon={<AppIcon name="image" size={14} />} label="背景" />
          <SettingNavItem active={tab === 'editor'} onClick={() => switchTab('editor')} icon={<AppIcon name="text" size={14} />} label="编辑器" />
          <SettingNavItem active={tab === 'layout'} onClick={() => switchTab('layout')} icon={<AppIcon name="layout" size={14} />} label="布局" />
          <SettingNavItem active={tab === 'ai'} onClick={() => switchTab('ai')} icon={<AppIcon name="sparkle" size={14} />} label="AI" />
          <SettingNavItem active={tab === 'avatar'} onClick={() => switchTab('avatar')} icon={<AppIcon name="avatar" size={14} />} label="头像" />
          <SettingNavItem active={tab === 'game'} onClick={() => switchTab('game')} icon={<AppIcon name="tower" size={14} />} label="游戏" />
          <SettingNavItem active={tab === 'about'} onClick={() => switchTab('about')} icon={<AppIcon name="info" size={14} />} label="关于" />
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
                  <option value="">
                    跟随最新{gameVersions.length > 0 ? `（${gameVersions[gameVersions.length - 1].versionName}）` : ''}
                  </option>
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
              <div className="setting-divider" />
              <div className="setting-title">项目自定义规则（M19/M21）</div>
              <div className="desc" style={{ marginBottom: 8 }}>
                把 JSON 规则文件放进项目 <code>rules/</code> 目录即可被加载（AI 生成的用例可一键保存到这里）。
                规则是声明式的（数值区间/必需键/枚举/正则），<b>不执行任何脚本</b>——恶意规则最多产生误报，无法读写文件。
              </div>
              {!activeProject ? (
                <div className="desc">打开项目后显示该项目 rules/ 目录下的自定义规则。</div>
              ) : projectRules === null ? (
                <div className="desc">加载中…</div>
              ) : projectRules.sets.length === 0 && projectRules.errors.length === 0 ? (
                <div className="desc">该项目没有自定义规则（可让 AI 生成检查用例后保存）。</div>
              ) : (
                <>
                  {projectRules.sets.map((s) => (
                    <div key={s.file}>
                      <div className="checker-list">
                        {s.rules.map((r) => {
                          const key = `custom:${r.id}`
                          const on = settings.semanticCheckers[key] !== false
                          return (
                            <label key={r.id} className="checker-item">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) =>
                                  updateSettings({ semanticCheckers: { ...settings.semanticCheckers, [key]: e.target.checked } })
                                }
                              />
                              <span className="checker-name">{r.title}</span>
                              <span className="checker-desc">
                                {r.description ?? r.check.type}
                                {r.section ? ` · 节 [${r.section}]` : ''}
                                {r.key ? ` · ${r.key}` : ''}
                                {' · '}
                                <code style={{ fontSize: 10.5 }}>{s.file}</code>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                  {projectRules.errors.map((e) => (
                    <div key={e.file} className="setting-error">
                      {e.file} 校验失败：{e.errors.join('；')}
                    </div>
                  ))}
                </>
              )}
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
                  <div className="desc">M23：客户端只内置 DeepSeek；其他模型由未来的社区后端提供（服务未上线）</div>
                </span>
                <div className="seg-group">
                  <button className={settings.ai.provider === 'deepseek' ? 'active' : ''} onClick={() => updateSettings({ ai: { ...settings.ai, provider: 'deepseek' } })}>
                    DeepSeek
                  </button>
                  {/* M23：切换入口禁用——多模型走服务器社区后端，不在客户端接入 */}
                  <button className="btn" disabled title="社区后端服务未上线（本地客户端不接入其他模型供应商）">
                    社区后端（服务未上线）
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

              {/* M23：社区 AI 入口占位——可见但明确「服务未上线」，不报错不假死 */}
              {settings.ai.provider === 'community' && (
                <div className="setting-row">
                  <span className="label">
                    社区后端
                    <div className="desc">社区 AI 服务未上线；届时自动接入（本地无需配置 API Key）。当前请切换回 DeepSeek 使用</div>
                  </span>
                  <button className="btn primary" onClick={() => updateSettings({ ai: { ...settings.ai, provider: 'deepseek' } })}>
                    切换回 DeepSeek
                  </button>
                </div>
              )}

              <div className="setting-divider" />
              <div className="setting-title">本地 AI 用量统计（M23）</div>
              <div className="desc" style={{ marginBottom: 8 }}>
                调用次数与 token 为估算值（字符数/4），仅保存在本机，供未来服务器阶段对接成本核算。
              </div>
              <div className="data-version-list">
                <div className="data-version-row"><span>今日</span><code>{usage ? `${usage.todayCalls} 次 · ${usage.todayTokens} token` : '…'}</code></div>
                <div className="data-version-row"><span>近 7 天</span><code>{usage ? `${usage.weekCalls} 次 · ${usage.weekTokens} token` : '…'}</code></div>
                <div className="data-version-row"><span>累计</span><code>{usage ? `${usage.totalCalls} 次 · ${usage.totalTokens} token` : '…'}</code></div>
              </div>
              <div className="setting-row">
                <span className="label">
                  清空统计
                  <div className="desc">删除本地全部用量记录（不影响对话历史）</div>
                </span>
                <button className="btn" onClick={() => void clearUsage()}>清空</button>
              </div>
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
              <div className="setting-divider" />
              <div className="setting-title">离线知识包</div>
              <div className="desc" style={{ marginBottom: 8 }}>
                官方代码表、版本表、modding guide 与模板均内置在应用内——无网络时补全、检查、模板、打包全部可用。
                数据与游戏版本对应关系如下：
              </div>
              <div className="data-version-list">
                <div className="data-version-row"><span>代码表（code.json）</span><code>{dataVersion ? `${dataVersion.codeCount} 条` : '…'}</code></div>
                <div className="data-version-row"><span>游戏版本表</span><code>{dataVersion ? `${dataVersion.versionCount} 个版本（最新 ${dataVersion.latestVersionName ?? '?'}）` : '…'}</code></div>
                <div className="data-version-row"><span>字段版本上限</span><code>{dataVersion ? (dataVersion.maxAddVersion !== undefined ? `版本 ${dataVersion.maxAddVersion}` : '无版本标记') : '…'}</code></div>
                <div className="data-version-row">
                  <span>数据一致性</span>
                  <code className={dataVersion && !dataVersion.consistent ? 'data-version-bad' : ''}>
                    {!dataVersion
                      ? '…'
                      : dataVersion.consistent === undefined
                        ? '无法判定（数据不完整）'
                        : dataVersion.consistent
                          ? '✓ 字段版本均不超出版本表'
                          : '⚠ 存在超出版本表的字段'}
                  </code>
                </div>
              </div>
              {dataVersion && !dataVersion.loaded && (
                <div className="setting-error">数据加载失败——补全/检查/翻译将不可用，请重新启动应用</div>
              )}
              <div className="setting-divider" />
              <div className="setting-title">知识包更新</div>
              <div className="desc" style={{ marginBottom: 8 }}>
                官方数据（代码表/版本表/翻译等）可检测更新并增量下载，下载后校验哈希，失败自动保留旧版；
                无网络或未配置数据源时，内置知识包照常工作。
              </div>
              <div className="setting-row">
                <span className="label">
                  数据源
                  <div className="desc">选择官方源或已添加的镜像（需 http/https 地址）</div>
                </span>
                <select
                  value={settings.knowledgeSourceUrl}
                  onChange={(e) => updateSettings({ knowledgeSourceUrl: e.target.value })}
                  style={{ maxWidth: 320 }}
                >
                  <option value="">未配置（仅内置包）</option>
                  {settings.knowledgeSourceUrl && <option value={settings.knowledgeSourceUrl}>{settings.knowledgeSourceUrl}</option>}
                  {settings.knowledgeSources
                    .filter((s) => s !== settings.knowledgeSourceUrl)
                    .map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                </select>
              </div>
              <div className="setting-row">
                <span className="label">添加镜像源</span>
                <input
                  style={{ width: 280 }}
                  placeholder="https://example.com/knowledge-pack"
                  value={newMirror}
                  onChange={(e) => setNewMirror(e.target.value)}
                />
                <button className="btn" onClick={addMirror}>
                  添加
                </button>
              </div>
              {settings.knowledgeSources.map((s, i) => (
                <div key={s} className="setting-row">
                  <code style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-all' }}>{s}</code>
                  <button
                    className="btn"
                    onClick={() => {
                      const next = settings.knowledgeSources.filter((_, idx) => idx !== i)
                      updateSettings({
                        knowledgeSources: next,
                        // 删掉正在使用的镜像时清空活动源；未配置活动源时隐式活动源是
                        // 列表第一个——删它时把活动源交给下一个，避免静默切换
                        knowledgeSourceUrl:
                          settings.knowledgeSourceUrl === s || (settings.knowledgeSourceUrl === '' && i === 0)
                            ? (next[0] ?? '')
                            : settings.knowledgeSourceUrl,
                      })
                    }}
                  >
                    移除
                  </button>
                </div>
              ))}
              <div className="setting-row">
                <span className="label">
                  当前知识包
                  <div className="desc">
                    {kpInfo?.currentVersion
                      ? `版本 ${kpInfo.currentVersion}（${new Date(kpInfo.updatedAt).toLocaleString()} 更新）`
                      : '使用应用内置数据'}
                  </div>
                </span>
                <button className="btn" disabled={kpBusy} onClick={() => void checkKp()}>
                  {kpBusy ? '处理中…' : '检查更新'}
                </button>
              </div>
              {kpCheck?.error && <div className="setting-error">检查更新失败：{kpCheck.error}</div>}
              {kpCheck && !kpCheck.error && !kpCheck.hasUpdate && kpCheck.latestVersion && (
                <div className="setting-row">
                  <span className="label">
                    <AppIcon name="check" size={13} />
                    已是最新知识包（版本 {kpCheck.latestVersion}）
                  </span>
                </div>
              )}
              {kpCheck?.hasUpdate && (
                <div className="setting-row">
                  <span className="label">
                    发现新版本 {kpCheck.latestVersion}
                    <div className="desc">变更 {kpCheck.changedFiles.length} 个文件：{kpCheck.changedFiles.join('、') || '（无）'}</div>
                  </span>
                  <button className="btn primary" disabled={kpBusy} onClick={() => void updateKp()}>
                    <AppIcon name="download" size={13} />
                    立即更新
                  </button>
                </div>
              )}
              {kpInfo && kpInfo.availableVersions.length > 1 && (
                <div className="setting-row">
                  <span className="label">
                    回滚知识包
                    <div className="desc">恢复到上一个版本（更新失败不会影响旧版，无需手动回滚）</div>
                  </span>
                  <button className="btn" disabled={kpBusy} onClick={() => void rollbackKp()}>
                    回滚
                  </button>
                </div>
              )}
              <div className="setting-divider" />
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

