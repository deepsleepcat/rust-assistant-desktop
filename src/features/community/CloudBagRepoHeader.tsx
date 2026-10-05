import { AppIcon } from '../../components/AppIcon'
import type { CloudBagRepo } from '../../services/cloudBagApi'
import { formatBytes } from './cloudBagData'

const VISIBILITY_LABELS: Record<CloudBagRepo['visibility'], string> = { private: '私有', public: '公开', link: '链接可见' }

export function CloudBagRepoHeader({ repo, onBack, deepLink, copied, onCopy, canSync, syncTitle, onSync }: { repo: CloudBagRepo; onBack: () => void; deepLink: string; copied: boolean; onCopy: () => void; canSync: boolean; syncTitle: string; onSync: () => void }) {
  return (
      <div className="community-card post-card cloudbag-repo-head">
        <div className="post-card-title">
          <button className="btn-sm" onClick={onBack} title="返回仓库列表">← 返回</button>
          <span>{repo.title}</span>
          <span className="badge">{VISIBILITY_LABELS[repo.visibility] ?? repo.visibility}</span>
          {repo.myRole && <span className="badge info">{repo.myRole === 'owner' ? '所有者' : repo.myRole === 'editor' ? '编辑者' : '查看者'}</span>}
        </div>
        <div className="post-card-meta">
          {repo.visibility === 'link' ? (
            // link 可见性必须携带一次性分享 token 才能被他人读取；桌面 V1 未支持创建分享，
            // 这里显式停用并说明，而不是复制一条对接收者无效的深链
            <button className="btn-sm" aria-disabled="true" title="链接可见仓库需要一次性分享 token（桌面端 V1 未支持创建分享，请在社区网页创建）">
              <AppIcon name="link" size={12} /> {repo.slug}
            </button>
          ) : (
            <button className="btn-sm" title={deepLink} onClick={onCopy}>
              <AppIcon name="link" size={12} /> {copied ? '已复制深链' : repo.slug}
            </button>
          )}
          {' · '}{repo.versionCount} 版本 · {repo.fileCount} 文件 · {formatBytes(repo.totalSize)} · 配额 {formatBytes(repo.quota?.usedBytes ?? 0)}/{formatBytes(repo.quota?.limitBytes ?? 0)}
        </div>
        {repo.visibility === 'link' && <div className="local-note">链接可见仓库的分享链接需要一次性 token；桌面 V1 未支持创建分享，请到社区网页创建后再分发。</div>}
        {repo.description && <p>{repo.description}</p>}
        <div className="mod-tags">{(repo.tags ?? []).map((tag) => <span className="badge" key={tag}>{tag}</span>)}</div>
        <div className="cloudbag-unsupported-row">
          <button className="btn primary" disabled={!canSync} title={syncTitle} onClick={onSync}>
            <AppIcon name="upload" size={12} /> 发布新版本 / 拉取
          </button>
          {/* 未支持入口同样用 aria-disabled：键盘/读屏/触屏用户都能取到原因文字 */}
          <button className="btn-sm" aria-disabled="true" title="未支持：自动同步与文件监听（V1 仅手动同步）">自动同步</button>
          {/* V1 降级（契约 §1.1）：发布（releases）/分享仅网页端可用。可聚焦 + 说明行
              指路，避免只想「发布 release」的桌面用户在应用内找不到任何线索。 */}
          <button className="btn-sm" aria-disabled="true" title={`未支持：发布（releases）与分享链接请在社区网页操作 ${deepLink}`}>发布 / 分享（网页端）</button>
        </div>
        <div className="local-note">桌面 V1 未支持：自动同步与文件监听；发布（releases）与分享链接请到社区网页操作 {deepLink}</div>
      </div>
  )
}
