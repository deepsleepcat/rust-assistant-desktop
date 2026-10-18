import { useRef, useState } from 'react'
import type { CloudBagApi } from '../../services/cloudBagApi'
import { getBridge } from '../../services/bridge'
import { pullRemoteVersion, writeCloudBagAnchor } from '../../services/cloudBagSync'

export function CloudBagImportButton({ api, slug, versionNo, modulePath, label = '导入到本地目录' }: { api: CloudBagApi; slug: string; versionNo: number; modulePath?: string; label?: string }) {
  const [busy, setBusy] = useState(false)
  const cancelled = useRef(false)
  const [canCancel, setCanCancel] = useState(false)
  const [notice, setNotice] = useState('')
  const run = async () => {
    if (busy) return
    cancelled.current = false
    setBusy(true)
    setCanCancel(true)
    setNotice('')
    try {
      const bridge = getBridge()
      const target = await bridge.project.openFolderDialog()
      if (!target || cancelled.current) { setNotice('已取消目录选择，未修改本地文件。'); return }
      if (!window.confirm(`将版本 #${versionNo}${modulePath ? ` 中的「${modulePath}」` : ''}导入到 ${target.rootPath}。该目录内会被替换或移走的文件先进入备份，失败自动回滚。继续？`)) { setNotice('已取消导入，未修改本地文件。'); return }
      const result = await pullRemoteVersion({ api, bridge, repoSlug: slug, rootPath: target.rootPath, onProgress: (progress) => { if (progress.phase === 'restoring') setCanCancel(false); setNotice(progress.phase === 'downloading' ? '下载版本中…' : '正在导入并保留备份…') }, isAborted: () => cancelled.current }, { versionNo, modulePath })
      if (result.status !== 'pulled') throw new Error(result.error || '导入已取消')
      let anchorNotice = ''
      // 单模组导出仅覆盖集合的一个子集，不能把它绑定为整个集合基线。
      if (modulePath === undefined) {
        try { await writeCloudBagAnchor(bridge, target.rootPath, { repoSlug: slug, baselineSeq: versionNo, baselineTreeDigest: result.treeDigest ?? '', lastSyncedAt: Math.floor(Date.now() / 1000) }) }
        catch { anchorNotice = '同步基线保存失败，下次需重新核对。' }
      }
      setNotice(`已导入 ${result.written ?? 0} 个文件；备份：${result.backupDir || '无被替换文件'}。${modulePath ? '单个模组保持独立，不绑定整套集合同步。' : ''}${anchorNotice}${result.skipped?.length ? `跳过：${result.skipped.join('、')}` : ''}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="cloudbag-download-action"><button className="btn-sm" disabled={busy} onClick={() => void run()}>{busy ? '导入中…' : label}</button>{busy && <button className="btn-sm" disabled={!canCancel} title={canCancel ? '下载完成后停止，不修改本地文件' : '本地恢复已经开始，等待完成；失败会自动回滚'} onClick={() => { cancelled.current = true; setCanCancel(false); setNotice('已请求取消；下载结束后停止，不修改本地文件。') }}>取消导入</button>}{notice && <span role="status" className="local-note">{notice}</span>}</div>
}
