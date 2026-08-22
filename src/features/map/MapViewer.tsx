import { useEffect, useMemo, useRef, useState } from 'react'
import { getBridge } from '../../services/bridge'
import { AppIcon } from '../../components/AppIcon'
import { joinProjectPath } from '../../utils/projectPath'
import {
  checkTmx,
  decodeLayerGids,
  decodeTiledGid,
  normalizeTmx,
  parseTmx,
  parseTsx,
  planMapOverview,
  resolveProjectReference,
  resolveTilesetForGid,
  tiledGidTransform,
  tileSourceRect,
  type TmxCheckIssue,
  type TmxLayer,
  type TmxMap,
  type TmxTileset,
} from './tmx'

export interface MapCamera {
  x: number
  y: number
  zoom: number
}

interface MapViewerProps {
  path: string
  rootPath: string
  /** 当前标签内容：代码模式未保存修改切回预览时也立即生效。 */
  content: string
  /** 按标签保存的会话镜头；不写入工作区持久化数据。 */
  initialCamera?: MapCamera
  onCameraChange?: (camera: MapCamera) => void
}

interface LoadedTileset {
  tileset: TmxTileset
  image: HTMLImageElement | null
}

interface ViewportSize { width: number; height: number }

const imageCache = new Map<string, Promise<HTMLImageElement | null>>()
const MAX_IMAGE_CACHE = 100
const MAX_VISIBLE_TILES = 250_000
/** 总览单帧最多约 65k 采样格，极大地图也不会因为缩略图本身卡住 UI。 */
const OVERVIEW_EDGE = 256
const MAX_EMBEDDED_BASE64_CHARS = Math.ceil(20 * 1024 * 1024 * 4 / 3) + 4096
/** 单图与单张地图图块集的解码像素预算，防多个高压缩图集占满 renderer 内存。 */
const MAX_TILESET_IMAGE_PIXELS = 16_000_000
const MAX_TOTAL_TILESET_PIXELS = 64_000_000

export function isMapFile(path: string): boolean {
  return /\.tmx$/i.test(path)
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(url)
  if (cached) return cached
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_TILESET_IMAGE_PIXELS) {
        resolve(null)
        return
      }
      resolve(image)
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
  if (imageCache.size >= MAX_IMAGE_CACHE) {
    for (const key of [...imageCache.keys()].slice(0, Math.floor(MAX_IMAGE_CACHE / 2))) imageCache.delete(key)
  }
  imageCache.set(url, promise)
  return promise
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 从绝对 TMX 路径推导项目内 POSIX 目录；Windows 盘符大小写不影响结果。 */
function mapDirFromPaths(filePath: string, rootPath: string): string {
  const file = toPosix(filePath)
  const root = toPosix(rootPath)
  const rel = file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : file.split('/').pop() ?? ''
  const slash = rel.lastIndexOf('/')
  return slash >= 0 ? rel.slice(0, slash) : ''
}

function fitCamera(map: TmxMap, viewport: ViewportSize): MapCamera {
  const mapWidth = Math.max(1, map.width * Math.max(1, map.tileWidth))
  const mapHeight = Math.max(1, map.height * Math.max(1, map.tileHeight))
  const zoom = Math.max(0.01, Math.min((viewport.width - 24) / mapWidth, (viewport.height - 24) / mapHeight))
  return { x: mapWidth / 2, y: mapHeight / 2, zoom }
}

function fallbackColor(rawGid: number): string {
  const gid = decodeTiledGid(rawGid).gid
  return gid === 0 ? '#20242b' : `hsl(${(gid * 47) % 360} 42% 56%)`
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  rawGid: number,
  tilesets: LoadedTileset[],
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const hit = resolveTilesetForGid(rawGid, tilesets.map((item) => item.tileset))
  const loaded = hit && tilesets.find((item) => item.tileset === hit.tileset)
  const rect = hit ? tileSourceRect(hit.tileset, hit.localId) : null
  if (!loaded?.image || !rect) {
    ctx.fillStyle = fallbackColor(rawGid)
    ctx.fillRect(dx, dy, dw, dh)
    return
  }
  const transform = tiledGidTransform(rawGid)
  ctx.save()
  ctx.translate(dx, dy)
  // 先把单位方格缩放到 tile 的目标宽高，再应用 Tiled 的 H/V/D 矩阵。
  // 这样 diagonal flip 不会交换非方形 tile 的实际宽高，也不会拉伸图像。
  ctx.scale(dw, dh)
  ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f)
  ctx.drawImage(loaded.image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, 1, 1)
  ctx.restore()
  // hexagonal 的 120° 标志已从 gid 剥离；非正交地图走总览，不在此伪造旋转。
}

function layerBounds(map: TmxMap, camera: MapCamera, viewport: ViewportSize, offsetX = 0, offsetY = 0): { x0: number; y0: number; x1: number; y1: number } {
  const tileW = Math.max(1, map.tileWidth)
  const tileH = Math.max(1, map.tileHeight)
  const halfW = viewport.width / (2 * camera.zoom)
  const halfH = viewport.height / (2 * camera.zoom)
  return {
    // layer offset 在反算可见 grid 时提前抵消，避免正/负偏移图层在边缘漏画。
    x0: Math.max(0, Math.floor((camera.x - halfW - offsetX) / tileW) - 1),
    y0: Math.max(0, Math.floor((camera.y - halfH - offsetY) / tileH) - 1),
    x1: Math.min(map.width, Math.ceil((camera.x + halfW - offsetX) / tileW) + 1),
    y1: Math.min(map.height, Math.ceil((camera.y + halfH - offsetY) / tileH) + 1),
  }
}

/** 将视口中心限制在地图附近：允许四分之一视野的边缘空间，但不会把地图完全拖走。 */
function clampCamera(map: TmxMap, camera: MapCamera, viewport: ViewportSize): MapCamera {
  const mapW = Math.max(1, map.width * Math.max(1, map.tileWidth))
  const mapH = Math.max(1, map.height * Math.max(1, map.tileHeight))
  const halfW = viewport.width / (2 * camera.zoom)
  const halfH = viewport.height / (2 * camera.zoom)
  const minX = mapW <= halfW * 2 ? mapW / 2 : halfW * 0.75
  const maxX = mapW <= halfW * 2 ? mapW / 2 : mapW - halfW * 0.75
  const minY = mapH <= halfH * 2 ? mapH / 2 : halfH * 0.75
  const maxY = mapH <= halfH * 2 ? mapH / 2 : mapH - halfH * 0.75
  return { ...camera, x: Math.min(maxX, Math.max(minX, camera.x)), y: Math.min(maxY, Math.max(minY, camera.y)) }
}

export function MapViewer({ path, rootPath, content, initialCamera, onCameraChange }: MapViewerProps) {
  const [map, setMap] = useState<TmxMap | null>(null)
  const [layers, setLayers] = useState<Array<{ layer: TmxLayer; gids: Uint32Array }>>([])
  const [tilesets, setTilesets] = useState<LoadedTileset[]>([])
  const [issues, setIssues] = useState<TmxCheckIssue[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 最后完整加载的内容：新内容加载中时不把旧地图错配显示出来。 */
  const [loadedContent, setLoadedContent] = useState<string | null>(null)
  const [viewport, setViewport] = useState<ViewportSize>({ width: 900, height: 560 })
  const [camera, setCamera] = useState<MapCamera | null>(initialCamera ?? null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const viewportValueRef = useRef(viewport)
  const mapValueRef = useRef<TmxMap | null>(null)
  // 同一标签重新挂载时读取 session 镜头；之后不因父层回传而重载地图资源。
  const initialCameraRef = useRef(initialCamera)
  const dragging = useRef<{ x: number; y: number; camera: MapCamera } | null>(null)

  useEffect(() => {
    const node = viewportRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      const next = { width: Math.max(1, Math.floor(box.width)), height: Math.max(180, Math.floor(box.height)) }
      viewportValueRef.current = next
      setViewport(next)
      setCamera((current) => {
        if (!current || !mapValueRef.current) return current
        const clamped = clampCamera(mapValueRef.current, current, next)
        return clamped.x === current.x && clamped.y === current.y && clamped.zoom === current.zoom ? current : clamped
      })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    mapValueRef.current = null
    void (async () => {
      try {
        const parsed = parseTmx(content)
        if (!parsed) throw new Error('不是有效的 TMX 地图文件（缺少 <map> 根元素）')
        const mapDir = mapDirFromPaths(path, rootPath)
        const scan = await getBridge().mod.scanResources(rootPath).catch(() => null)
        if (!alive) return
        const check = await checkTmx(parsed, { projectFiles: new Set(scan?.files ?? []), mapDir })
        if (!alive) return
        const allTileLayers = parsed.layers.filter((layer) => layer.kind === 'tile')
        const isLargeMap = parsed.width * parsed.height > MAX_VISIBLE_TILES
        // 超大图总览先只解码 Ground：保证立即有可用预览，避免多层大数组同时占满主线程/内存。
        // 正常尺寸地图仍解码全部可见瓦片层，保留完整真实图层渲染。
        const layersToDecode = isLargeMap
          ? allTileLayers.filter((layer) => layer.name.toLowerCase() === 'ground').slice(0, 1)
          : allTileLayers
        const decoded = await Promise.all(layersToDecode.map(async (layer) => ({ layer, gids: await decodeLayerGids(layer) })))
        if (!alive) return
        const usableLayers = decoded.flatMap((item) => item.gids ? [{ layer: item.layer, gids: item.gids }] : [])
        const resourceWarnings: string[] = []
        if (isLargeMap && allTileLayers.length > layersToDecode.length) {
          resourceWarnings.push('地图较大：为避免打开时卡顿，当前总览仅解码并绘制 Ground 图层')
        }
        if (isLargeMap && layersToDecode.length === 0 && allTileLayers.length > 0) {
          resourceWarnings.push('地图较大但没有 Ground 图层，无法生成安全总览')
        }
        if (usableLayers.length < layersToDecode.length) {
          resourceWarnings.push('部分瓦片层数据无法解码，已跳过这些图层')
        }
        // 只加载实际被图层 gid 引用的图块集。大地图常带大量单位/阵营图块集，
        // 预先解码全部图片既慢又会把 data URL 内存放大。
        const usedTilesets = new Set<TmxTileset>()
        for (const { gids } of usableLayers) {
          // 图层已在 decode 上限内；完整扫描保证任意稀有 gid 对应的 tileset 也会真实加载，
          // 放大后不会悄悄退化成占位色。
          for (const rawGid of gids) {
            const hit = resolveTilesetForGid(rawGid, parsed.tilesets)
            if (hit) usedTilesets.add(hit.tileset)
          }
        }
        const loaded: LoadedTileset[] = []
        let loadedImagePixels = 0
        const reserveImage = (candidate: HTMLImageElement | null, label: string): HTMLImageElement | null => {
          if (!candidate) return null
          const pixels = candidate.naturalWidth * candidate.naturalHeight
          if (loadedImagePixels + pixels > MAX_TOTAL_TILESET_PIXELS) {
            resourceWarnings.push(`图块集 ${label} 超出本地图累计图像像素预算，已降级为占位色`)
            return null
          }
          loadedImagePixels += pixels
          return candidate
        }
        for (const original of parsed.tilesets.filter((tileset) => usedTilesets.has(tileset))) {
          let tileset = original
          let sourceDir = mapDir
          if (original.source) {
            const tsxRel = resolveProjectReference(mapDir, original.source)
            if (!tsxRel) {
              resourceWarnings.push(`图块集路径无效：${original.source}`)
              loaded.push({ tileset, image: null })
              continue
            }
            try {
              const tsx = await getBridge().project.readFile(rootPath, joinProjectPath(rootPath, tsxRel))
              if (!alive) return
              const parsedTsx = parseTsx(tsx.content, original.firstGid)
              if (!parsedTsx) throw new Error('TSX 格式无效')
              tileset = parsedTsx
              sourceDir = tsxRel.includes('/') ? tsxRel.slice(0, tsxRel.lastIndexOf('/')) : ''
            } catch (err) {
              resourceWarnings.push(`无法读取图块集 ${original.source}：${err instanceof Error ? err.message : String(err)}`)
            }
          }
          let image: HTMLImageElement | null = null
          if (tileset.collectionOfImages) {
            resourceWarnings.push(`图块集 ${tileset.name ?? original.firstGid} 使用逐图图片（collection-of-images），当前以占位色显示`)
          } else if (tileset.embeddedPng) {
            const base64 = tileset.embeddedPng.replace(/\s+/g, '')
            if (base64.length > MAX_EMBEDDED_BASE64_CHARS) {
              resourceWarnings.push(`内嵌图块集 ${tileset.name ?? original.firstGid} 超过 20MB 安全上限，已降级为占位色`)
            } else {
              image = reserveImage(await loadImage(`data:image/png;base64,${base64}`), tileset.name ?? String(original.firstGid))
              if (!alive) return
            }
          } else if (tileset.imageSource) {
            const imageRel = resolveProjectReference(sourceDir, tileset.imageSource)
            if (!imageRel) {
              resourceWarnings.push(`图块图片路径无效：${tileset.imageSource}`)
            } else {
              try {
                const dataUrl = await getBridge().project.readImageAsDataUrl(rootPath, joinProjectPath(rootPath, imageRel))
                if (!alive) return
                image = reserveImage(await loadImage(dataUrl), tileset.name ?? String(original.firstGid))
                if (!alive) return
              } catch (err) {
                resourceWarnings.push(`无法读取图块图片 ${imageRel}：${err instanceof Error ? err.message : String(err)}`)
              }
            }
          }
          if (!image && (tileset.embeddedPng || tileset.imageSource)) resourceWarnings.push(`图块集 ${tileset.name ?? original.source ?? original.firstGid} 将以占位色显示`)
          loaded.push({ tileset, image })
        }
        if (!alive) return
        mapValueRef.current = parsed
        setMap(parsed)
        setLayers(usableLayers)
        setTilesets(loaded)
        setIssues(check.issues)
        setWarnings(resourceWarnings)
        setError(null)
        setLoadedContent(content)
        setCamera((current) => current ? clampCamera(parsed, current, viewportValueRef.current) : initialCameraRef.current ? clampCamera(parsed, initialCameraRef.current, viewportValueRef.current) : fitCamera(parsed, viewportValueRef.current))
      } catch (err) {
        if (alive) {
          setError(`读取地图失败：${err instanceof Error ? err.message : String(err)}`)
          setLoadedContent(content)
        }
      }
    })()
    return () => { alive = false }
  }, [content, path, rootPath])

  useEffect(() => {
    if (camera) onCameraChange?.(camera)
  }, [camera, onCameraChange])

  const overview = useMemo(() => {
    if (!map || !camera) return false
    const bounds = layerBounds(map, camera, viewport)
    const count = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0) * Math.max(1, layers.length)
    // 小图的 fit zoom 可能低于 0.25，仍应画真实图块；只有图块已小于像素
    // 或单帧可见量过大时进入采样总览。
    return map.infinite || map.orientation !== 'orthogonal' || count > MAX_VISIBLE_TILES || Math.min(map.tileWidth, map.tileHeight) * camera.zoom < 1
  }, [camera, layers.length, map, viewport])

  useEffect(() => {
    if (!map || !camera || !canvasRef.current) return
    const canvas = canvasRef.current
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    // backing store 有 2048px 硬上限，但逻辑坐标始终使用真实 viewport 尺寸。
    // 大窗口被 CSS 放大时不会造成相机/鼠标坐标与绘制内容错位。
    canvas.width = Math.max(1, Math.min(2048, Math.floor(viewport.width * dpr)))
    canvas.height = Math.max(1, Math.min(2048, Math.floor(viewport.height * dpr)))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cssW = viewport.width
    const cssH = viewport.height
    ctx.setTransform(canvas.width / cssW, 0, 0, canvas.height / cssH, 0, 0)
    ctx.fillStyle = '#181c22'
    ctx.fillRect(0, 0, cssW, cssH)

    if (overview) {
      const plan = planMapOverview(map.width, map.height, Math.min(OVERVIEW_EDGE, Math.floor(cssW)), Math.min(OVERVIEW_EDGE, Math.floor(cssH)))
      const ox = (cssW - plan.width) / 2
      const oy = (cssH - plan.height) / 2
      const primary = layers.find((item) => item.layer.visible !== false) ?? layers[0]
      if (primary) {
        for (let py = 0; py < plan.height; py++) for (let px = 0; px < plan.width; px++) {
          const x = Math.min(map.width - 1, Math.floor((px + 0.5) * plan.stepX))
          const y = Math.min(map.height - 1, Math.floor((py + 0.5) * plan.stepY))
          const gid = primary.gids[y * map.width + x] ?? 0
          // 总览同样用真实图块缩小采样；资源缺失时 drawTile 才降级颜色。
          drawTile(ctx, gid, tilesets, ox + px, oy + py, 1, 1)
        }
      }
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.strokeRect(ox - .5, oy - .5, plan.width + 1, plan.height + 1)
      return
    }

    ctx.save()
    ctx.translate(cssW / 2 - camera.x * camera.zoom, cssH / 2 - camera.y * camera.zoom)
    ctx.scale(camera.zoom, camera.zoom)
    for (const { layer, gids } of layers) {
      if (layer.visible === false) continue
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1))
      const offsetX = (layer.x ?? 0) * map.tileWidth + (layer.offsetX ?? 0)
      const offsetY = (layer.y ?? 0) * map.tileHeight + (layer.offsetY ?? 0)
      const bounds = layerBounds(map, camera, { width: cssW, height: cssH }, offsetX, offsetY)
      for (let y = bounds.y0; y < bounds.y1; y++) for (let x = bounds.x0; x < bounds.x1; x++) {
        const gid = gids[y * map.width + x] ?? 0
        if (decodeTiledGid(gid).gid === 0) continue
        drawTile(ctx, gid, tilesets, x * map.tileWidth + offsetX, y * map.tileHeight + offsetY, map.tileWidth, map.tileHeight)
      }
    }
    ctx.restore()
  }, [camera, layers, map, overview, tilesets, viewport])

  const resetFit = () => { if (map) setCamera(fitCamera(map, viewport)) }
  const zoomBy = (factor: number, anchor?: { x: number; y: number }) => setCamera((current) => {
    if (!current || !map) return current
    const zoom = Math.max(0.01, Math.min(16, current.zoom * factor))
    if (!anchor) return clampCamera(map, { ...current, zoom }, viewport)
    // 鼠标下的地图坐标保持不动：缩放不会让用户正在查看的目标跳走。
    const mapX = current.x + (anchor.x - viewport.width / 2) / current.zoom
    const mapY = current.y + (anchor.y - viewport.height / 2) / current.zoom
    return clampCamera(map, { x: mapX - (anchor.x - viewport.width / 2) / zoom, y: mapY - (anchor.y - viewport.height / 2) / zoom, zoom }, viewport)
  })
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, { x: event.clientX - rect.left, y: event.clientY - rect.top })
  }
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!camera || overview || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = { x: event.clientX, y: event.clientY, camera }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragging.current
    if (!drag || !map) return
    setCamera(clampCamera(map, { ...drag.camera, x: drag.camera.x - (event.clientX - drag.x) / drag.camera.zoom, y: drag.camera.y - (event.clientY - drag.y) / drag.camera.zoom }, viewport))
  }
  const onPointerUp = () => { dragging.current = null }

  const exportNormalized = async (): Promise<void> => {
    const normalized = normalizeTmx(content)
    if (!normalized) return
    const name = toPosix(path).split('/').pop() ?? 'map.tmx'
    await getBridge().project.saveText('导出规范化 TMX', name, normalized)
  }
  const summary = map ? `${map.layers.length} 层 · ${layers.length} 个可绘制瓦片层 · ${tilesets.length} 个图块集` : ''
  const overlayMessage = map?.infinite
    ? '无限地图（chunk）当前仅保留检查信息，真实瓦片预览暂不支持'
    : map?.orientation !== 'orthogonal'
      ? '当前仅支持正交地图真实渲染；保留总览与检查信息'
      : overview
        ? '地图较大，显示安全采样总览；放大后会按视口绘制真实图块'
        : null

  if (loadedContent !== content) return <div className="map-viewer map-viewer-loading">正在解析地图与图块资源…</div>
  if (error) return <div className="map-viewer map-viewer-error">{error}</div>
  if (!map || !camera) return <div className="map-viewer map-viewer-loading">正在解析地图与图块资源…</div>

  return <div className="map-viewer">
    <div className="map-viewer-head">
      <span className="map-viewer-title">{toPosix(path).split('/').pop()}</span>
      <span className="map-viewer-meta">{map.width}×{map.height} · 瓦片 {map.tileWidth}×{map.tileHeight} · {map.orientation}</span>
      <span className="grow" />
      <button className="btn" onClick={() => void exportNormalized()}><AppIcon name="download" size={12} /> 规范化导出</button>
    </div>
    <div className="map-viewer-render-toolbar">
      <span className={`map-viewer-render-mode${overview ? ' overview' : ''}`}>{overview ? '自适应总览' : '真实图块'}</span>
      <span className="map-viewer-meta">{Math.round(camera.zoom * 100)}%</span>
      <span className="grow" />
      <button className="icon-btn" title="适应地图" onClick={resetFit}><AppIcon name="expand" size={13} /></button>
      <button className="icon-btn" title="缩小" onClick={() => zoomBy(1 / 1.25)}>−</button>
      <button className="icon-btn" title="原始瓦片大小" onClick={() => zoomBy(1 / camera.zoom)}>100%</button>
      <button className="icon-btn" title="放大" onClick={() => zoomBy(1.25)}>+</button>
    </div>
    <div ref={viewportRef} className="map-render-viewport">
      <canvas ref={canvasRef} className="map-viewer-canvas" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      {overlayMessage && <div className="map-render-overlay">{overlayMessage}</div>}
    </div>
    {warnings.length > 0 && <div className="map-viewer-warning">{warnings.map((warning) => <div key={warning}>⚠ {warning}</div>)}</div>}
    <div className="map-viewer-section"><div className="map-viewer-section-title">地图信息</div><div className="map-viewer-meta">{summary}</div></div>
    <div className="map-viewer-section"><div className="map-viewer-section-title">检查结果 <span className={`map-viewer-badge${issues.some((i) => i.severity === 'error') ? ' bad' : ''}`}>{issues.length === 0 ? '✓ 通过' : `${issues.filter((i) => i.severity === 'error').length} 错误 / ${issues.filter((i) => i.severity === 'warning').length} 警告`}</span></div>{issues.length === 0 ? <div className="map-viewer-ok">未发现问题</div> : <ul className="map-viewer-issues">{issues.map((item, index) => <li key={index} className={`map-viewer-issue map-viewer-issue-${item.severity}`}>{item.severity === 'error' ? '✕' : '⚠'} {item.message}</li>)}</ul>}</div>
  </div>
}
