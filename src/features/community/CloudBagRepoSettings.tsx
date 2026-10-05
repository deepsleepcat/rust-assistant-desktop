import { useState } from 'react'
import { PanelState } from '../../components/PanelState'
import type { CloudBagApi, CloudBagRepo } from '../../services/cloudBagApi'

export function SettingsView({ api, repo, canWrite, onChanged, onDeleted }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean; onChanged: () => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(repo.title)
  const [description, setDescription] = useState(repo.description)
  const [visibility, setVisibility] = useState<CloudBagRepo['visibility']>(repo.visibility)
  const [tags, setTags] = useState((repo.tags ?? []).join(', '))
  const [postId, setPostId] = useState(repo.postId ? String(repo.postId) : '')
  const [busy, setBusy] = useState(false)
  const [destroying, setDestroying] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const isOwner = repo.myRole === 'owner'
  const save = async () => {
    // 关联帖子 id 必须校验成正整数：Number('abc')=NaN 会被序列化成 post_id:null，
    // 服务端 PostId 为 *int，null 落 nil → handler 整块跳过（no-op），界面却报「已保存」。
    // 同时明确清空语义：留空 = 发送 0，服务端按 post_id<=0 解除关联（null 无法解除）。
    const rawPostId = postId.trim()
    const postIdValue = rawPostId === '' ? 0 : Number(rawPostId)
    if (rawPostId !== '' && (!Number.isInteger(postIdValue) || postIdValue <= 0)) {
      setMessage('关联帖子 id 必须是正整数；留空表示解除关联')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await api.updateRepo(repo.slug, {
        title: title.trim(),
        description: description.trim(),
        visibility,
        tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 8),
        postId: postIdValue,
      })
      setMessage('已保存仓库设置')
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const destroy = async () => {
    // 在途守卫：删除按钮若无 in-flight 状态，连点会并发两次 deleteRepo（第二次 not_found）。
    if (destroying) return
    if (!window.confirm(`确定删除仓库「${repo.title}」吗？仓库将对成员不可见（软删除）。`)) return
    setDestroying(true)
    try {
      await api.deleteRepo(repo.slug)
      onChanged()
      // 仓库已软删除：留在详情页只会拿到 not_found。直接回列表并让列表重新取数，
      // 避免「点了删除界面没变化」，也避免列表继续显示已删除仓库。
      onDeleted()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setDestroying(false)
    }
  }
  if (!isOwner) return <PanelState kind="empty" title="仅所有者可修改仓库设置" description={`你的角色：${repo.myRole ?? '无'}。`} />
  const writeTitle = canWrite ? undefined : '请先完成邮箱认证后再管理仓库'
  return (
    <div className="cloudbag-section">
      {!canWrite && <div className="local-note community-warning">请先完成邮箱认证后再管理仓库（保存设置 / 删除仓库在认证前不可用）。</div>}
      <div className="community-form">
        <input aria-label="仓库名称" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={128} />
        <input aria-label="仓库简介" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        <select aria-label="可见性" value={visibility} onChange={(event) => setVisibility(event.target.value as CloudBagRepo['visibility'])}>
          <option value="private">私有</option>
          <option value="public">公开</option>
          <option value="link">链接可见</option>
        </select>
        <input aria-label="标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（逗号分隔，最多 8 个）" />
        <input aria-label="关联社区帖子 id" value={postId} onChange={(event) => setPostId(event.target.value)} placeholder="关联社区帖子 id（可选，单向弱关联）" />
        <div className="cloudbag-unsupported-row">
          {/* V1 未支持的能力：保留按钮以表达「曾经/将来会有」，但用 aria-disabled（而非
              disabled）——disabled 元素不可聚焦，键盘与读屏用户既取不到 title 也无法触发，
              触屏用户同样拿不到悬停提示。可聚焦 + 可读的说明行覆盖三类用户。 */}
          <button className="btn-sm" aria-disabled="true" title="未支持：网页端在线编辑仓库文件">在线编辑</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：Issue / PR 评审">Issue / PR</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：Star / Fork 社交图谱">Star / Fork</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：Wiki">Wiki</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：CI 构建">CI 构建</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：实时多人协同编辑">协同编辑</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：超过 50 MiB 的两阶段大文件上传">大文件直传</button>
        </div>
        <div className="local-note">以上 7 个入口 V1 均未支持（在线编辑 / Issue-PR / Star-Fork / Wiki / CI 构建 / 协同编辑 / 大文件直传）：按钮已停用，鼠标悬停或键盘聚焦可看到具体说明。</div>
        <div className="local-note">V1 云书包内容在服务器上为明文存储（加密属后续版本）。</div>
      </div>
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      <div className="cloudbag-unsupported-row">
        <button className="btn primary" disabled={busy || !canWrite} title={writeTitle} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}</button>
        <button className="btn-danger" disabled={busy || destroying || !canWrite} title={destroying ? '正在删除仓库…' : writeTitle} onClick={() => void destroy()}>{destroying ? '删除中…' : '删除仓库'}</button>
      </div>
    </div>
  )
}

