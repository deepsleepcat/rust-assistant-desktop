/**
 * 关系图视图（M20，P2 任务 4）：单位 → 图片/音效/弹体/炮塔 引用关系可视化。
 * - 左侧单位列表（搜索过滤）；右侧 SVG 环形引用图，按类型着色
 * - 悬空引用（目标不存在）红色实心；跨模组引用（ROOT:/CUSTOM:/SHARED:）橙色虚线
 * - 点击引用节点跳转到引用行；「悬空引用」「跨模组引用」页签给出全量清单
 * - 大项目性能：数据分批并发扫描（进度条），图只渲染选中单位（单单位引用数
 *   通常 < 60，环形布局无压力）；单位列表按需滚动
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'
import { joinProjectPath } from '../ai/aiQualityCheck'
import { buildRelationGraph, type RefKind, type RelationGraphData, type UnitNode } from './relationGraph'

interface Props {
  onClose: () => void
}

const KIND_COLORS: Record<RefKind, string> = {
  image: '#1565c0',
  audio: '#6a4fa3',
  unit: '#188038',
  turret: '#b26a00',
}
const KIND_LABELS: Record<RefKind, string> = {
  image: '图片',
  audio: '音效',
  unit: '弹体/单位',
  turret: '炮塔',
}

export function RelationGraphModal({ onClose }: Props) {
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const jumpToFileLine = useWorkspaceStore((s) => s.jumpToFileLine)

  const [data, setData] = useState<RelationGraphData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'graph' | 'missing' | 'crossmod'>('graph')

  useEscapeHandler(onClose)

  useEffect(() => {
    if (!project) return
    let alive = true
    void buildRelationGraph(project.rootPath, {
      onProgress: (done, total) => alive && setProgress({ done, total }),
    })
      .then((g) => {
        if (!alive) return
        setData(g)
        setSelected(g.units[0]?.file ?? null)
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [project])

  // 加载中 = 数据未就绪且无错误（扫描为异步，进度经 onProgress 回调更新）
  const scanning = data === null && error === null

  const units = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (!q) return data.units
    return data.units.filter((u) => u.name.toLowerCase().includes(q) || u.file.toLowerCase().includes(q))
  }, [data, query])

  const selectedUnit = useMemo(() => data?.units.find((u) => u.file === selected) ?? null, [data, selected])

  if (!project) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card vdiff-card">
          <div className="modal-header">关系图</div>
          <div className="modal-body">
            <p className="codetable-empty">请先打开一个模组项目。</p>
          </div>
          <div className="modal-footer">
            <button className="btn primary" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    )
  }

  const jumpToRef = (unit: UnitNode, line: number) => {
    jumpToFileLine(joinProjectPath(project.rootPath, unit.file), line)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card vdiff-card relgraph-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">模组关系图 · {project.name}</div>
        <div className="modal-body vdiff-body">
          {scanning && (
            <div className="setting-row">
              <span className="label">
                扫描中…
                {progress && (
                  <div className="desc">
                    {progress.done}/{progress.total} 个文件
                  </div>
                )}
              </span>
              <div className="grow" />
              <div style={{ width: 180 }}>
                <progress value={progress?.done ?? 0} max={progress?.total ?? 1} style={{ width: '100%' }} />
              </div>
            </div>
          )}
          {error && <div className="setting-error">构建关系图失败：{error}</div>}
          {data && (
            <>
              <div className="vdiff-stats">
                <span className="vdiff-stat rep">单位 {data.units.length}</span>
                <span className="vdiff-stat add">引用 {data.totalRefs}</span>
                <span className="vdiff-stat del">悬空 {data.missingRefs.length}</span>
                <span className="vdiff-stat rep">跨模组 {data.crossModRefs.length}</span>
              </div>
              <div className="relgraph-tabs">
                <button className={tab === 'graph' ? 'active' : ''} onClick={() => setTab('graph')}>
                  关系图
                </button>
                <button className={tab === 'missing' ? 'active' : ''} onClick={() => setTab('missing')}>
                  悬空引用{data.missingRefs.length > 0 ? `（${data.missingRefs.length}）` : ''}
                </button>
                <button className={tab === 'crossmod' ? 'active' : ''} onClick={() => setTab('crossmod')}>
                  跨模组引用{data.crossModRefs.length > 0 ? `（${data.crossModRefs.length}）` : ''}
                </button>
              </div>

              {tab === 'graph' && (
                <div className="relgraph-grid">
                  <div className="relgraph-units">
                    <input
                      className="codetable-search"
                      placeholder="搜索单位…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <div className="relgraph-unit-list">
                      {units.slice(0, 200).map((u) => {
                        const missing = u.refs.filter((r) => r.missing).length
                        return (
                          <button
                            key={u.file}
                            className={`relgraph-unit${selected === u.file ? ' active' : ''}`}
                            onClick={() => setSelected(u.file)}
                          >
                            <span className="relgraph-unit-name">{u.name}</span>
                            <span className="relgraph-unit-file">{u.file}</span>
                            <span className="relgraph-unit-count">
                              {u.refs.length} 引用{missing > 0 ? ` · ${missing} 悬空` : ''}
                            </span>
                          </button>
                        )
                      })}
                      {units.length === 0 && <p className="codetable-empty">没有匹配的单位</p>}
                      {units.length > 200 && <p className="codetable-empty">…共 {units.length} 个单位，仅显示前 200 个（用搜索过滤）</p>}
                    </div>
                  </div>
                  <div className="relgraph-canvas">
                    {selectedUnit ? (
                      <UnitGraph unit={selectedUnit} onJump={(line) => jumpToRef(selectedUnit, line)} />
                    ) : (
                      <p className="codetable-empty">选择一个单位查看引用图</p>
                    )}
                  </div>
                </div>
              )}

              {tab === 'missing' && (
                <div className="relgraph-list">
                  {data.missingRefs.length === 0 ? (
                    <p className="codetable-empty">没有悬空引用 ✓</p>
                  ) : (
                    data.missingRefs.map((m, i) => (
                      <div key={i} className="vdiff-report-item must">
                        <span className="vdiff-report-kind">悬空</span>
                        <code>{m.file}:{m.line}</code>
                        <span className="vdiff-desc">
                          {KIND_LABELS[m.kind]}「{m.ref}」不存在
                        </span>
                        <span className="grow" />
                        <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => jumpToFileLine(joinProjectPath(project.rootPath, m.file), m.line)}>
                          <AppIcon name="search" size={11} /> 定位
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {tab === 'crossmod' && (
                <div className="relgraph-list">
                  {data.crossModRefs.length === 0 ? (
                    <p className="codetable-empty">没有跨模组引用（全部资源都在本项目内）✓</p>
                  ) : (
                    data.crossModRefs.map((c, i) => (
                      <div key={i} className="vdiff-report-item new">
                        <span className="vdiff-report-kind">跨模组</span>
                        <code>{c.ref}</code>
                        <span className="vdiff-desc">
                          {KIND_LABELS[c.kind]} · {c.count} 处引用{c.samples.length > 0 ? `（${c.samples.join('、')}）` : ''}
                        </span>
                      </div>
                    ))
                  )}
                  {data.crossModRefs.length > 0 && (
                    <div className="lint-evidence" style={{ marginTop: 6 }}>
                      ROOT:/CUSTOM:/SHARED: 前缀引用其他模组/游戏内置资源——打包后在游戏里必须保证对应模组已安装，这里无法在本项目内验证存在性。
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <span className="vdiff-hint">点击引用节点可跳转到引用行</span>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

/** 单个单位的环形引用图（SVG；节点按类型着色，缺失红色，跨模组橙色虚线） */
function UnitGraph({ unit, onJump }: { unit: UnitNode; onJump: (line: number) => void }) {
  const W = 620
  const H = 430
  const CX = W / 2
  const CY = H / 2
  const R = 150
  const refs = unit.refs
  const nodes = refs.map((r, i) => {
    const angle = (i / Math.max(refs.length, 1)) * Math.PI * 2 - Math.PI / 2
    return {
      ...r,
      x: CX + Math.cos(angle) * R,
      y: CY + Math.sin(angle) * R,
    }
  })
  return (
    <div className="relgraph-canvas-inner">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* 边 */}
        {nodes.map((n, i) => (
          <line
            key={`e-${i}`}
            x1={CX}
            y1={CY}
            x2={n.x}
            y2={n.y}
            stroke={n.missing ? 'var(--danger)' : n.crossMod ? '#b26a00' : KIND_COLORS[n.kind]}
            strokeWidth={1.2}
            strokeDasharray={n.crossMod ? '4 3' : undefined}
            opacity={0.65}
          />
        ))}
        {/* 引用节点 */}
        {nodes.map((n, i) => (
          <g key={`n-${i}`} className="relgraph-node" onClick={() => onJump(n.lines[0])} style={{ cursor: 'pointer' }}>
            <circle
              cx={n.x}
              cy={n.y}
              r={17}
              fill={n.missing ? 'rgba(197,34,31,.18)' : n.crossMod ? 'rgba(178,106,0,.15)' : `${KIND_COLORS[n.kind]}22`}
              stroke={n.missing ? 'var(--danger)' : n.crossMod ? '#b26a00' : KIND_COLORS[n.kind]}
              strokeWidth={n.missing || n.crossMod ? 2 : 1.4}
              strokeDasharray={n.crossMod ? '4 3' : undefined}
            />
            <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={10} fill="var(--text-primary)" style={{ pointerEvents: 'none' }}>
              {KIND_LABELS[n.kind]}
            </text>
            <title>{`${KIND_LABELS[n.kind]}：${n.target}${n.missing ? '（悬空）' : ''}${n.crossMod ? '（跨模组）' : ''} · 第 ${n.lines.join('、')} 行`}</title>
          </g>
        ))}
        {/* 中心单位 */}
        <circle cx={CX} cy={CY} r={34} fill="var(--bg-active)" stroke="var(--accent)" strokeWidth={2} />
        <text x={CX} y={CY - 2} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--text-primary)" style={{ pointerEvents: 'none' }}>
          {unit.name.length > 10 ? `${unit.name.slice(0, 10)}…` : unit.name}
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" fontSize={8.5} fill="var(--text-2)" style={{ pointerEvents: 'none' }}>
          {unit.refs.length} 引用
        </text>
      </svg>
      <div className="relgraph-legend">
        {(Object.keys(KIND_LABELS) as RefKind[]).map((k) => (
          <span key={k} className="relgraph-legend-item">
            <i style={{ background: KIND_COLORS[k] }} />
            {KIND_LABELS[k]}
          </span>
        ))}
        <span className="relgraph-legend-item">
          <i style={{ background: 'var(--danger)' }} />
          悬空
        </span>
        <span className="relgraph-legend-item">
          <i style={{ background: '#b26a00', border: '1px dashed #b26a00' }} />
          跨模组
        </span>
      </div>
    </div>
  )
}
