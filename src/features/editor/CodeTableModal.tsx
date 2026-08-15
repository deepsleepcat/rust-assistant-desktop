/**
 * 代码表浏览弹窗：左侧节列表（英文+中文），右侧该节全部代码键。
 * - 顶部搜索：按键名/中文译名/说明过滤，命中节自动保留
 * - 点击节切换右侧列表；点击代码行复制键名
 * 数据来自 codeData（与补全/翻译共用一份数据）。
 */
import { useEffect, useMemo, useState } from 'react'
import { getAllCodes, getAllSections, loadCodeData } from '../../services/codeData'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'
import { useWorkspaceStore } from '../../stores/workspace'

interface Props {
  onClose: () => void
  onCopy?: (text: string) => void
}

export function CodeTableModal({ onClose, onCopy }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>('')
  const [ready, setReady] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  useEscapeHandler(onClose)

  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => alive && setReady(true))
    return () => { alive = false }
  }, [])

  const sections = useMemo(() => {
    if (!ready) return []
    const all = getAllSections()
    const q = query.trim().toLowerCase()
    if (!q) return all
    // 过滤模式：只保留含匹配代码的节（先查代码再回查节）
    const matchedSections = new Set<string>()
    for (const c of getAllCodes()) {
      if (
        c.code.toLowerCase().includes(q) ||
        c.translate.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q)
      ) {
        if (c.section === 'all') continue
        // section 字段可能缺失（脏数据）：空保护，防弹窗崩溃
        for (const s of (c.section ?? '').split(',')) if (s) matchedSections.add(s)
      }
    }
    return all.filter((s) => matchedSections.has(s.code))
  }, [ready, query])

  const codes = useMemo(() => {
    if (!ready) return []
    const q = query.trim().toLowerCase()
    if (!selected) {
      // 未选节：直接全表搜索（有搜索词时展示命中；无搜索词时提示选节）
      if (!q) return []
      return getAllCodes().filter(
        (c) =>
          c.code.toLowerCase().includes(q) ||
          c.translate.toLowerCase().includes(q) ||
          (c.description ?? '').toLowerCase().includes(q),
      )
    }
    const list = getAllCodes().filter((c) => (c.section ?? '').split(',').includes(selected) || c.section === 'all')
    if (!q) return list
    return list.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.translate.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q),
    )
  }, [ready, query, selected])

  const copy = (text: string) => {
    if (onCopy) {
      onCopy(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1200)
      return
    }
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card codetable-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">代码表</div>
        <div className="modal-body codetable-body">
          <input
            className="codetable-search"
            placeholder="搜索键名 / 中文译名 / 说明（如 血量、maxHp）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {!ready ? (
            <p className="codetable-empty">正在加载代码表…</p>
          ) : (
            <div className="codetable-grid">
              <div className="codetable-sections">
                {sections.map((s) => (
                  <button
                    key={s.code}
                    className={`codetable-section${selected === s.code ? ' active' : ''}`}
                    onClick={() => setSelected(s.code)}
                  >
                    <span className="ct-sec-code">{s.code}</span>
                    {s.translate && <span className="ct-sec-zh">{s.translate}</span>}
                  </button>
                ))}
                {sections.length === 0 && <p className="codetable-empty">没有匹配的节</p>}
              </div>
              <div className="codetable-codes">
                {!selected && !query && (
                  <p className="codetable-empty">选择一个节查看代码键，或直接搜索。</p>
                )}
                {codes.map((c) => (
                  <button key={c.code} className="codetable-code" onClick={() => copy(c.code)} title="点击复制键名">
                    <span className="ct-code-name">
                      {c.code}
                      {c.translate && <span className="ct-code-zh">{c.translate}</span>}
                    </span>
                    <span className="ct-code-type">{c.type}</span>
                    <span className="ct-code-desc">{c.description}</span>
                  </button>
                ))}
                {codes.length === 0 && selected && <p className="codetable-empty">该节没有匹配的代码</p>}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {copied && <span className="codetable-copied"><AppIcon name="check" size={12} /> 已复制 {copied}</span>}
          <span className="grow" />
          {/* M17：版本差异对比（P2 任务 1）——叠加在代码表之上，Esc 先关差异视图 */}
          <button className="btn" onClick={() => useWorkspaceStore.getState().setVersionDiffOpen(true)} title="对比两个游戏版本的字段差异">
            版本差异…
          </button>
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
