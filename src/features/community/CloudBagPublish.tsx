import { useRef, useState } from 'react'
import type { CloudBagApi, CloudBagRepo, CloudBagShare } from '../../services/cloudBagApi'

export function CloudBagPublish({ api, repo, canWrite, onChanged }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean; onChanged: () => void }) {
  const [version, setVersion] = useState(repo.headVersionNo)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [days, setDays] = useState(7)
  const [share, setShare] = useState<CloudBagShare | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const validVersion = Number.isInteger(version) && version > 0 && version <= repo.headVersionNo
  async function run(action: () => Promise<void>) {
    if (lock.current || !canWrite) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try { await action(); onChanged() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { lock.current = false; setBusy(false) }
  }
  const shareUrl = share?.url || (share?.token ? `${new URL(api.endpoint).origin}/community/repos/${encodeURIComponent(repo.slug)}?share=${encodeURIComponent(share.token)}` : '')
  return <section className="cloudbag-section">
    <h3>发布与分享</h3>
    <p className="local-note">选择一个已同步版本正式发布，或创建有有效期的分享链接。</p>
    {error && <div className="community-warning" role="alert">{error}</div>}
    {message && <div className="local-note" role="status">{message}</div>}
    <form className="community-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.createRelease(repo.slug, { versionNo: version, name: name.trim(), notes }); setMessage(`已发布版本 #${version}`); setName(''); setNotes('') }) }}>
      <label>版本号<input type="number" min={1} max={repo.headVersionNo} value={version || ''} onChange={(event) => setVersion(Number(event.target.value))} required /></label>
      <label>发布名称<input value={name} maxLength={128} onChange={(event) => setName(event.target.value)} placeholder="例如：1.0 正式版" /></label>
      <label>更新说明<textarea value={notes} maxLength={16000} rows={5} onChange={(event) => setNotes(event.target.value)} /></label>
      <button className="btn primary" type="submit" disabled={busy || !canWrite || !validVersion}>发布 Release</button>
    </form>
    <div className="community-form"><label>分享有效期<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option></select></label><button className="btn" disabled={busy || !canWrite || !validVersion} onClick={() => void run(async () => { setShare(await api.createShare(repo.slug, { versionNo: version, expiresInDays: days })) })}>为所选版本创建分享链接</button></div>
    {share && <div className="community-form"><label>分享链接（仅本次显示）<input value={shareUrl} readOnly aria-label="新创建的分享链接" /></label><div className="cloudbag-actions"><button className="btn" disabled={!shareUrl} onClick={() => { void navigator.clipboard.writeText(shareUrl).then(() => setMessage('分享链接已复制')).catch(() => setError('复制失败，请手动复制链接')) }}>复制链接</button><button className="btn" disabled={busy || !canWrite} onClick={() => void run(async () => { await api.revokeShare(share.id); setShare(null); setMessage('分享链接已撤销') })}>撤销分享</button><button className="btn" onClick={() => setShare(null)}>隐藏链接</button></div></div>}
  </section>
}
