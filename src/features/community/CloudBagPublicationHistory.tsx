import { useEffect, useRef, useState } from 'react'
import { PanelState } from '../../components/PanelState'
import type { CloudBagApi, CloudBagRelease, CloudBagShare } from '../../services/cloudBagApi'

/** 分享能力只由创建响应提供，历史记录不重建明文令牌。 */
export function CloudBagPublicationHistory({ api, slug, isEditor, canWrite = false, revision = 0 }: { api: CloudBagApi; slug: string; isEditor: boolean; canWrite?: boolean; revision?: number }) {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const revoke = async (action: () => Promise<unknown>) => {
    if (lock.current || !canWrite) return
    lock.current = true; setBusy(true); setActionError('')
    try { await action(); setRefresh((value) => value + 1) } catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
    finally { lock.current = false; setBusy(false) }
  }
  const [refresh, setRefresh] = useState(0)
  const [observedAt, setObservedAt] = useState(0)
  const [state, setState] = useState<{ loading: boolean; error: string; releases: CloudBagRelease[]; shares: CloudBagShare[] }>({ loading: true, error: '', releases: [], shares: [] })
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      setState({ loading: true, error: '', releases: [], shares: [] })
      setObservedAt(Date.now())
      void Promise.all([api.releases(slug), isEditor ? api.shares(slug) : Promise.resolve({ items: [] })]).then(([releases, shares]) => {
      if (alive) setState({ loading: false, error: '', releases: releases.items, shares: shares.items })
    }).catch((error) => {
      if (alive) setState({ loading: false, error: error instanceof Error ? error.message : String(error), releases: [], shares: [] })
    })
    }, 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [api, slug, isEditor, refresh, revision])
  return <section className="community-section">
    <div className="row gap-8"><strong>发布与分享记录</strong><span className="grow" /><button className="btn-sm" disabled={state.loading} onClick={() => setRefresh((value) => value + 1)}>刷新记录</button></div>
    {actionError && <div className="community-warning" role="alert">{actionError}</div>}
    {state.loading ? <PanelState kind="loading" title="读取发布与分享记录…" /> : state.error ? <PanelState kind="error" title="记录读取失败" description={state.error} /> : <>
      {!state.releases.length && <div className="local-note">暂无发布记录</div>}
      {state.releases.map((release) => <div key={release.id} className="local-note">v{release.versionNo} · {release.name || release.notes} · {release.status}{isEditor && release.status === 'published' && <button className="btn-sm" disabled={busy || !canWrite} onClick={() => { if (window.confirm('确定撤回这个发布？')) void revoke(() => api.revokeRelease(slug, release.id)) }}>撤回发布</button>}</div>)}
      {isEditor && <><div className="local-note">分享明文链接仅在创建时显示一次。以下为最近 100 条记录。</div>
        {state.shares.map((share) => <div key={share.id} className="local-note">#{share.id} · {share.versionNo == null ? 'head' : `v${share.versionNo}`} · 下载 {share.downloadCount}/{share.maxDownloads || '不限'} · {share.revokedAt ? '已撤销' : share.expiresAt && share.expiresAt * 1000 <= observedAt ? '已过期' : '有效'}{!share.revokedAt && <button className="btn-sm" disabled={busy || !canWrite} onClick={() => { if (window.confirm('确定撤销这个分享链接？')) void revoke(() => api.revokeShare(share.id)) }}>撤销分享</button>}</div>)}
      </>}
    </>}
  </section>
}
