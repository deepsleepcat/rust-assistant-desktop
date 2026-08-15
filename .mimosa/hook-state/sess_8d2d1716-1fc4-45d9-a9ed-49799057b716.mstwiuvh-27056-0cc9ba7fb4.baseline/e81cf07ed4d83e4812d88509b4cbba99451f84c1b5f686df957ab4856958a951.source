/**
 * 模板库管理（M23，P3 任务 2）：本地模板浏览/分类/导入管理。
 * - 浏览：全部模板（内置包 + 用户目录），按来源分类（内置/我的），搜索过滤
 * - 导入：系统对话框选 .json 模板文件 → 校验 → 复制进用户模板目录（同名自动加序号）
 * - 删除：仅用户模板可删（内置模板随应用分发，不可删）
 * - 模板文件随应用分发，不做在线市场
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'
import { getBridge } from '../../services/bridge'
import type { TemplateMeta } from '../../types/mod'

interface Props {
  onClose: () => void
}

export function TemplateLibraryModal({ onClose }: Props) {
  const notify = useWorkspaceStore((s) => s.notify)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(null)
  const [userKeys, setUserKeys] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEscapeHandler(onClose)

  const load = async (): Promise<void> => {
    try {
      const [list, keys] = await Promise.all([getBridge().mod.listTemplates(), getBridge().mod.listUserTemplateKeys()])
      setTemplates(list)
      setUserKeys(new Set(keys))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    let alive = true
    void Promise.all([getBridge().mod.listTemplates(), getBridge().mod.listUserTemplateKeys()])
      .then(([list, keys]) => {
        if (!alive) return
        setTemplates(list)
        setUserKeys(new Set(keys))
        setError(null)
      })
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [])

  const filtered = useMemo(() => {
    if (!templates) return []
    const q = query.trim().toLowerCase()
    if (!q) return templates
    return templates.filter((t) => t.name.toLowerCase().includes(q) || t.nameEn.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
  }, [templates, query])

  const importTemplate = async () => {
    try {
      const meta = await getBridge().mod.importTemplate()
      if (!meta) return // 用户取消
      notify(`已导入模板「${meta.name}」（${meta.key}）`)
      await load()
    } catch (err) {
      notify(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const removeTemplate = (meta: TemplateMeta) => {
    requestConfirm({
      title: '删除模板',
      message: `确定删除用户模板「${meta.name}」（${meta.key}.json）吗？删除后不可恢复。`,
      danger: true,
      confirmText: '删除',
      onConfirm: async () => {
        const r = await getBridge().mod.deleteUserTemplate(meta.key)
        if (r.ok) {
          notify(`已删除模板「${meta.name}」`)
          await load()
        } else {
          notify(`删除失败：${r.message ?? '未知错误'}`)
        }
      },
    })
  }

  const userCount = templates?.filter((t) => userKeys.has(t.key)).length ?? 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card vdiff-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">模板库（本地）</div>
        <div className="modal-body vdiff-body">
          <div className="vdiff-toolbar">
            <input
              className="codetable-search"
              style={{ flex: 1 }}
              placeholder="搜索模板名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="btn primary" onClick={() => void importTemplate()}>
              <AppIcon name="add" size={12} /> 导入模板…
            </button>
          </div>
          <div className="vdiff-stats">
            <span className="vdiff-stat rep">全部 {templates?.length ?? '…'}</span>
            <span className="vdiff-stat add">内置 {templates ? templates.length - userCount : '…'}</span>
            <span className="vdiff-stat del">我的 {userCount}</span>
            <span className="grow" />
            <span className="vdiff-hint">模板文件随应用分发，导入的模板保存在本机用户目录（不做在线市场）</span>
          </div>
          {error && <div className="setting-error">加载失败：{error}</div>}
          <div className="relgraph-list">
            {templates === null ? (
              <p className="codetable-empty">加载中…</p>
            ) : filtered.length === 0 ? (
              <p className="codetable-empty">没有匹配的模板</p>
            ) : (
              filtered.map((t) => {
                const isUser = userKeys.has(t.key)
                return (
                  <div key={t.key} className={`vdiff-report-item ${isUser ? 'new' : ''}`} style={{ alignItems: 'center' }}>
                    <span className={`vdiff-report-kind ${isUser ? '' : 'rep'}`}>{isUser ? '我的' : '内置'}</span>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{t.name}</span>
                    {t.nameEn && <span className="vdiff-desc">{t.nameEn}</span>}
                    <code style={{ fontSize: 10.5 }}>{t.key}.json</code>
                    <span className="vdiff-desc">{t.actions.length} 个输入项</span>
                    <span className="grow" />
                    {isUser && (
                      <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => removeTemplate(t)}>
                        <AppIcon name="delete" size={11} /> 删除
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
        <div className="modal-footer">
          <span className="vdiff-hint">「新建单位」里的模板选择也会用到这些模板</span>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
