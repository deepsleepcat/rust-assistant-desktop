import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudBagApi, CloudBagIssue, CloudBagIssueComment, CloudBagRepo } from '../../services/cloudBagApi'
import { useWorkspaceStore } from '../../stores/workspace'
import { PanelState } from '../../components/PanelState'

export function CloudBagIssues({ api, repo, canWrite, onChanged }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean; onChanged: () => void }) {
  const userId = useWorkspaceStore((s) => s.communityAuth.user?.id)
  const maintainer = repo.myRole === 'owner' || repo.myRole === 'editor'
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<CloudBagIssue[]>([])
  const [issue, setIssue] = useState<CloudBagIssue | null>(null)
  const [comments, setComments] = useState<CloudBagIssueComment[]>([])
  const [commentPage, setCommentPage] = useState(1)
  const [commentTotal, setCommentTotal] = useState(0)
  const [compose, setCompose] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [comment, setComment] = useState('')
  const [editingComment, setEditingComment] = useState<number | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef(false)
  const generation = useRef(0)
  const issueOp = useRef<{ content: string; id: string } | null>(null)
  const commentOp = useRef<{ content: string; id: string } | null>(null)
  const load = useCallback(async () => {
    const epoch = ++generation.current
    setLoading(true)
    setError(null)
    try {
      if (issue) {
        const [next, replies] = await Promise.all([api.issue(repo.slug, issue.number), api.issueComments(repo.slug, issue.number, commentPage)])
        if (epoch !== generation.current) return
        setIssue(next); setComments(replies.items); setCommentTotal(replies.total ?? 0)
      } else {
        const result = await api.issues(repo.slug, { state, q: search, page })
        if (epoch !== generation.current) return
        setItems(result.items); setTotal(result.total ?? 0)
      }
    } catch (err) { if (epoch === generation.current) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (epoch === generation.current) setLoading(false) }
  }, [api, repo.slug, state, search, page, issue?.number, commentPage]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const requestGeneration = generation
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => { window.clearTimeout(timer); requestGeneration.current++ }
  }, [load])
  async function run(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true; setBusy(true); setError(null)
    try { await action(); onChanged() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { operation.current = false; setBusy(false) }
  }
  function op(ref: typeof issueOp, content: string) {
    if (ref.current?.content !== content) ref.current = { content, id: crypto.randomUUID() }
    return ref.current!.id
  }
  const date = (value: number) => new Date(value * 1000).toLocaleString()
  const author = issue?.authorUserId === userId
  return <section className="cloudbag-issues">
    {error && <div className="community-warning" role="alert">{error}<button className="btn-sm" onClick={() => void load()}>重试加载</button></div>}
    {!issue && <>
      <div className="cloudbag-issue-toolbar"><form className="community-inline-form" onSubmit={(event) => { event.preventDefault(); setSearch(query); setPage(1) }}><input aria-label="搜索 Issues" placeholder="搜索问题标题" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={80} /><button className="btn" type="submit">搜索</button></form><select aria-label="问题状态" value={state} onChange={(event) => { setState(event.target.value as typeof state); setPage(1) }}><option value="open">未关闭</option><option value="closed">已关闭</option><option value="all">全部</option></select><button className="btn" disabled={!canWrite || busy} onClick={() => { setCompose(true); setTitle(''); setBody('') }}>新建 Issue</button></div>
      {compose && <form className="community-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { const next = await api.createIssue(repo.slug, { title: title.trim(), body, clientOpId: op(issueOp, JSON.stringify([title.trim(), body])) }); issueOp.current = null; setIssue(next); setCompose(false); setCommentPage(1) }) }}><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required /></label><label>问题描述<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={32000} rows={7} required /></label><div className="cloudbag-actions"><button className="btn" type="button" disabled={busy} onClick={() => setCompose(false)}>取消</button><button className="btn" type="submit" disabled={busy || !title.trim() || !body.trim() || !canWrite}>提交问题</button></div></form>}
      {loading ? <PanelState kind="loading" title="加载 Issues…" /> : !error && items.length === 0 ? <PanelState kind="empty" title="暂无符合条件的问题" /> : <div className="cloudbag-issue-list">{items.map((item) => <button className="cloudbag-issue-row" key={item.id} onClick={() => { setIssue(item); setCommentPage(1); setCompose(false); setEditing(false) }}><span className="badge">{item.state === 'open' ? '未关闭' : '已关闭'}</span><span><strong>{item.title}</strong><small>#{item.number} · 用户 {item.authorUserId} · {date(item.createdAt)}</small></span></button>)}</div>}
      <div className="cloudbag-actions"><button className="btn" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page} 页 · 共 {total} 个问题</span><button className="btn" disabled={page * 20 >= total || loading} onClick={() => setPage(page + 1)}>下一页</button></div>
    </>}
    {issue && <>
      <button className="btn" disabled={busy} onClick={() => { setIssue(null); setEditing(false); setComment('') }}>返回 Issues</button>
      <article className="cloudbag-issue-detail"><h2>{issue.title} <span className="muted">#{issue.number}</span></h2><div className="post-card-meta">{issue.state === 'open' ? '未关闭' : '已关闭'} · 用户 {issue.authorUserId} · {date(issue.createdAt)}</div>
      {editing ? <form className="community-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { setIssue(await api.updateIssue(repo.slug, issue.number, { title, body })); setEditing(false) }) }}><label>标题<input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} required /></label><label>正文<textarea value={body} maxLength={32000} rows={7} onChange={(event) => setBody(event.target.value)} required /></label><div className="cloudbag-actions"><button className="btn" disabled={busy || !canWrite || !title.trim() || !body.trim()}>保存</button><button className="btn" type="button" onClick={() => setEditing(false)}>取消</button></div></form> : <p className="cloudbag-issue-body">{issue.body}</p>}
      <div className="cloudbag-actions">{canWrite && author && <button className="btn" disabled={busy} onClick={() => { setTitle(issue.title); setBody(issue.body); setEditing(true) }}>编辑</button>}{canWrite && (author || maintainer) && <><button className="btn" disabled={busy} onClick={() => void run(async () => { setIssue(await api.updateIssue(repo.slug, issue.number, { state: issue.state === 'open' ? 'closed' : 'open' })) })}>{issue.state === 'open' ? '关闭问题' : '重新打开'}</button><button className="btn danger" disabled={busy} onClick={() => { if (window.confirm('确定删除这个问题？')) void run(async () => { await api.deleteIssue(repo.slug, issue.number); setIssue(null) }) }}>删除问题</button></>}</div></article>
      {loading ? <PanelState kind="loading" title="加载评论…" /> : comments.map((reply) => <article className="cloudbag-issue-comment" key={reply.id}><div className="post-card-meta">用户 {reply.authorUserId} · {date(reply.createdAt)}</div>{editingComment === reply.id ? <form className="community-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.updateIssueComment(repo.slug, issue.number, reply.id, commentDraft); setEditingComment(null); await load() }) }}><textarea aria-label="编辑评论" value={commentDraft} maxLength={32000} rows={4} onChange={(event) => setCommentDraft(event.target.value)} /><div className="cloudbag-actions"><button className="btn" disabled={busy || !canWrite || !commentDraft.trim()}>保存</button><button className="btn" type="button" onClick={() => setEditingComment(null)}>取消</button></div></form> : <p className="cloudbag-issue-body">{reply.body}</p>}<div className="cloudbag-actions">{canWrite && reply.authorUserId === userId && <button className="btn-sm" disabled={busy} onClick={() => { setEditingComment(reply.id); setCommentDraft(reply.body) }}>编辑</button>}{canWrite && (reply.authorUserId === userId || maintainer) && <button className="btn-sm" disabled={busy} onClick={() => { if (window.confirm('确定删除这条评论？')) void run(async () => { await api.deleteIssueComment(repo.slug, issue.number, reply.id); await load() }) }}>删除</button>}</div></article>)}
      <div className="cloudbag-actions"><button className="btn" disabled={commentPage <= 1 || loading} onClick={() => setCommentPage(commentPage - 1)}>上一页评论</button><span>{commentTotal} 条评论</span><button className="btn" disabled={commentPage * 20 >= commentTotal || loading} onClick={() => setCommentPage(commentPage + 1)}>下一页评论</button></div>
      {canWrite && <form className="community-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.createIssueComment(repo.slug, issue.number, { body: comment, clientOpId: op(commentOp, JSON.stringify([issue.number, comment])) }); commentOp.current = null; setComment(''); await load() }) }}><label>添加评论<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={32000} rows={4} required /></label><button className="btn" disabled={busy || !comment.trim()}>发表评论</button></form>}
    </>}
  </section>
}
