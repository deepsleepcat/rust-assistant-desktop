/**
 * M8 值类型管理弹窗：浏览全部值类型（内置 66 种 + 用户自定义），
 * 支持新增 / 编辑 / 删除自定义值类型（存本地，与内置合并供补全/lint 使用）。
 * 自定义值类型字段对齐内置结构：type / describe / rule（正则）/ list（关联列表）/ external。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ValueTypeInfo } from '../../services/codeData'
import { getAllValueTypes, getCustomValueTypes, loadCodeData, saveCustomValueTypes } from '../../services/codeData'
import { Modal } from '../../components/Modal'

interface Props {
  onClose: () => void
  onNotify?: (message: string) => void
}

interface Editing {
  original: string | null // 非 null = 编辑模式（type 锁定）
  type: string
  describe: string
  rule: string
  list: string
  external: string
}

const EMPTY_EDITING: Editing = { original: null, type: '', describe: '', rule: '', list: '', external: '' }

function isValidTypeName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

export function ValueTypeModal({ onClose, onNotify }: Props) {
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState<ValueTypeInfo[]>([])
  const [selected, setSelected] = useState<ValueTypeInfo | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void loadCodeData()
      .then(() => getCustomValueTypes())
      .then((list) => {
        if (!alive) return
        setCustom(list)
        setReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // custom 引用变化（保存/删除后 setCustom）触发重新读取合并列表：
  // getAllValueTypes 读模块级数据（reloadCodeData 后已更新），custom 是手动失效信号
  // eslint-disable-next-line react-hooks/exhaustive-deps -- custom 引用变化即需重读模块级数据
  const all = useMemo(() => (ready ? getAllValueTypes() : []), [ready, custom])
  const customNames = useMemo(() => new Set(custom.map((c) => c.type)), [custom])
  const builtinNames = useMemo(() => new Set(all.filter((v) => !customNames.has(v.type)).map((v) => v.type)), [all, customNames])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (v) =>
        v.type.toLowerCase().includes(q) ||
        (v.describe ?? '').toLowerCase().includes(q) ||
        (v.list ?? '').toLowerCase().includes(q),
    )
  }, [all, query])

  const select = (v: ValueTypeInfo) => {
    setSelected(v)
    setEditing(null)
    setError(null)
  }

  const startCreate = () => {
    setSelected(null)
    setEditing({ ...EMPTY_EDITING })
    setError(null)
  }

  const startEdit = (v: ValueTypeInfo) => {
    setSelected(null)
    setEditing({
      original: v.type,
      type: v.type,
      describe: v.describe ?? '',
      rule: v.rule ?? '',
      list: v.list ?? '',
      external: v.external ?? '',
    })
    setError(null)
  }

  const saveEdit = async () => {
    if (!editing) return
    const type = editing.type.trim()
    if (!isValidTypeName(type)) {
      setError('类型名只能包含英文字母、数字、下划线，且不能以数字开头')
      return
    }
    if (!editing.original && (customNames.has(type) || builtinNames.has(type))) {
      setError('已存在同名类型（含内置类型）')
      return
    }
    // rule 校验：能编译成正则才保存（与 lint/补全的用法一致）
    if (editing.rule.trim() && !(editing.rule.includes('@method') || canCompileRegex(editing.rule))) {
      setError(`规则不是合法的正则表达式：${editing.rule}`)
      return
    }
    const entry: ValueTypeInfo = {
      name: type,
      type,
      describe: editing.describe.trim() || undefined,
      rule: editing.rule.trim() || undefined,
      list: editing.list.trim() || undefined,
      external: editing.external.trim() || undefined,
    }
    try {
      const next = editing.original
        ? custom.map((c) => (c.type === editing.original ? entry : c))
        : [...custom, entry]
      await saveCustomValueTypes(next)
      // 先重载模块数据（合并列表含新类型）、再更新 custom 触发列表重算——
      // 顺序反了的话 memo 会先用旧数据渲染一次，列表滞后一拍
      await loadCodeData()
      setCustom(next)
      setEditing(null)
      setSelected(entry)
      onNotify?.(`已保存值类型：${type}`)
    } catch (err) {
      setError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const removeCustom = async (v: ValueTypeInfo) => {
    try {
      const next = custom.filter((c) => c.type !== v.type)
      await saveCustomValueTypes(next)
      await loadCodeData() // 删除后重载：内存合并列表不再包含该类型（补全/lint 立即生效）
      setCustom(next)
      if (selected?.type === v.type) setSelected(null)
      onNotify?.(`已删除值类型：${v.type}`)
    } catch (err) {
      setError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Modal title="值类型管理" onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 12, height: 420 }}>
        {/* 左侧：类型列表 */}
        <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="input"
            placeholder="搜索类型名 / 描述 / 关联列表"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!ready && <div className="setting-muted">加载中…</div>}
            {ready && filtered.length === 0 && <div className="setting-muted">无匹配的值类型</div>}
            {filtered.map((v) => (
              <button
                key={v.type}
                className={`list-item${selected?.type === v.type && !editing ? ' active' : ''}`}
                onClick={() => select(v)}
                style={{ textAlign: 'left' }}
              >
                <span style={{ fontWeight: 600 }}>{v.type}</span>
                {customNames.has(v.type) && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    自定义
                  </span>
                )}
                <div className="setting-muted" style={{ fontSize: 12 }}>
                  {v.describe || v.rule || v.list || '—'}
                </div>
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={startCreate}>
            + 新增自定义类型
          </button>
        </div>

        {/* 右侧：详情 / 编辑表单 */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {editing ? (
            <div className="setting-section">
              <div className="setting-title">{editing.original ? `编辑自定义类型：${editing.original}` : '新增自定义值类型'}</div>
              <Field label="类型名" desc="字母/数字/下划线，如 myTag">
                <input
                  className="input"
                  value={editing.type}
                  onChange={(e) => setEditing({ ...editing, type: e.target.value })}
                  disabled={editing.original !== null}
                />
              </Field>
              <Field label="描述" desc="在代码表/补全中展示的说明">
                <input className="input" value={editing.describe} onChange={(e) => setEditing({ ...editing, describe: e.target.value })} />
              </Field>
              <Field label="规则 rule" desc="值合法性正则（如 ^[A-Za-z0-9_]+$）；也支持 @method 动态方法">
                <input className="input" value={editing.rule} onChange={(e) => setEditing({ ...editing, rule: e.target.value })} placeholder="^[A-Za-z0-9_]+$" />
              </Field>
              <Field label="关联列表 list" desc="补全候选，逗号分隔；支持 @file(类型)/@type(类型)/@customType(类型) 指令">
                <input className="input" value={editing.list} onChange={(e) => setEditing({ ...editing, list: e.target.value })} placeholder="NONE,AUTO,@file(png)" />
              </Field>
              <Field label="后缀 external" desc="键提交后自动追加的符号（如 :）">
                <input className="input" value={editing.external} onChange={(e) => setEditing({ ...editing, external: e.target.value })} placeholder=":" />
              </Field>
              {error && <div className="setting-error">{error}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn primary" onClick={() => void saveEdit()}>
                  保存
                </button>
                <button className="btn" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : selected ? (
            <div className="setting-section">
              <div className="setting-title">
                {selected.type}
                {customNames.has(selected.type) && (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    自定义
                  </span>
                )}
              </div>
              <Row label="类型名" value={selected.type} />
              <Row label="描述" value={selected.describe} />
              <Row label="规则 rule" value={selected.rule} mono />
              <Row label="关联列表 list" value={selected.list} mono />
              <Row label="后缀 external" value={selected.external} mono />
              {customNames.has(selected.type) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn" onClick={() => startEdit(selected)}>
                    编辑
                  </button>
                  <button
                    className="btn"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => {
                      if (window.confirm(`确定删除自定义值类型「${selected.type}」？此操作不可撤销`)) {
                        void removeCustom(selected)
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="setting-muted" style={{ padding: 24 }}>
              {ready ? '选择左侧一个值类型查看详情，或点「新增自定义类型」创建' : '加载中…'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function canCompileRegex(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      <span className="label">
        {label}
        {desc && <div className="desc">{desc}</div>}
      </span>
      {children}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="setting-row">
      <span className="label">{label}</span>
      <span className="setting-muted" style={{ fontFamily: mono ? 'var(--font-mono)' : undefined, wordBreak: 'break-all' }}>
        {value || '—'}
      </span>
    </div>
  )
}
