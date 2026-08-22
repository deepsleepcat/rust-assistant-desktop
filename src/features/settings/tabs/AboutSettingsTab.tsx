/**
 * 设置 → 关于：版本信息、离线知识包数据版本、知识包更新/镜像管理/回滚、应用自动更新。
 * 从 SettingsModal 拆出（M39 巨型函数治理）；知识包状态与操作全部随本组件。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { getBridge } from '../../../services/bridge'
import { AppIcon } from '../../../components/AppIcon'
import { LogoR } from '../../../components/LogoR'
import { getDataVersionInfo, loadCodeData, reloadCodeData, type DataVersionInfo } from '../../../services/codeData'

export function AboutSettingsTab() {
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const notify = useWorkspaceStore((s) => s.notify)
  const updateState = useWorkspaceStore((s) => s.updateState)
  const checkUpdate = useWorkspaceStore((s) => s.checkUpdate)
  const downloadUpdate = useWorkspaceStore((s) => s.downloadUpdate)
  const installUpdate = useWorkspaceStore((s) => s.installUpdate)
  const version = useWorkspaceStore((s) => s.version)
  // M16：离线知识包数据版本信息
  const [dataVersion, setDataVersion] = useState<DataVersionInfo | null>(null)
  // M18：知识包更新器状态（检查结果/更新中/本地信息）
  const [kpInfo, setKpInfo] = useState<{ currentVersion: string | null; updatedAt: number; availableVersions: string[] } | null>(null)
  const [kpCheck, setKpCheck] = useState<{ hasUpdate: boolean; latestVersion: string; changedFiles: string[]; error?: string } | null>(null)
  const [kpBusy, setKpBusy] = useState(false)
  const [newMirror, setNewMirror] = useState('')

  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => {
      if (!alive) return
      setDataVersion(getDataVersionInfo())
      // 读取知识包本地状态（更新版本/回滚入口）
      void getBridge()
        .knowledge?.info()
        .then((info) => alive && setKpInfo(info))
        .catch(() => undefined)
    })
    return () => {
      alive = false
    }
  }, [])

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
        // 与 updateKp 一致：清缓存后立即重载数据（回滚后词典/补全不能留空到下次触发）
        reloadCodeData()
        setDataVersion(null)
        void loadCodeData().then(() => setDataVersion(getDataVersionInfo()))
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

  return (
    <div className="setting-section">
      <div className="setting-title">关于</div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
        <LogoR size="about" />
        <div>
          <div style={{ fontWeight: 600 }}>铁锈工坊 Rust Assistant</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>版本 v{version} · 编辑器 · AI 对话 · 模组工具</div>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.8, margin: '0 0 16px' }}>
        面向《铁锈战争》模组开发的桌面工作台。
        本项目参考了开源 Pi Agent Harness、铁锈工坊 Android 版与旧版 Python 工具的设计与数据，
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
  )
}
