/**
 * 地图查看器（M15，任务 5）：打开 .tmx 地图文件时的安全预览面板——
 * 元数据/图层/对象摘要、Ground 网格缩略图（canvas 色块，不加载外部图片）、
 * 检查结果（铺满/Triggers/图块集/gzip 兼容）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getBridge } from '../../services/bridge'
import { canPreviewSafely, checkTmx, parseTmx, type TmxCheckIssue, type TmxMap } from './tmx'

interface MapViewerProps {
  path: string
  rootPath: string
}

/** 是否地图文件 */
export function isMapFile(path: string): boolean {
  return /\.tmx$/i.test(path)
}

/** 从 Ground 层 data（CSV 或 base64）提取 gid 数组（预览用；解码失败返回空） */
async function groundGids(map: TmxMap): Promise<number[]> {
  const layer = map.layers.find((l) => l.kind === 'tile' && l.name.toLowerCase() === 'ground')
  if (!layer?.data) return []
  const { decodedTileCount } = await import('./tmx')
  const count = await decodedTileCount(layer)
  if (count === null) return []
  const encoding = layer.encoding ?? 'csv'
  if (encoding === 'csv') {
    return layer.data.split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s) || 0)
  }
  if (encoding === 'base64') {
    try {
      const binary = atob(layer.data.replace(/\s+/g, ''))
      if (!layer.compression || layer.compression === 'none') {
        const out: number[] = []
        const dv = new DataView(new ArrayBuffer(binary.length))
        for (let i = 0; i < binary.length; i++) dv.setUint8(i, binary.charCodeAt(i))
        for (let i = 0; i + 4 <= binary.length; i += 4) {
          out.push(dv.getUint32(i, true))
        }
        return out
      }
    } catch {
      return []
    }
  }
  return []
}

export function MapViewer({ path, rootPath }: MapViewerProps) {
  const [map, setMap] = useState<TmxMap | null>(null)
  const [issues, setIssues] = useState<TmxCheckIssue[]>([])
  const [error, setError] = useState<string | null>(null)
  const [gids, setGids] = useState<number[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const { content } = await getBridge().project.readFile(rootPath, path)
        const parsed = parseTmx(content)
        if (!alive) return
        if (!parsed) {
          setError('不是有效的 TMX 地图文件（缺少 <map> 根元素）')
          return
        }
        setMap(parsed)
        // 项目文件列表（图块集引用检查）
        const scan = await getBridge().mod.scanResources(rootPath).catch(() => null)
        if (!alive) return
        const result = await checkTmx(parsed, { projectFiles: new Set(scan?.files ?? []) })
        if (!alive) return
        setIssues(result.issues)
        const g = await groundGids(parsed)
        if (alive) setGids(g)
      } catch (err) {
        if (alive) setError(`读取地图失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
    return () => {
      alive = false
    }
  }, [path, rootPath])

  // 渲染 Ground 网格缩略图（canvas 色块；按 gid 变化着色，不加载外部图片）
  useEffect(() => {
    if (!map || gids.length === 0 || !canvasRef.current) return
    const canvas = canvasRef.current
    const scale = Math.min(8, Math.max(1, Math.floor(240 / map.width)))
    canvas.width = map.width * scale
    canvas.height = map.height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#2a2a2a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // 固定调色板（gid → 色相），0 = 空 tile（深色）
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const idx = y * map.width + x
        const gid = gids[idx] ?? 0
        if (gid <= 0) {
          ctx.fillStyle = '#1a1a1a'
        } else {
          ctx.fillStyle = `hsl(${(gid * 47) % 360} 45% 55%)`
        }
        ctx.fillRect(x * scale, y * scale, scale, scale)
      }
    }
  }, [map, gids])

  const safe = map ? canPreviewSafely(map) : false
  const layerSummary = useMemo(() => {
    if (!map) return ''
    const tiles = map.layers.filter((l) => l.kind === 'tile').length
    const objects = map.layers.filter((l) => l.kind === 'objectgroup')
    const objCount = objects.reduce((n, l) => n + (l.objectCount ?? 0), 0)
    return `${map.layers.length} 层（瓦片 ${tiles} · 对象 ${objects.length} 层/${objCount} 个对象）`
  }, [map])

  if (error) {
    return <div className="map-viewer map-viewer-error">{error}</div>
  }
  if (!map) {
    return <div className="map-viewer map-viewer-loading">正在解析地图…</div>
  }

  return (
    <div className="map-viewer">
      <div className="map-viewer-head">
        <span className="map-viewer-title">{path.split('/').pop()}</span>
        <span className="map-viewer-meta">
          {map.width}×{map.height} · 瓦片 {map.tileWidth}×{map.tileHeight} · {map.orientation}
        </span>
      </div>
      <div className="map-viewer-body">
        <div className="map-viewer-section">
          <div className="map-viewer-section-title">图层与对象</div>
          <div className="map-viewer-meta">{layerSummary}</div>
          <ul className="map-viewer-layers">
            {map.layers.map((l, i) => (
              <li key={i} className={`map-viewer-layer map-viewer-layer-${l.kind}`}>
                <span className="map-viewer-layer-name">{l.name}</span>
                <span className="map-viewer-layer-kind">
                  {l.kind === 'tile' ? `瓦片层${l.compression ? `（${l.compression} ${l.encoding ?? ''}）` : ''}` : `对象层 · ${l.objectCount ?? 0} 个对象`}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {map.tilesets.length > 0 && (
          <div className="map-viewer-section">
            <div className="map-viewer-section-title">图块集（{map.tilesets.length}）</div>
            <ul className="map-viewer-tilesets">
              {map.tilesets.map((ts, i) => (
                <li key={i}>
                  <code>{ts.source ?? ts.name ?? `firstgid=${ts.firstGid}`}</code>
                  <span className="map-viewer-meta">firstgid={ts.firstGid}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="map-viewer-section">
          <div className="map-viewer-section-title">
            检查结果
            <span className={`map-viewer-badge${issues.some((i) => i.severity === 'error') ? ' bad' : ''}`}>
              {issues.length === 0 ? '✓ 通过' : `${issues.filter((i) => i.severity === 'error').length} 错误 / ${issues.filter((i) => i.severity === 'warning').length} 警告`}
            </span>
          </div>
          {issues.length === 0 ? (
            <div className="map-viewer-ok">未发现问题</div>
          ) : (
            <ul className="map-viewer-issues">
              {issues.map((it, i) => (
                <li key={i} className={`map-viewer-issue map-viewer-issue-${it.severity}`}>
                  <span>{it.severity === 'error' ? '✕' : '⚠'}</span> {it.message}
                </li>
              ))}
            </ul>
          )}
        </div>

        {safe && (
          <div className="map-viewer-section">
            <div className="map-viewer-section-title">Ground 缩略图（安全预览，不加载图片）</div>
            <canvas ref={canvasRef} className="map-viewer-canvas" />
            {gids.length === 0 && <div className="map-viewer-meta">Ground 数据为空或无法解码，无缩略图</div>}
          </div>
        )}
        {!safe && <div className="map-viewer-meta">地图过大（{map.width}×{map.height}），已跳过缩略图预览</div>}
      </div>
    </div>
  )
}
