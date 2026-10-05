import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import type { CloudBagApi, CloudBagRepo, CloudBagVersion, CloudBagDiffEntry } from '../../services/cloudBagApi'
import { formatBytes, summarizeDiff } from './cloudBagData'
import { getBridge } from '../../services/bridge'

function DiffModal({ api, slug, versionNo, against, onClose }: {
  api: CloudBagApi
  slug: string
  versionNo: number
  against: number
  onClose: () => void
}) {
  const [entries, setEntries] = useState<CloudBagDiffEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.diff(slug, versionNo, against).then((result) => alive && setEntries(result)).catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => { alive = false }
  }, [api, slug, versionNo, against])
  return (
    <Modal wide title={`版本 #${versionNo} 与 #${against} 差异`} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      {error && <PanelState kind="error" title="差异读取失败" description={error} />}
      {!error && entries === null && <PanelState kind="loading" title="读取差异…" />}
      {!error && entries !== null && (
        <>
          <div className="local-note">{summarizeDiff(entries)}</div>
          <div className="cloudbag-diff-list">
            {entries.map((entry) => (
              <div className="cloudbag-diff-row" key={`${entry.change}:${entry.path}`}>
                <span className={`badge${entry.change === 'added' ? ' success' : entry.change === 'removed' ? ' warning' : ''}`}>{entry.change === 'added' ? '新增' : entry.change === 'removed' ? '删除' : '修改'}</span>
                <span>{entry.path}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

export function VersionsView({ api, repo, canWrite, onChanged }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean; onChanged: () => void }) {
  const [versions, setVersions] = useState<CloudBagVersion[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffAgainst, setDiffAgainst] = useState<{ versionNo: number; against: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** 请求代际守卫（对照 CloudBagRepoView.treeGeneration）：快速双击「加载更多版本」会并发
   *  两次同 cursor 请求，两次都走 append 分支各追加一遍 → versions 重复、key=version.id 重复。
   *  只让最新一次请求落地，旧响应/旧错误一律丢弃。 */
  const generation = useRef(0)
  const load = useCallback(async (cursorValue: string | null) => {
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await api.versions(repo.slug, cursorValue ?? undefined)
      if (gen !== generation.current) return
      setVersions((current) => cursorValue ? [...current, ...(result.items ?? [])] : (result.items ?? []))
      setNextCursor(result.nextCursor ?? null)
    } catch (err) {
      if (gen !== generation.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [api, repo.slug])
  useEffect(() => {
    const timer = setTimeout(() => { void load(null) }, 0)
    return () => clearTimeout(timer)
  }, [load])
  const download = async (versionNo: number) => {
    try {
      setMessage(null)
      const save = getBridge().cloudbag?.saveRwmod
      if (!save) throw new Error('需要更新桌面版才能保存云书包（缺少保存能力）')
      const { bytes, filename } = await api.exportRwmod(repo.slug, versionNo)
      const saved = await save(filename, bytes)
      setMessage(saved.canceled ? '已取消保存。' : `已保存 ${saved.filePath}。可经「模组工具 → 导入」导入为本地项目。`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  const rollback = async (versionNo: number) => {
    if (!window.confirm(`回滚会创建一个新版本（复制 #${versionNo} 的文件树），历史不会被改写。继续？`)) return
    try {
      const result = await api.pushVersion(repo.slug, {
        baseVersionNo: repo.headVersionNo,
        message: `revert of #${versionNo}`,
        clientOpId: crypto.randomUUID().replace(/-/g, ''),
        files: [],
        restoreFrom: versionNo,
      })
      setMessage(`已创建回滚版本 #${result.versionNo}`)
      void load(null)
      // 回滚会改变 head：不刷新 repo 元数据会让 head 徽标停在旧版本，
      // 下一次回滚/发布还会带过期 baseVersionNo 被服务端乐观锁判为 version_conflict
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="cloudbag-section">
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      {loading && versions.length === 0 ? <PanelState kind="loading" title="加载版本列表…" /> : error
        ? <PanelState kind="error" title="版本列表加载失败" description={error} onRetry={() => void load(null)} />
        : versions.length === 0
          ? <PanelState kind="empty" icon="file" title="还没有版本" description="从当前项目或 .rwmod 导入并提交第一个版本。" />
          : <>
            <div className="cloudbag-version-list">
              {versions.map((version) => (
                <div className="community-card post-card" key={version.id}>
                  <div className="post-card-title"><span>#{version.versionNo} · {version.message}</span>{version.versionNo === repo.headVersionNo && <span className="badge success">head</span>}</div>
                  <div className="post-card-meta">{version.manifest?.title || '未命名模组'} · {version.manifest?.version || '无版本号'} · {version.fileCount} 文件 · {formatBytes(version.totalSize)} · {new Date(version.createdAt * 1000).toLocaleString()}</div>
                  {version.manifest?.brokenRefs?.length > 0 && <div className="local-note">引用缺失警告：{version.manifest.brokenRefs.join('、')}</div>}
                  <div className="post-card-foot">
                    <span className="post-card-meta">{version.parentVersionNo ? `父版本 #${version.parentVersionNo}` : '初始版本'}</span>
                    <span className="grow" />
                    {version.parentVersionNo !== null && <button className="btn-sm" onClick={() => setDiffAgainst({ versionNo: version.versionNo, against: version.parentVersionNo! })}>查看差异</button>}
                    <button className="btn-sm" onClick={() => void download(version.versionNo)}>下载 .rwmod</button>
                    {canWrite && version.versionNo !== repo.headVersionNo && <button className="btn-sm" onClick={() => void rollback(version.versionNo)}>回滚到此版本</button>}
                  </div>
                </div>
              ))}
            </div>
            {nextCursor && <button className="btn" disabled={loading} onClick={() => void load(nextCursor)}>加载更多版本</button>}
          </>}
      {diffAgainst && <DiffModal api={api} slug={repo.slug} versionNo={diffAgainst.versionNo} against={diffAgainst.against} onClose={() => setDiffAgainst(null)} />}
    </div>
  )
}

