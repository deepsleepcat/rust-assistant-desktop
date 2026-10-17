import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import {
  createDashboardApi,
  DashboardApiError,
  type DashboardData,
  type DashboardLayout,
  type DashboardRange,
  type DashboardSlot,
  type DashboardSummary,
} from '../../services/dashboardApi'
import {
  balanceText,
  cachePieSegments,
  chartValues,
  CHART_OPTIONS,
  COUNT_LABELS,
  coverageLabel,
  DEFAULT_LAYOUT,
  fieldCoverageLabel,
  formatCount,
  normalizeLayout,
  RANGE_OPTIONS,
  reasoningLabel,
  swapSlots,
  usageSourceLabel,
  type ChartMode,
} from './dashboardModel'
import '../../styles/dashboard.css'

/**
 * 仪表盘工作面（无 props）。
 * - 数据只来自真实后端：真实余额（计费额度）、准确输入/输出/缓存 Token、调用日志；
 * - 不显示“剩余 Token”，也没有任何占位/演示数值；
 * - 两小部件支持按钮/键盘/右键交换，交换后立即自动保存到账号（无保存按钮），
 *   失败回退默认布局并明确提示；账号切换取消旧请求，避免串号。
 */

const EMPTY_SUMMARY: DashboardSummary = {
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
  requestCount: 0, exactRequestCount: 0, coverage: 'unavailable', reason: '尚未加载数据',
  fieldCoverage: {
    inputTokens: { exactRequestCount: 0, coverage: 'unavailable' },
    outputTokens: { exactRequestCount: 0, coverage: 'unavailable' },
    cacheReadTokens: { exactRequestCount: 0, coverage: 'unavailable' },
    cacheWriteTokens: { exactRequestCount: 0, coverage: 'unavailable' },
  },
}

type WidgetMenu = { slot: DashboardSlot; x: number; y: number } | null

function signedIn(state: string): boolean {
  return state === 'signed_in'
}

export function DashboardPanel() {
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const settings = useWorkspaceStore((s) => s.settings)
  const loginCommunity = useWorkspaceStore((s) => s.loginCommunity)
  const notify = useWorkspaceStore((s) => s.notify)

  const accountId = communityAuth.user?.id ?? null
  const online = signedIn(communityAuth.status) && accountId !== null

  const [data, setData] = useState<DashboardData | null>(null)
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_LAYOUT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [range, setRange] = useState<DashboardRange>('7d')
  const [chartMode, setChartMode] = useState<ChartMode>('line')
  const [page, setPage] = useState(1)
  const [menu, setMenu] = useState<WidgetMenu>(null)

  const loadGeneration = useRef(0)
  const accountSignal = useRef<AbortController | null>(null)
  const savedLayoutSeq = useRef(0)
  const layoutQueue = useRef<Promise<unknown>>(Promise.resolve())
  const layoutAccount = useRef(0)
  const layoutAbort = useRef<AbortController | null>(null)
  const layoutIdentity = useRef<{ accountId: typeof accountId; endpoint: string } | null>(null)

  // Hidden Activity effects are paused, but queued callbacks can still run. Check
  // the live store before sending a queued write or accepting a response.
  const isCurrentIdentity = useCallback(() => {
    const state = useWorkspaceStore.getState()
    return signedIn(state.communityAuth.status)
      && state.communityAuth.user?.id === accountId
      && state.settings.ai.communityEndpoint === settings.ai.communityEndpoint
  }, [accountId, settings.ai.communityEndpoint])

  const api = useMemo(
    () => createDashboardApi(settings.ai.communityEndpoint, {
      onUnauthorized: () => { void useWorkspaceStore.getState().refreshCommunityAuth() },
    }),
    [settings.ai.communityEndpoint],
  )

  const cancelAccountRequests = useCallback(() => {
    accountSignal.current?.abort()
    accountSignal.current = null
    loadGeneration.current += 1
  }, [])

  const refresh = useCallback(async (nextRange: DashboardRange, nextPage: number) => {
    if (!online) return
    const generation = ++loadGeneration.current
    accountSignal.current?.abort()
    const controller = new AbortController()
    accountSignal.current = controller
    const isCurrent = () => generation === loadGeneration.current && isCurrentIdentity()
    setLoading(true)
    setError(null)
    try {
      const dashboard = await api.dashboard(nextRange, { signal: controller.signal })
      if (!isCurrent()) return
      let logs = dashboard.logs
      if (nextPage !== 1 || logs.page !== nextPage) {
        logs = await api.logs(nextRange, nextPage, logs.pageSize, { signal: controller.signal })
        if (!isCurrent()) return
      }
      setData({ ...dashboard, logs })
      setPage(logs.page)
      const layoutSeq = savedLayoutSeq.current
      try {
        await layoutQueue.current.catch(() => undefined)
        if (!isCurrent()) return
        const loaded = await api.layout({ signal: controller.signal })
        if (!isCurrent()) return
        if (layoutSeq === savedLayoutSeq.current) setLayout(normalizeLayout(loaded))
      } catch (layoutError) {
        if (!isCurrent()) return
        if (layoutSeq === savedLayoutSeq.current) {
          setLayout(DEFAULT_LAYOUT)
          setNotice(`布局读取失败，已显示默认位置：${layoutError instanceof Error ? layoutError.message : String(layoutError)}`)
        }
      }
      setLoading(false)
    } catch (err) {
      if (!isCurrent()) return
      if (err instanceof DashboardApiError && err.kind === 'network' && err.message.includes('已取消')) return
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [api, online, isCurrentIdentity])

  // Activity reattaches effects with state/refs intact. Keep the save queue for
  // the same identity; abort is only best effort for already submitted IPC writes.
  useEffect(() => {
    cancelAccountRequests()
    const previous = layoutIdentity.current
    if (previous?.accountId === accountId && previous.endpoint === settings.ai.communityEndpoint) {
      return cancelAccountRequests
    }
    layoutIdentity.current = { accountId, endpoint: settings.ai.communityEndpoint }
    layoutAccount.current += 1
    savedLayoutSeq.current += 1
    layoutAbort.current?.abort()
    layoutAbort.current = new AbortController()
    layoutQueue.current = Promise.resolve()
    const account = layoutAccount.current
    queueMicrotask(() => {
      if (account !== layoutAccount.current) return
      setData(null)
      setLayout(DEFAULT_LAYOUT)
      setNotice(null)
      setMenu(null)
      setPage(1)
      if (!online) {
        setError(null)
        setLoading(false)
        return
      }
    })
    return cancelAccountRequests
  }, [accountId, online, api, settings.ai.communityEndpoint, cancelAccountRequests])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled && online) {
        setPage(1)
        setMenu(null)
        void refresh(range, 1)
      }
    })
    return () => { cancelled = true; cancelAccountRequests() }
  }, [accountId, online, range, refresh, cancelAccountRequests])

  const changeRange = useCallback((next: DashboardRange) => {
    if (next === range) return
    setPage(1)
    setRange(next)
  }, [range])

  const changePage = useCallback((next: number) => {
    if (next < 1 || next === page) return
    setPage(next)
    void refresh(range, next)
  }, [page, range, refresh])

  /** 自动保存布局：成功采用服务端返回值；失败回退默认并提示（不静默假装成功）。 */
  const applyLayout = useCallback(async (next: DashboardLayout) => {
    if (!isCurrentIdentity()) return
    const seq = ++savedLayoutSeq.current
    const account = layoutAccount.current
    const signal = layoutAbort.current?.signal
    setLayout(next)
    setNotice('正在自动保存布局…')
    try {
      const pending = layoutQueue.current.catch(() => undefined).then(() => {
        if (account !== layoutAccount.current || signal?.aborted || !isCurrentIdentity()) return null
        return api.putLayout(next, { signal })
      })
      layoutQueue.current = pending
      const saved = await pending
      if (!saved || account !== layoutAccount.current || seq !== savedLayoutSeq.current || !isCurrentIdentity()) return
      setNotice('布局已自动保存')
      setLayout(normalizeLayout(saved))
    } catch (err) {
      if (account !== layoutAccount.current || seq !== savedLayoutSeq.current || !isCurrentIdentity()) return
      if (err instanceof DashboardApiError && err.message.includes('已取消')) return
      setLayout(DEFAULT_LAYOUT)
      const message = `布局自动保存失败，已回退默认位置：${err instanceof Error ? err.message : String(err)}`
      setNotice(message)
      notify(message)
    }
  }, [api, notify, isCurrentIdentity])

  const doSwap = useCallback((slot: DashboardSlot) => {
    const target = layout.slots[0] === slot ? layout.slots[1] : layout.slots[0]
    void applyLayout(swapSlots(layout.slots))
    setMenu(null)
    setNotice(`“${slot === 'balance' ? '账户余额' : '用量统计'}”与“${target === 'balance' ? '账户余额' : '用量统计'}”已交换位置`)
  }, [applyLayout, layout])

  const doReset = useCallback(() => {
    void applyLayout(DEFAULT_LAYOUT)
    setNotice('布局已重置为默认位置')
  }, [applyLayout])

  if (communityAuth.status === 'offline') {
    return (
      <section className="dashboard-panel panel" aria-labelledby="dashboard-title">
        <div className="panel-header"><h2 id="dashboard-title">仪表盘</h2></div>
        <PanelState
          kind="empty"
          icon="cloud"
          title="离线模式下不可用"
          description="仪表盘需要社区服务器提供真实余额与用量数据。离线状态不会展示占位数据。"
          action={<button className="btn primary" onClick={() => void loginCommunity()}>登录社区</button>}
        />
      </section>
    )
  }

  if (!online) {
    return (
      <section className="dashboard-panel panel" aria-labelledby="dashboard-title">
        <div className="panel-header"><h2 id="dashboard-title">仪表盘</h2></div>
        <PanelState
          kind="empty"
          icon="cloud"
          title="尚未登录社区账号"
          description="登录后查看真实账户余额、准确 Token 用量与调用日志。"
          action={<button className="btn primary" onClick={() => void loginCommunity()}>在浏览器中登录</button>}
        />
      </section>
    )
  }

  const summary = data?.usage ?? EMPTY_SUMMARY
  const balance = data?.balance ?? null
  const pie = cachePieSegments(summary)

  const widgetBySlot = (slot: DashboardSlot) => (
    <article
      key={slot}
      className={`dashboard-widget dashboard-widget-${slot}`}
      tabIndex={-1}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ slot, x: event.clientX, y: event.clientY })
      }}
      aria-label={slot === 'balance' ? '账户余额小部件' : '用量统计小部件'}
    >
      <header className="dashboard-widget-head">
        <h3>{slot === 'balance' ? '账户余额' : '用量统计'}</h3>
        <button
          type="button"
          className="btn-sm dashboard-swap-btn"
          onClick={() => doSwap(slot)}
          aria-label={`交换“${slot === 'balance' ? '账户余额' : '用量统计'}”位置`}
          title="交换位置（按钮/键盘可操作，右键小部件也有入口）"
        >
          <AppIcon name="layout" size={13} /> 交换位置
        </button>
      </header>
      {slot === 'balance' ? <BalanceBody balance={balance} /> : <UsageBody summary={summary} />}
    </article>
  )

  return (
    <section className="dashboard-panel panel" aria-labelledby="dashboard-title">
      <div className="panel-header">
        <h2 id="dashboard-title">仪表盘</h2>
        <div className="dashboard-toolbar" role="group" aria-label="时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`dashboard-range${range === option.value ? ' active' : ''}`}
              aria-pressed={range === option.value}
              onClick={() => changeRange(option.value)}
            >{option.label}</button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          title="重新请求仪表盘数据"
          aria-label="重新请求仪表盘数据"
          onClick={() => void refresh(range, page)}
          disabled={loading}
        ><AppIcon name="refresh" size={13} /></button>
        <button type="button" className="btn-sm" onClick={doReset}>重置布局</button>
      </div>

      <div className="dashboard-body">
        {notice && <div className="dashboard-notice" role="status">{notice}</div>}
        {error && (
          <PanelState
            kind="error"
            title="仪表盘加载失败"
            description={error}
            action={<button className="btn" onClick={() => void refresh(range, page)}>重试</button>}
          />
        )}

        {loading && !data && <PanelState kind="loading" title="加载仪表盘…" />}

        {!loading && !error && data && (
          <>
            <div className="dashboard-widgets">
              {layout.slots.map((slot) => widgetBySlot(slot))}
            </div>

            <article className="dashboard-card dashboard-chart-card">
              <header className="dashboard-widget-head">
                <h3>用量图表</h3>
                <div className="dashboard-modes" role="group" aria-label="图表类型">
                  {CHART_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`dashboard-mode${chartMode === option.value ? ' active' : ''}`}
                      aria-pressed={chartMode === option.value}
                      onClick={() => setChartMode(option.value)}
                    >{option.label}</button>
                  ))}
                </div>
              </header>
              <ChartBody mode={chartMode} data={data} pie={pie} />
            </article>

            <article className="dashboard-card dashboard-logs-card">
              <header className="dashboard-widget-head">
                <h3>调用日志</h3>
                <span className="dashboard-muted">{data.logs.window.start.slice(0, 10)} → {data.logs.window.end.slice(0, 10)}（UTC）</span>
              </header>
              {data.logs.items.length === 0 ? (
                <PanelState kind="empty" title="该时间范围内没有调用记录" description={summary.reason ?? undefined} />
              ) : (
                <div className="dashboard-table-wrap">
                  <table className="dashboard-table">
                    <thead>
                      <tr>
                        <th scope="col">时间（UTC）</th>
                        <th scope="col">模型</th>
                        {COUNT_LABELS.map((count) => <th key={count.key} scope="col">{count.label}</th>)}
                        <th scope="col">思考强度</th>
                        <th scope="col">用量来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.logs.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.createdAt.replace('T', ' ').replace(/(\.\d+)?Z$/, '')}</td>
                          <td className="dashboard-model" title={item.model}>{item.model}</td>
                          <td>{formatCount(item.inputTokens)}</td>
                          <td>{formatCount(item.outputTokens)}</td>
                          <td>{formatCount(item.cacheReadTokens)}</td>
                          <td>{formatCount(item.cacheWriteTokens)}</td>
                          <td>{reasoningLabel(item.reasoningEffort)}</td>
                          <td title={item.reason ?? undefined}>{usageSourceLabel(item.usageSource)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <footer className="dashboard-pager">
                <span className="dashboard-muted">
                  共 {data.logs.total} 条 · 第 {data.logs.page} / {Math.max(1, Math.ceil(data.logs.total / data.logs.pageSize))} 页
                </span>
                <span className="grow" />
                <button type="button" className="btn-sm" disabled={data.logs.page <= 1} onClick={() => changePage(data.logs.page - 1)}>上一页</button>
                <button
                  type="button"
                  className="btn-sm"
                  disabled={data.logs.page * data.logs.pageSize >= data.logs.total}
                  onClick={() => changePage(data.logs.page + 1)}
                >下一页</button>
              </footer>
            </article>
          </>
        )}
      </div>

      {menu && (
        <div
          className="dashboard-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(event) => { if (event.key === 'Escape') setMenu(null) }}
        >
          <button type="button" role="menuitem" autoFocus onClick={() => doSwap(menu.slot)}>
            <AppIcon name="layout" size={13} /> 交换位置
          </button>
        </div>
      )}
      {menu && <button type="button" className="dashboard-menu-backdrop" aria-label="关闭菜单" onClick={() => setMenu(null)} onBlur={() => setMenu(null)} />}
    </section>
  )
}

function BalanceBody({ balance }: { balance: DashboardData['balance'] | null }) {
  const { value, note } = balanceText(balance)
  return (
    <div className="dashboard-balance">
      <div className="dashboard-balance-value">{value}</div>
      <div className="dashboard-balance-unit">{balance?.unit ?? '计费额度'}</div>
      <div className="dashboard-muted">
        {note && balance?.amount !== null && balance?.amount !== undefined ? `来源：${balance.source ?? '未知'}` : (balance?.reason ?? '余额来源不可用')}
      </div>
    </div>
  )
}

function UsageBody({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="dashboard-usage">
      <div className="dashboard-usage-grid">
        {COUNT_LABELS.map((count) => (
          <div className="dashboard-count" key={count.key}>
            <span className="dashboard-count-label">{count.label}</span>
            <strong>{formatCount(summary[count.key])}</strong>
            <span className="dashboard-coverage">{fieldCoverageLabel(summary.fieldCoverage[count.key]?.coverage ?? 'unavailable')}</span>
          </div>
        ))}
      </div>
      <div className="dashboard-usage-meta">
        <span>调用 {summary.requestCount} 次 · 准确样本 {summary.exactRequestCount} 次</span>
        <span className={`dashboard-badge dashboard-badge-${summary.coverage}`}>{coverageLabel(summary.coverage, summary.reason)}</span>
      </div>
    </div>
  )
}

interface ChartBodyProps {
  mode: ChartMode
  data: DashboardData
  pie: ReturnType<typeof cachePieSegments>
}

function ChartBody({ mode, data, pie }: ChartBodyProps) {
  if (mode === 'pie') {
    if (!pie) {
      return (
        <PanelState
          kind="empty"
          title="缓存占比暂不可用"
          description={coverageLabel(data.usage.coverage, data.usage.reason) + '：仅当输入/缓存读/缓存写都来自同一批准确样本时才绘制占比图。'}
        />
      )
    }
    const total = pie.reduce((sum, segment) => sum + segment.value, 0)
    return (
      <div className="dashboard-pie-wrap">
        <svg viewBox="0 0 160 160" className="dashboard-pie" role="img" aria-label="输入 Token 缓存占比">
          {pie.map((segment, index) => {
            const angle = -Math.PI / 2 + pie.slice(0, index).reduce((sum, item) => sum + item.value, 0) / total * Math.PI * 2
            const sweep = (segment.value / total) * Math.PI * 2
            const end = angle + sweep
            const x1 = 80 + 70 * Math.cos(angle)
            const y1 = 80 + 70 * Math.sin(angle)
            const x2 = 80 + 70 * Math.cos(end)
            const y2 = 80 + 70 * Math.sin(end)
            const large = sweep > Math.PI ? 1 : 0
            return (
              <path
                key={segment.key}
                d={segment.value === total
                  ? 'M80,10 A70,70 0 1 1 80,150 A70,70 0 1 1 80,10 Z'
                  : `M80,80 L${x1},${y1} A70,70 0 ${large} 1 ${x2},${y2} Z`}
                className={`dashboard-pie-seg dashboard-pie-seg-${index + 1}`}
              />
            )
          })}
        </svg>
        <ul className="dashboard-legend">
          {pie.map((segment, index) => (
            <li key={segment.key}>
              <span className={`dashboard-swatch dashboard-swatch-${index + 1}`} />
              {segment.label}：{formatCount(segment.value)}（{((segment.value / total) * 100).toFixed(1)}%）
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const series = chartValues(data.series)
  const values = series.flatMap((point) => [point.input, point.output]).filter((value): value is number => value !== null)
  if (values.length === 0) {
    return <PanelState kind="empty" title="该时间范围内没有准确用量" description={coverageLabel(data.usage.coverage, data.usage.reason)} />
  }
  const max = Math.max(...values, 1)
  const width = 720
  const height = 220
  const padLeft = 46
  const padBottom = 28
  const step = series.length > 1 ? (width - padLeft - 12) / (series.length - 1) : 0
  const xAt = (index: number) => padLeft + index * step
  const yAt = (value: number) => height - padBottom - (value / max) * (height - padBottom - 16)
  const linePath = (key: 'input' | 'output') => {
    const segments: string[] = []
    let open = false
    series.forEach((point, index) => {
      const value = point[key]
      if (value === null) { open = false; return }
      segments.push(`${open ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`)
      open = true
    })
    return segments.join(' ')
  }
  const labelEvery = Math.max(1, Math.ceil(series.length / 7))
  return (
    <div className="dashboard-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="dashboard-chart" role="img" aria-label="输入与输出 Token 每日趋势">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = height - padBottom - ratio * (height - padBottom - 16)
          return (
            <g key={ratio}>
              <line x1={padLeft} x2={width - 6} y1={y} y2={y} className="dashboard-grid" />
              <text x={padLeft - 6} y={y + 4} textAnchor="end" className="dashboard-axis">{formatCount(Math.round(max * ratio))}</text>
            </g>
          )
        })}
        {mode === 'bar' && series.map((point, index) => {
          const barWidth = Math.max(2, Math.min(14, step / 2.6))
          return (
            <g key={point.date}>
              {point.input !== null && (
                <rect x={xAt(index) - barWidth} y={yAt(point.input)} width={barWidth} height={height - padBottom - yAt(point.input)} className="dashboard-bar-input" />
              )}
              {point.output !== null && (
                <rect x={xAt(index) + 1} y={yAt(point.output)} width={barWidth} height={height - padBottom - yAt(point.output)} className="dashboard-bar-output" />
              )}
            </g>
          )
        })}
        {mode === 'line' && (
          <>
            <path d={linePath('input')} className="dashboard-line-input" />
            <path d={linePath('output')} className="dashboard-line-output" />
          </>
        )}
        {series.map((point, index) => (index % labelEvery === 0 ? (
          <text key={point.date} x={xAt(index)} y={height - 8} textAnchor="middle" className="dashboard-axis">{point.date.slice(5)}</text>
        ) : null))}
      </svg>
      <ul className="dashboard-legend">
        <li><span className="dashboard-swatch dashboard-swatch-1" />输入 Token（含缓存）</li>
        <li><span className="dashboard-swatch dashboard-swatch-2" />输出 Token</li>
      </ul>
      <p className="dashboard-muted">时间范围 {data.window.start} → {data.window.end}（UTC，左闭右开）；缺失日期不按 0 绘制。</p>
    </div>
  )
}
