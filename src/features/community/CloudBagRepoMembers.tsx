import { useCallback, useEffect, useState } from 'react'
import { PanelState } from '../../components/PanelState'
import type { CloudBagApi, CloudBagRepo, CloudBagMember } from '../../services/cloudBagApi'

export function MembersView({ api, repo, canWrite }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean }) {
  const [members, setMembers] = useState<CloudBagMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteUid, setInviteUid] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('viewer')
  const [message, setMessage] = useState<string | null>(null)
  /** 正在移除的成员 id；非 null 时所有「移除」按钮禁用，避免连点并发两次 removeMember */
  const [removingId, setRemovingId] = useState<number | null>(null)
  /** 邀请在途：与 remove 同口径，避免连点并发两次 addMember（第二次重复请求/误报） */
  const [inviting, setInviting] = useState(false)
  const isOwner = repo.myRole === 'owner'
  const load = useCallback(async () => {
    // 服务端成员列表只允许 owner 读取（cloudbag_repo.go 的 CloudBagRoleOwner 档）：
    // 非 owner 不发这次必然 forbidden 的请求，直接给出说明（与网页端 hidden:!isOwner 对齐）。
    if (!isOwner) {
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.members(repo.slug)
      setMembers(result.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [api, repo.slug, isOwner])
  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(timer)
  }, [load])
  if (!isOwner) {
    return (
      <div className="cloudbag-section">
        <PanelState kind="empty" title="仅所有者可查看成员" description={`你的角色：${repo.myRole ?? '非成员'}。`} />
      </div>
    )
  }
  const invite = async () => {
    if (inviting) return
    const uid = Number(inviteUid)
    if (!Number.isInteger(uid) || uid <= 0) { setMessage('请输入有效的用户数字 id'); return }
    setInviting(true)
    try {
      await api.addMember(repo.slug, { userId: uid, role: inviteRole })
      setInviteUid('')
      setMessage('已添加成员')
      void load()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setInviting(false)
    }
  }
  const remove = async (userId: number) => {
    if (removingId !== null) return
    setRemovingId(userId)
    try {
      await api.removeMember(repo.slug, userId)
      setMessage('已移除成员')
      void load()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setRemovingId(null)
    }
  }
  return (
    <div className="cloudbag-section">
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      {loading ? <PanelState kind="loading" title="加载成员…" /> : error
        ? <PanelState kind="error" title="成员加载失败" description={error} onRetry={() => void load()} />
        : <div className="cloudbag-diff-list">
          {members.map((member) => (
            <div className="cloudbag-diff-row" key={member.userId}>
              <span>{member.displayName || member.username || `用户 ${member.userId}`}</span>
              <span className="badge">{member.role === 'owner' ? '所有者' : member.role === 'editor' ? '编辑者' : '查看者'}</span>
              <span className="grow" />
              {isOwner && member.role !== 'owner' && (
                <button
                  className="btn-sm"
                  disabled={!canWrite || removingId !== null}
                  title={!canWrite ? '请先完成邮箱认证后再管理成员' : removingId !== null ? '正在移除成员…' : '移除该成员'}
                  onClick={() => void remove(member.userId)}
                >
                  {removingId === member.userId ? '移除中…' : '移除'}
                </button>
              )}
            </div>
          ))}
        </div>}
      {isOwner && canWrite && (
        <div className="community-form">
          <input aria-label="被邀请用户 id" value={inviteUid} onChange={(event) => setInviteUid(event.target.value)} placeholder="站内用户数字 id" />
          <select aria-label="成员角色" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'editor' | 'viewer')}>
            <option value="viewer">查看者</option>
            <option value="editor">编辑者</option>
          </select>
          <button className="btn-sm" disabled={inviting} onClick={() => void invite()}>{inviting ? '邀请中…' : '邀请成员'}</button>
        </div>
      )}
    </div>
  )
}

