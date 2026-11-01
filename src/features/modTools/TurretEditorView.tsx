/**
 * 炮塔编辑器（独立编辑界面，非弹窗）：占用编辑器内容区域，提供「返回」操作。
 *
 * 画面来源：**只由引擎 DLC 常驻会话渲染**（0.2.2+ session-host），桌面端不再用
 * 本地 Canvas/img 拼单位——底图是 DLC 回传的 RGBA 帧，炮塔锚点用 DLC 返回的
 * coordinateMapping/turrets 绘制。DLC 不可用/未授权时清晰禁用预览并说明原因，
 * 不悄悄回退本地合成。
 *
 * 交互：
 * - 拖动手柄：指针移动立即视觉更新手柄位置并把目标世界坐标发给 DLC
 *   （turretOverrides；RAF 合并约 60Hz，拖动期 240×180 RGBA），DLC 内部完成
 *   INI x/y 逆映射，回帧的 turrets[].iniX/iniY 写回当前标签内容（保留原文/注释/CRLF）；
 * - 松手：同会话 resize 到 480×360 出高清帧（文档支持同会话改尺寸）；
 * - 表格：x/y/待机朝向/弹体/大小输入，x/y 修改同样经会话覆盖实时预览；
 * - 保存：updateTabContent + saveTab（含外部修改拦截）。
 *
 * 会话生命周期：本组件按标签 key 挂载，切标签/关文件/关闭编辑器即卸载并关闭会话；
 * 渲染层每窗口最多一个会话，主进程在 sender 销毁/授权撤销时兜底杀进程树。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { getBridge } from '../../services/bridge'
import { parseTurrets, updateTurretValue } from '../editor/turretUtils'
import { dataReady, getEnToZhDict, getZhToEnDict, loadCodeData } from '../../services/codeData'
import type { EngineDlcSessionFrame } from '../../types/bridge'

/** 拖动期低分辨率（性能验收口径：240×180 RGBA ≈2ms/帧），松手后原生高清 */
export const DRAG_SIZE = { width: 240, height: 180 }
const IDLE_SIZE = { width: 480, height: 360 }

/** INI 数值格式：接近整数写整数，否则保留 2 位小数（不引入浮点尾数） */
function formatIniNumber(value: number): string {
  const rounded = Math.round(value)
  if (Math.abs(value - rounded) < 0.05) return String(rounded)
  return String(Math.round(value * 100) / 100)
}

type SessionState =
  | { kind: 'opening' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; reason: string }

export function TurretEditorView({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const tab = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId))
  const updateTabContent = useWorkspaceStore((s) => s.updateTabContent)
  const saveTab = useWorkspaceStore((s) => s.saveTab)

  const [frame, setFrame] = useState<EngineDlcSessionFrame | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [rendering, setRendering] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** 进行中的拖动：炮塔编号（1 基） */
  const draggingRef = useRef<number | null>(null)
  /** 最新待渲染的炮塔覆盖（RAF 合并；null 表示没有新请求） */
  const pendingRef = useRef<{ index: number; worldX: number; worldY: number } | null>(null)
  /** 松手后的高清帧请求（与覆盖请求共用同一泵） */
  const pendingIdleRef = useRef(false)
  const inFlightRef = useRef(false)
  const rafRef = useRef(0)
  const disposedRef = useRef(false)
  const [dictReady, setDictReady] = useState(dataReady())
  useEffect(() => {
    if (dictReady) return
    let alive = true
    void loadCodeData().then(() => alive && setDictReady(true)).catch(() => undefined)
    return () => { alive = false }
  }, [dictReady])
  const zhToEn = useMemo(() => {
    const dict = getZhToEnDict()
    return dict.size > 0 ? (s: string) => dict.get(s) : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dictReady 是词典就绪信号
  }, [dictReady])
  const enToZh = useMemo(() => {
    const dict = getEnToZhDict()
    return dict.size > 0 ? (s: string) => dict.get(s.toLowerCase()) : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dictReady 是词典就绪信号
  }, [dictReady])

  const turrets = useMemo(() => (tab ? parseTurrets(tab.content, zhToEn) : []), [tab, zhToEn])

  const writeTurretIni = useCallback((turretIndex: number, x: number, y: number) => {
    const state = useWorkspaceStore.getState()
    const current = state.openTabs.find((t) => t.id === tabId)
    if (!current) return
    const existing = parseTurrets(current.content, zhToEn).find((t) => t.index === turretIndex)
    const currentX = existing ? Number(existing.values.get('x')) : NaN
    const currentY = existing ? Number(existing.values.get('y')) : NaN
    const nextX = formatIniNumber(x)
    const nextY = formatIniNumber(y)
    // 数值没变化就不写（避免 60Hz 空转触发编辑器重渲染）
    if (currentX === Number(nextX) && currentY === Number(nextY)) return
    let content = updateTurretValue(current.content, turretIndex, 'x', nextX, zhToEn, enToZh)
    content = updateTurretValue(content, turretIndex, 'y', nextY, zhToEn, enToZh)
    state.updateTabContent(tabId, content)
    setSaved(false)
  }, [tabId, zhToEn, enToZh])

  /** 把 DLC 帧画上画布（RGBA 顶层向下直 alpha，直接进 ImageData） */
  const drawFrame = useCallback((target: EngineDlcSessionFrame) => {
    const canvas = canvasRef.current
    if (!canvas || target.pixels.length === 0) return
    if (canvas.width !== target.size.width || canvas.height !== target.size.height) {
      canvas.width = target.size.width
      canvas.height = target.size.height
    }
    const context = canvas.getContext('2d')
    if (!context) return
    const imageData = context.createImageData(target.size.width, target.size.height)
    imageData.data.set(target.pixels)
    context.putImageData(imageData, 0, 0)
  }, [])

  /** 发送一次更新（串行化：一次只有一个 in-flight；新请求合并到 pendingRef）。
   * 递归续泵经 pumpRef 转发，避免 useCallback 自引用。 */
  const pumpRef = useRef<() => void>(() => {})
  const pump = useCallback(() => {
    if (disposedRef.current) return
    if (inFlightRef.current) return
    const desired = pendingRef.current
    const resizeToIdle = pendingIdleRef.current
    if (!desired && !resizeToIdle) { setRendering(false); return }
    const bridge = getBridge().engineDlc
    if (!bridge?.sessionUpdate) { setRendering(false); return }
    pendingRef.current = null
    pendingIdleRef.current = false
    inFlightRef.current = true
    setRendering(true)
    const payload: Record<string, unknown> = {}
    if (desired) payload.turretOverrides = [desired]
    if (resizeToIdle) payload.size = IDLE_SIZE
    bridge.sessionUpdate(payload)
      .then((result) => {
        inFlightRef.current = false
        if (disposedRef.current) return
        if (result.ok) {
          setFrame(result.frame)
          drawFrame(result.frame)
          const dragged = desired?.index ?? draggingRef.current
          if (result.frame.turrets && dragged !== null) {
            const anchor = result.frame.turrets.find((t) => t.index === dragged)
            if (anchor) writeTurretIni(dragged, anchor.iniX, anchor.iniY)
          }
        }
        // 队列里还有新请求（或松手后的高清帧请求）就继续泵
        pumpRef.current()
      })
      .catch(() => {
        inFlightRef.current = false
        setRendering(false)
      })
  }, [drawFrame, writeTurretIni])
  useEffect(() => {
    pumpRef.current = pump
  }, [pump])

  /** 请求把某炮塔移到目标世界坐标（RAF 合并到 ~60Hz） */
  const requestOverride = useCallback((index: number, worldX: number, worldY: number) => {
    pendingRef.current = { index, worldX, worldY }
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        pump()
      })
    }
  }, [pump])

  // 打开会话（仅一次；tab/path/project 由外层 key 保证稳定）。
  // setState 只出现在 promise 回调里（react-hooks/set-state-in-effect）：
  // 同步不可用的情况用惰性 useState 初始化直接得到终态。
  const sessionOpenUnavailable = useMemo<{ reason: string } | null>(() => {
    const bridge = getBridge().engineDlc
    const state = useWorkspaceStore.getState()
    if (!bridge?.sessionOpen || !state.openTabs.some((t) => t.id === tabId) || !state.projects.some((p) => p.id === state.activeProjectId)) {
      return { reason: '当前版本没有引擎会话能力，请更新应用' }
    }
    return null
    // 仅挂载时评估一次（外层 key 保证 tabId 稳定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [sessionState, setSessionState] = useState<SessionState>(
    () => (sessionOpenUnavailable ? { kind: 'unavailable', reason: sessionOpenUnavailable.reason } : { kind: 'opening' }),
  )
  useEffect(() => {
    if (sessionOpenUnavailable) return
    disposedRef.current = false
    const bridge = getBridge().engineDlc
    const state = useWorkspaceStore.getState()
    const current = state.openTabs.find((t) => t.id === tabId)
    const activeProject = state.projects.find((p) => p.id === state.activeProjectId)
    if (!bridge?.sessionOpen || !current || !activeProject) return
    let alive = true
    bridge.sessionOpen({
      unitFile: current.path,
      unitContent: current.content,
      projectRoot: activeProject.rootPath,
      view: { direction: 0, animationState: 'idle', showWreck: false },
      size: IDLE_SIZE,
    })
      .then((result) => {
        if (!alive) return
        if (!result.ok) {
          setSessionState({ kind: 'unavailable', reason: result.reason })
          return
        }
        setSessionState({ kind: 'ready' })
        setFrame(result.frame)
        drawFrame(result.frame)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setSessionState({ kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      alive = false
      disposedRef.current = true
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      void getBridge().engineDlc?.sessionClose?.().catch(() => undefined)
    }
    // 只在挂载/卸载与标签标识变化时开/关会话；内容变化走覆盖，不重开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // 表格 x/y 输入：写 INI 并把新位置经会话覆盖送入预览
  const setValue = (index: number, key: string, value: string) => {
    if (!tab) return
    if (value.trim() === '' || value === '-' || value === 'e' || value === '+' || value === '.') return
    updateTabContent(tab.id, updateTurretValue(tab.content, index, key, value, zhToEn, enToZh))
    setSaved(false)
    if (key === 'x' || key === 'y') {
      const anchor = frame?.turrets?.find((t) => t.index === index)
      if (anchor) {
        const newX = key === 'x' ? Number(value) : anchor.iniX
        const newY = key === 'y' ? Number(value) : anchor.iniY
        // 方向 0 时 worldX = unitX + iniY、worldY = unitY + iniX（DLC 文档口径）；
        // 用「相对当前锚点的增量」换算，单位位置/父子炮塔结构不敏感。
        const dWorldX = newY - anchor.iniY
        const dWorldY = newX - anchor.iniX
        requestOverride(index, anchor.worldX + dWorldX, anchor.worldY + dWorldY)
      }
    }
  }

  const save = async () => {
    if (!tab) return
    setSaving(true)
    const ok = await saveTab(tab.id)
    setSaving(false)
    if (ok) setSaved(true)
  }

  /** 指针位置 → 目标世界坐标（用最近一帧的 coordinateMapping 逆映射） */
  const pointerToWorld = (clientX: number, clientY: number): { worldX: number; worldY: number } | null => {
    const target = frame
    const container = containerRef.current
    if (!target?.coordinateMapping || !container) return null
    const rect = container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const scaleX = target.size.width / rect.width
    const scaleY = target.size.height / rect.height
    const imageX = (clientX - rect.left) * scaleX
    const imageY = (clientY - rect.top) * scaleY
    const { originX, originY, pixelsPerUnit } = target.coordinateMapping
    if (!pixelsPerUnit) return null
    return { worldX: (imageX - originX) / pixelsPerUnit, worldY: (imageY - originY) / pixelsPerUnit }
  }

  const onHandlePointerDown = (index: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sessionState.kind !== 'ready') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = index
  }

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const index = draggingRef.current
    if (index === null) return
    const world = pointerToWorld(event.clientX, event.clientY)
    if (world) requestOverride(index, world.worldX, world.worldY)
  }

  const onHandlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (draggingRef.current === null) return
    draggingRef.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
    // 松手：同会话 resize 到原生 480×360（最后一拍 pending 覆盖仍然生效）
    pendingIdleRef.current = true
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        pump()
      })
    }
  }

  if (!tab) return null

  const sessionReady = sessionState.kind === 'ready'
  const displayFrame = frame
  const handlePositions = displayFrame?.turrets ?? []

  return (
    <div className="turret-editor-view">
      <div className="editor-head">
        <div className="editor-head-row top">
          <span style={{ color: 'var(--text-secondary)', display: 'grid' }}>
            <span className="turret-editor-badge">炮塔编辑</span>
          </span>
          <span className="path" title={tab.path}>{tab.name} · 炮塔编辑模式</span>
          {tab.dirty && <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>● 未保存</span>}
          {sessionReady && rendering && <span className="turret-rendering">渲染中…</span>}
          <span className="grow" />
          <button className="btn" onClick={onClose}>返回代码编辑</button>
        </div>
      </div>
      <div className="turret-editor-body">
        <div className="turret-table">
          {turrets.length === 0 ? (
            <p className="mod-tip">当前文件没有 [turret_N] 段。炮塔 = 单位上的武器挂点，格式见代码表 turret 节。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>炮塔</th>
                  <th title="横坐标偏移">x</th>
                  <th title="纵坐标偏移">y</th>
                  <th title="待机朝向角度（idleDir）">待机朝向</th>
                  <th title="炮塔发射的弹体（projectile）">弹体</th>
                  <th title="炮塔大小（size）">大小</th>
                </tr>
              </thead>
              <tbody>
                {turrets.map((t, idx) => (
                  <tr key={`${t.index}-${idx}`}>
                    <td>{t.index}</td>
                    <td>
                      <input
                        type="number"
                        value={t.values.get('x') ?? '0'}
                        onChange={(e) => setValue(t.index, 'x', e.target.value)}
                        aria-label={`炮塔 ${t.index} 的 x 坐标`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={t.values.get('y') ?? '0'}
                        onChange={(e) => setValue(t.index, 'y', e.target.value)}
                        aria-label={`炮塔 ${t.index} 的 y 坐标`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={t.values.get('idleDir') ?? '0'}
                        onChange={(e) => setValue(t.index, 'idleDir', e.target.value)}
                        aria-label={`炮塔 ${t.index} 的 idleDir`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={t.values.get('projectile') ?? ''}
                        onChange={(e) => setValue(t.index, 'projectile', e.target.value)}
                        aria-label={`炮塔 ${t.index} 的 projectile`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={t.values.get('size') ?? '8'}
                        onChange={(e) => setValue(t.index, 'size', e.target.value)}
                        aria-label={`炮塔 ${t.index} 的 size`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mod-tip">x/y 是炮塔相对单位图中心的像素坐标（y 向下为正）。在右侧渲染图上拖动炮塔手柄可实时改坐标；松手后自动出高清帧。</p>
          <div className="turret-editor-actions">
            <button className="btn primary" onClick={() => void save()} disabled={saving || !tab.dirty}>
              {saving ? '保存中…' : '保存炮塔坐标'}
            </button>
            {saved && <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>已保存</span>}
          </div>
        </div>
        <div className="turret-preview-pane">
          {sessionState.kind === 'unavailable' ? (
            <div className="turret-preview-disabled" role="status">
              <p>引擎实时预览不可用：{sessionState.reason}</p>
              <p className="mod-tip">
                单位画面只由引擎 DLC 渲染（不做本地合成）。请安装并授权 0.2.2+ 版本的
                「内置原版引擎预览」DLC（设置 → 引擎渲染 DLC），或打开 DLC 目录放入新版本。
              </p>
              <button className="btn" onClick={() => void getBridge().engineDlc?.openDir()}>打开 DLC 目录</button>
            </div>
          ) : (
            <div
              ref={containerRef}
              className="turret-canvas-wrap"
              style={{ background: 'repeating-conic-gradient(#f0f0f0 0% 25%, #fff 0% 50%) 0 0 / 20px 20px' }}
            >
              <canvas ref={canvasRef} className="turret-canvas" width={IDLE_SIZE.width} height={IDLE_SIZE.height} />
              {sessionState.kind === 'opening' && <div className="turret-preview-note">正在打开引擎渲染会话…</div>}
              {handlePositions.map((t, idx) => (
                <button
                  key={`${t.index}-${idx}`}
                  className="turret-dot"
                  title={`炮塔 ${t.index}（x: ${formatIniNumber(t.iniX)}, y: ${formatIniNumber(t.iniY)}）— 拖动可实时改坐标`}
                  aria-label={`炮塔 ${t.index}`}
                  style={{
                    position: 'absolute',
                    left: `${(t.imageX / displayFrame!.size.width) * 100}%`,
                    top: `${(t.imageY / displayFrame!.size.height) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    width: 14,
                    height: 14,
                    cursor: sessionReady ? 'grab' : 'default',
                  }}
                  onPointerDown={sessionReady ? onHandlePointerDown(t.index) : undefined}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  onPointerCancel={onHandlePointerUp}
                >
                  {t.index}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
