/**
 * M42 引擎渲染 DLC 设置页：展示指定目录、列出其中的 DLC、授权/撤销运行。
 *
 * 定位说明（文案必须说清，否则用户以为我们在分发引擎）：
 * 本软件**不提供、也不下载**任何游戏引擎；只提供一个「插座」——
 * 用户把自己准备的渲染 DLC 放进指定目录并授权后，单位预览可以调用它渲染。
 *
 * 该页只做三件事：显示目录路径 / 打开目录 / 授权与撤销。
 * 「谁被授权」存在主进程独占的信任锚里，这里拿到的只是状态快照。
 */
import { useCallback, useEffect, useState } from 'react'
import { AppIcon } from '../../../components/AppIcon'
import { getBridge } from '../../../services/bridge'
import type { EngineDlcEntry } from '../../../types/bridge'

export function EngineDlcSettingsTab() {
  const bridge = getBridge()
  const api = bridge.engineDlc
  const [dir, setDir] = useState('')
  const [dlcs, setDlcs] = useState<EngineDlcEntry[]>([])
  // 初始值就按「有没有这个能力」定，避免在 effect 里同步 setState（会触发级联渲染）
  const [loading, setLoading] = useState(() => Boolean(api))
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const result = await api.list()
      setDir(result.dir)
      setDlcs(result.dlcs)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [api])

  useEffect(() => {
    let active = true
    if (!api) return
    void api
      .list()
      .then((result) => {
        if (!active) return
        setDir(result.dir)
        setDlcs(result.dlcs)
      })
      .catch((error: unknown) => {
        if (!active) return
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api])

  const openDir = async () => {
    if (!api) return
    setBusy('open')
    setMessage(null)
    try {
      const result = await api.openDir()
      setDir(result.dir)
      if (!result.ok) setMessage(result.message ?? '无法打开目录')
      else await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const toggle = async (entry: EngineDlcEntry) => {
    if (!api) return
    setBusy(entry.id)
    setMessage(null)
    // 授权会弹系统确认框（主进程弹，界面伪造不了）；取消不算失败，只提示一句
    try {
      const result = await api.grant(entry.id, !entry.enabled)
      if (!result.ok) setMessage(result.message ?? '操作未完成')
      else setMessage(result.enabled ? `已授权：${result.name ?? entry.id}` : `已撤销授权：${entry.name || entry.id}`)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  if (!api) {
    return (
      <div className="setting-section">
        <div className="setting-title"><AppIcon name="box" size={14} /> 引擎 DLC</div>
        <div className="local-note">当前环境不支持引擎渲染 DLC（仅桌面版提供）。</div>
      </div>
    )
  }

  return (
    <div className="setting-section">
      <div className="setting-title"><AppIcon name="box" size={14} /> 引擎 DLC</div>
      <div className="desc" style={{ marginBottom: 12 }}>
        本软件<strong>不提供、也不下载</strong>任何游戏引擎。这里只是一个「插座」：
        把你自己的渲染程序放进下面这个目录并授权，单位预览就能调用它来渲染，
        渲染结果与游戏里一致；没有可用 DLC 时，预览仍用内置合成。
      </div>

      <div className="setting-row">
        <span className="label">
          指定目录
          <div className="desc">
            每个 DLC 一个子目录，里面放一个 {''}
            <code>dlc.json</code> 清单和入口程序（<code>.exe</code> 或 <code>.js</code>）。
            目录名必须与清单里的 id 相同。
          </div>
        </span>
        <button className="btn primary" disabled={busy !== null} onClick={() => void openDir()}>
          <AppIcon name="folder" size={12} /> {busy === 'open' ? '打开中…' : '打开目录'}
        </button>
      </div>
      {dir && (
        <div className="local-note" style={{ wordBreak: 'break-all' }}>
          <code>{dir}</code>
        </div>
      )}

      {message && <div className="local-note community-warning">{message}</div>}

      {loading ? (
        <div className="local-note">正在读取 DLC 目录…</div>
      ) : dlcs.length === 0 ? (
        <div className="local-note">
          目录里还没有 DLC。点「打开目录」把 DLC 文件夹放进去，再回到这里刷新。
          <div style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy !== null} onClick={() => void refresh()}>刷新</button>
          </div>
        </div>
      ) : (
        <>
          <div className="setting-list">
            {dlcs.map((entry) => (
              <div key={entry.id} className="setting-row">
                <span className="label">
                  {entry.name || entry.id}
                  {entry.version && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>v{entry.version}</span>}
                  <div className="desc">
                    {entry.runnable
                      ? `${entry.description || '可用于引擎渲染'}`
                      : (entry.problem ?? '不可用')}
                  </div>
                </span>
                <button
                  className={`btn${entry.enabled ? '' : ' primary'}`}
                  disabled={busy !== null || (!entry.enabled && !entry.runnable && !entry.problem)}
                  onClick={() => void toggle(entry)}
                >
                  {busy === entry.id ? '处理中…' : entry.enabled ? '撤销授权' : '授权运行'}
                </button>
              </div>
            ))}
          </div>
          <div className="setting-row">
            <span className="label">
              刷新
              <div className="desc">放入或删除 DLC 后点这里重新扫描目录。</div>
            </span>
            <button className="btn" disabled={busy !== null} onClick={() => void refresh()}>刷新</button>
          </div>
        </>
      )}

      <div className="desc" style={{ marginTop: 12 }}>
        授权前请确认程序来源可信：被授权的 DLC 会以你的用户权限在本机运行，
        和你在终端里手动运行它是同一回事。程序文件被替换后需要重新授权。
      </div>
    </div>
  )
}
