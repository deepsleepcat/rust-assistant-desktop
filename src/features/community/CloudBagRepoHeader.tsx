import { AppIcon } from '../../components/AppIcon'
import type { CloudBagRepo } from '../../services/cloudBagApi'
import { formatBytes } from './cloudBagData'

const VISIBILITY_LABELS: Record<CloudBagRepo['visibility'], string> = { private: '私有', public: '公开', link: '链接可见' }
const REPO_TYPE_LABELS: Record<NonNullable<CloudBagRepo['repoType']>, string> = { mod: '单模组仓', collection: '模组集合仓', asset: '素材仓' }

export function CloudBagRepoHeader({ repo, onBack, deepLink, copied, onCopy, canSync, syncTitle, onSync, canStar, starBusy, onStar, onShare }: { repo: CloudBagRepo; onBack: () => void; deepLink: string; copied: boolean; onCopy: () => void; canSync: boolean; syncTitle: string; onSync: () => void; canStar: boolean; starBusy: boolean; onStar: () => void; onShare: () => void }) {
  return (
      <div className="community-card post-card cloudbag-repo-head">
        <div className="post-card-title">
          <button className="btn-sm" onClick={onBack} title="返回仓库列表">← 返回</button>
          <span>{repo.title}</span>
          <span className="badge info">{REPO_TYPE_LABELS[repo.repoType ?? 'mod'] ?? repo.repoType}</span>
          <span className="badge">{VISIBILITY_LABELS[repo.visibility] ?? repo.visibility}</span>
          {repo.myRole && <span className="badge info">{repo.myRole === 'owner' ? '所有者' : repo.myRole === 'editor' ? '编辑者' : '查看者'}</span>}
          <button className="btn cloudbag-star" aria-pressed={repo.starred ?? false} disabled={!canStar || starBusy} title={!canStar ? '登录并完成邮箱认证后可以 Star' : undefined} onClick={onStar}>{repo.starred ? '★ 已 Star' : '☆ Star'}{repo.starCount !== undefined && <span>{repo.starCount}</span>}</button>
        </div>
        <div className="post-card-meta">
          {repo.visibility === 'link' ? (
            <button className="btn-sm" onClick={onShare} title="前往版本与发布，创建带有效期的分享链接">
              复制分享链接
            </button>
          ) : (
            <button className="btn-sm" title={deepLink} onClick={onCopy}>
              {copied ? '已复制深链' : '复制深链'}
            </button>
          )}
          {' · '}{repo.versionCount} 版本 · {repo.fileCount} 文件 · {formatBytes(repo.totalSize)} · 配额 {formatBytes(repo.quota?.usedBytes ?? 0)}/{formatBytes(repo.quota?.limitBytes ?? 0)}
        </div>
        {repo.visibility === 'link' && <div className="local-note">在「版本与发布」中创建分享链接；完整链接仅在创建时显示，请及时复制。</div>}
        {repo.description && <p>{repo.description}</p>}
        <div className="mod-tags">{(repo.tags ?? []).map((tag) => <span className="badge" key={tag}>{tag}</span>)}</div>
        <div className="cloudbag-unsupported-row">
          <button className="btn primary" disabled={!canSync} title={syncTitle} onClick={onSync}>
            <AppIcon name="upload" size={12} /> 同步本地项目
          </button>
        </div>
      </div>
  )
}
