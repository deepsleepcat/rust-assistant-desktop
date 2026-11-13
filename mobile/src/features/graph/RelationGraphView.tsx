/**
 * 关系图视图（对齐桌面端 src/features/graph/RelationGraphModal.tsx）：
 * 单位 → 图片/音效/弹体/炮塔 引用关系。
 *
 * 手机窄屏取舍：环形图只画选中单位（引用数通常 < 60），下方给完整引用清单，
 * 精确点击由清单行承担（触摸目标 44px）；悬空 / 跨模组引用单独页签给出全量清单。
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../../stores/workspace'
import { buildRelationGraph, type RefKind, type RelationGraphData, type UnitNode } from './relationGraph'
import { fileNameOf, openFileInEditor } from '../editor/openFile'
import { AppIcon } from '../../components/AppIcon'
import { joinProjectPath } from '../../utils/projectPath'

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

type GraphTab = 'graph' | 'missing' | 'crossmod'

export function RelationGraphView() {
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [data, setData] = useState<RelationGraphData | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<GraphTab>('graph')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!project) return
    let alive = true
    setData(null)
    setError('')
    setProgress(null)
    void buildRelationGraph(project.rootPath, {
      onProgress: (done, total) => {
        if (alive) setProgress({ done, total })
      },
    })
      .then((graph) => {
        if (!alive) return
        setData(graph)
        setSelected((prev) =>
          prev && graph.units.some((u) => u.file === prev) ? prev : graph.units[0]?.file ?? null,
        )
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [project?.rootPath, reloadKey])

  const units = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (!q) return data.units
    return data.units.filter((u) => u.name.toLowerCase().includes(q) || u.file.toLowerCase().includes(q))
  }, [data, query])

  const selectedUnit = useMemo(
    () => data?.units.find((u) => u.file === selected) ?? null,
    [data, selected],
  )

  /** 打开文件并定位到引用行（走统一打开入口：中文显示层/保存基准一致） */
  async function locate(file: string, line: number) {
    if (!project) return
    const result = await openFileInEditor({
      path: joinProjectPath(project.rootPath, file),
      name: fileNameOf(file),
      line: line > 0 ? line : undefined,
    })
    if (!result.ok) setError(result.error)
  }

  if (!project) {
    return (
      <div className="m-empty">
        <AppIcon name="zoom" size={36} />
        <p>先选择一个项目，再查看模组关系图</p>
      </div>
    )
  }

  const scanning = data === null && !error

  return (
    <div className="m-scroll relgraph">
      {scanning && (
        <div className="relgraph-scanning">
          <span>
            扫描中…{progress ? `${progress.done}/${progress.total} 个文件` : ''}
          </span>
          <progress value={progress?.done ?? 0} max={progress?.total ?? 1} />
        </div>
      )}

      {error && (
        <div className="relgraph-error">
          <p>构建关系图失败：{error}</p>
          <button className="m-btn" onClick={() => setReloadKey((k) => k + 1)}>
            <AppIcon name="refresh" size={16} />
            重试
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="relgraph-stats">
            <span className="relgraph-stat">单位 {data.units.length}</span>
            <span className="relgraph-stat">引用 {data.totalRefs}</span>
            <span className="relgraph-stat danger">悬空 {data.missingRefs.length}</span>
            <span className="relgraph-stat warn">跨模组 {data.crossModRefs.length}</span>
          </div>

          <div className="m-subtabs">
            <button className={tab === 'graph' ? 'active' : ''} onClick={() => setTab('graph')}>
              关系图
            </button>
            <button className={tab === 'missing' ? 'active' : ''} onClick={() => setTab('missing')}>
              悬空{data.missingRefs.length > 0 ? `（${data.missingRefs.length}）` : ''}
            </button>
            <button className={tab === 'crossmod' ? 'active' : ''} onClick={() => setTab('crossmod')}>
              跨模组{data.crossModRefs.length > 0 ? `（${data.crossModRefs.length}）` : ''}
            </button>
          </div>

          {tab === 'graph' && (
            <>
              <div className="relgraph-search">
                <AppIcon name="search" size={16} />
                <input
                  type="search"
                  placeholder="搜索单位名或文件…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

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
                {units.length === 0 && <p className="relgraph-empty">没有匹配的单位</p>}
                {units.length > 200 && (
                  <p className="relgraph-empty">共 {units.length} 个单位，仅显示前 200 个（用搜索过滤）</p>
                )}
              </div>

              {selectedUnit ? (
                <>
                  <UnitRing unit={selectedUnit} onJump={(line) => void locate(selectedUnit.file, line)} />
                  <p className="m-group-title">引用清单 · {selectedUnit.name}</p>
                  {selectedUnit.refs.map((ref, idx) => (
                    <button
                      key={`${ref.kind}-${ref.target}-${idx}`}
                      className="relgraph-ref"
                      onClick={() => void locate(selectedUnit.file, ref.lines[0])}
                    >
                      <span
                        className={`relgraph-dot${ref.missing ? ' missing' : ref.crossMod ? ' cross' : ''}`}
                        style={{ background: ref.missing ? 'var(--danger)' : ref.crossMod ? '#b26a00' : KIND_COLORS[ref.kind] }}
                      />
                      <span className="relgraph-ref-kind">{KIND_LABELS[ref.kind]}</span>
                      <span className="relgraph-ref-target">{ref.target}</span>
                      <span className={`relgraph-ref-meta${ref.missing ? ' danger' : ref.crossMod ? ' warn' : ''}`}>
                        {ref.missing ? '悬空' : ref.crossMod ? '跨模组' : `第 ${ref.lines[0]} 行`}
                      </span>
                    </button>
                  ))}
                </>
              ) : (
                <p className="relgraph-empty">选择一个单位查看引用图</p>
              )}
            </>
          )}

          {tab === 'missing' && (
            <div className="relgraph-list">
              {data.missingRefs.length === 0 ? (
                <p className="relgraph-empty">没有悬空引用 ✓</p>
              ) : (
                data.missingRefs.map((m, idx) => (
                  <button key={`${m.file}-${m.line}-${idx}`} className="relgraph-ref" onClick={() => void locate(m.file, m.line)}>
                    <span className="relgraph-dot" style={{ background: 'var(--danger)' }} />
                    <span className="relgraph-ref-kind">悬空</span>
                    <span className="relgraph-ref-target">
                      {KIND_LABELS[m.kind]}「{m.ref}」
                    </span>
                    <span className="relgraph-ref-meta">
                      {m.file}:{m.line}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {tab === 'crossmod' && (
            <div className="relgraph-list">
              {data.crossModRefs.length === 0 ? (
                <p className="relgraph-empty">没有跨模组引用（全部资源都在本项目内）✓</p>
              ) : (
                data.crossModRefs.map((c, idx) => (
                  <div key={`${c.kind}-${c.ref}-${idx}`} className="relgraph-ref static">
                    <span className="relgraph-dot" style={{ background: '#b26a00' }} />
                    <span className="relgraph-ref-kind">跨模组</span>
                    <span className="relgraph-ref-target">
                      {c.ref}
                      <small>
                        {KIND_LABELS[c.kind]} · {c.count} 处引用
                        {c.samples.length > 0 ? `（${c.samples.join('、')}）` : ''}
                      </small>
                    </span>
                  </div>
                ))
              )}
              {data.crossModRefs.length > 0 && (
                <p className="relgraph-note">
                  ROOT:/CUSTOM:/SHARED: 前缀引用其他模组/游戏内置资源，打包后需保证对应模组已安装，本项目内无法验证存在性。
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 单个单位的环形引用图（SVG 自适应窄屏；节点按类型着色，缺失红色，跨模组橙色虚线） */
function UnitRing({ unit, onJump }: { unit: UnitNode; onJump: (line: number) => void }) {
  const W = 320
  const H = 240
  const CX = W / 2
  const CY = H / 2
  const R = 88
  const MAX_NODES = 24
  const shown = unit.refs.slice(0, MAX_NODES)
  const nodes = shown.map((ref, i) => {
    const angle = (i / Math.max(shown.length, 1)) * Math.PI * 2 - Math.PI / 2
    return { ...ref, x: CX + Math.cos(angle) * R, y: CY + Math.sin(angle) * R }
  })

  return (
    <div className="relgraph-canvas">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${unit.name} 的引用关系图`}>
        {nodes.map((n, i) => (
          <line
            key={`edge-${i}`}
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
        {nodes.map((n, i) => (
          <g
            key={`node-${i}`}
            className="relgraph-node"
            role="button"
            tabIndex={0}
            aria-label={`${KIND_LABELS[n.kind]}：${n.target}${n.missing ? '（悬空）' : ''} · 第 ${n.lines.join('、')} 行`}
            onClick={() => onJump(n.lines[0])}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onJump(n.lines[0])
              }
            }}
          >
            <circle
              cx={n.x}
              cy={n.y}
              r={14}
              fill={
                n.missing
                  ? 'rgba(197,34,31,.18)'
                  : n.crossMod
                    ? 'rgba(178,106,0,.15)'
                    : `${KIND_COLORS[n.kind]}22`
              }
              stroke={n.missing ? 'var(--danger)' : n.crossMod ? '#b26a00' : KIND_COLORS[n.kind]}
              strokeWidth={n.missing || n.crossMod ? 2 : 1.4}
              strokeDasharray={n.crossMod ? '4 3' : undefined}
            />
            <text x={n.x} y={n.y + 3} textAnchor="middle" fontSize={9} fill="var(--text-primary)" style={{ pointerEvents: 'none' }}>
              {KIND_LABELS[n.kind].slice(0, 2)}
            </text>
            <title>{`${KIND_LABELS[n.kind]}：${n.target}${n.missing ? '（悬空）' : ''}${n.crossMod ? '（跨模组）' : ''} · 第 ${n.lines.join('、')} 行`}</title>
          </g>
        ))}
        <circle cx={CX} cy={CY} r={30} fill="var(--bg-active)" stroke="var(--accent)" strokeWidth={2} />
        <text x={CX} y={CY - 1} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--text-primary)" style={{ pointerEvents: 'none' }}>
          {unit.name.length > 8 ? `${unit.name.slice(0, 8)}…` : unit.name}
        </text>
        <text x={CX} y={CY + 13} textAnchor="middle" fontSize={8.5} fill="var(--text-muted)" style={{ pointerEvents: 'none' }}>
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
      {unit.refs.length > MAX_NODES && (
        <p className="relgraph-note">引用较多，环图仅绘制前 {MAX_NODES} 条；完整清单见下方。</p>
      )}
    </div>
  )
}
