/**
 * TMX 地图轻量解析与检查（M15，P1 任务 5 地图轻量闭环）：
 * - parseSimpleXml：TMX 子集 XML 解析器（元素/属性/文本，无 DOM 依赖——
 *   测试与渲染层均可运行）；
 * - parseTmx：解析 → 元数据/图层/对象层/图块集；
 * - checkTmx：Ground 铺满 / Triggers 对象层缺失 / 图块集引用 / gzip base64 兼容；
 * - gzip base64 数据解压校验（DecompressionStream，Chromium/Node 均有）。
 * 不做完整地图编辑器——只做识别、预览、检查、打包桥接。
 */

export interface SimpleXmlNode {
  tag: string
  attrs: Record<string, string>
  children: SimpleXmlNode[]
  text: string
}

/** 轻量 XML 解析（TMX 子集）：元素/属性/文本/注释/自闭合。
 * 不做完整 XML 规范（无 CDATA/实体展开——TMX 数据区是纯文本，够用）。 */
export function parseSimpleXml(xml: string): SimpleXmlNode | null {
  let pos = 0
  const root = parseElement()
  return root
  function parseElement(): SimpleXmlNode | null {
    // 跳过空白/注释/声明
    for (;;) {
      const ws = /^\s*/.exec(xml.slice(pos))?.[0].length ?? 0
      pos += ws
      if (xml.startsWith('<!--', pos)) {
        const end = xml.indexOf('-->', pos)
        if (end < 0) return null
        pos = end + 3
        continue
      }
      if (xml.startsWith('<?', pos)) {
        const end = xml.indexOf('?>', pos)
        if (end < 0) return null
        pos = end + 2
        continue
      }
      break
    }
    if (xml[pos] !== '<') return null
    const tagStart = pos + 1
    const tagEnd = /[^a-zA-Z0-9_:.-]/.exec(xml.slice(tagStart))?.index
    if (tagEnd === undefined) return null
    const tag = xml.slice(tagStart, tagStart + tagEnd)
    pos = tagStart + tagEnd

    const attrs: Record<string, string> = {}
    for (;;) {
      const ws = /^\s*/.exec(xml.slice(pos))?.[0].length ?? 0
      pos += ws
      if (xml[pos] === '>' || xml.startsWith('/>', pos)) break
      const nameMatch = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=\s*"([^"]*)"/.exec(xml.slice(pos))
      if (!nameMatch) return null
      attrs[nameMatch[1]] = nameMatch[2]
      pos += nameMatch[0].length
    }
    if (xml.startsWith('/>', pos)) {
      pos += 2
      return { tag, attrs, children: [], text: '' }
    }
    pos++ // 跳过 '>'

    const node: SimpleXmlNode = { tag, attrs, children: [], text: '' }
    // 文本与子元素
    for (;;) {
      const lt = xml.indexOf('<', pos)
      if (lt < 0) return null
      if (lt > pos) node.text += xml.slice(pos, lt)
      pos = lt
      if (xml.startsWith('</', pos)) {
        const end = xml.indexOf('>', pos)
        if (end < 0) return null
        pos = end + 1
        return node
      }
      if (xml.startsWith('<!--', pos)) {
        const end = xml.indexOf('-->', pos)
        if (end < 0) return null
        pos = end + 3
        continue
      }
      const child = parseElement()
      if (!child) return null
      node.children.push(child)
    }
  }
}

export interface TmxLayer {
  name: string
  /** 图层类型：tile（瓦片层）/ objectgroup（对象层） */
  kind: 'tile' | 'objectgroup'
  /** 瓦片层数据（CSV 或 gzip base64，未解码） */
  data?: string
  /** data 编码方式 */
  encoding?: string
  compression?: string
  /** 对象层对象数（objectgroup） */
  objectCount?: number
}

export interface TmxTileset {
  firstGid: number
  name?: string
  /** 外部图块集引用（.tsx 文件） */
  source?: string
}

export interface TmxMap {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
  orientation: string
  layers: TmxLayer[]
  tilesets: TmxTileset[]
  /** 原始 XML（缩略图/预览用） */
  raw: string
}

export interface TmxCheckIssue {
  severity: 'error' | 'warning'
  message: string
}

/** 检查结果：ok + 问题清单 */
export interface TmxCheckResult {
  ok: boolean
  issues: TmxCheckIssue[]
}

/** 解析 TMX：返回 null 表示不是合法地图 XML */
export function parseTmx(xml: string): TmxMap | null {
  if (!xml || xml.length === 0) return null
  const root = parseSimpleXml(xml)
  if (!root || root.tag.toLowerCase() !== 'map') return null
  const num = (v: string | undefined, def = 0): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : def
  }

  const layers: TmxLayer[] = []
  const tilesets: TmxTileset[] = []

  for (const child of root.children) {
    const tag = child.tag.toLowerCase()
    if (tag === 'layer') {
      const dataEl = child.children.find((c) => c.tag.toLowerCase() === 'data')
      layers.push({
        name: child.attrs['name'] ?? '',
        kind: 'tile',
        data: dataEl?.text ?? undefined,
        encoding: dataEl?.attrs['encoding'],
        compression: dataEl?.attrs['compression'],
      })
    } else if (tag === 'objectgroup') {
      layers.push({
        name: child.attrs['name'] ?? '',
        kind: 'objectgroup',
        objectCount: child.children.filter((c) => c.tag.toLowerCase() === 'object').length,
      })
    } else if (tag === 'tileset') {
      tilesets.push({
        firstGid: num(child.attrs['firstgid'], 1),
        name: child.attrs['name'],
        source: child.attrs['source'],
      })
    }
  }

  return {
    width: num(root.attrs['width']),
    height: num(root.attrs['height']),
    tileWidth: num(root.attrs['tilewidth']),
    tileHeight: num(root.attrs['tileheight']),
    orientation: root.attrs['orientation'] ?? 'orthogonal',
    layers,
    tilesets,
    raw: xml,
  }
}

/** 检查地图（文件级；tileset source 存在性需要项目文件列表——由调用方传入） */
export async function checkTmx(
  map: TmxMap,
  options: { projectFiles?: ReadonlySet<string> } = {},
): Promise<TmxCheckResult> {
  const issues: TmxCheckIssue[] = []
  const projectFiles = options.projectFiles

  // 1) 尺寸合法性
  if (map.width <= 0 || map.height <= 0) {
    issues.push({ severity: 'error', message: '地图尺寸无效（width/height 必须为正）' })
  }

  // 2) Ground 铺满：找 Ground 瓦片层（大小写不敏感），检查 data 瓦片数 = width*height
  const groundLayer = map.layers.find((l) => l.kind === 'tile' && l.name.toLowerCase() === 'ground')
  if (!groundLayer) {
    issues.push({ severity: 'warning', message: '缺少 Ground 瓦片层（游戏可能无法识别地形）' })
  } else if (map.width > 0 && map.height > 0) {
    const tileCount = await decodedTileCount(groundLayer)
    if (tileCount === null) {
      issues.push({
        severity: 'error',
        message: `Ground 层数据无法解码（encoding=${groundLayer.encoding ?? 'csv'} compression=${groundLayer.compression ?? '无'}），游戏可能无法加载`,
      })
    } else if (tileCount !== map.width * map.height) {
      issues.push({
        severity: 'error',
        message: `Ground 层瓦片数 ${tileCount} 与地图尺寸 ${map.width}×${map.height}（需 ${map.width * map.height}）不符，地形未铺满`,
      })
    }
  }

  // 3) Triggers 对象层缺失
  const hasTriggers = map.layers.some((l) => l.kind === 'objectgroup' && l.name.toLowerCase() === 'triggers')
  if (!hasTriggers) {
    issues.push({ severity: 'warning', message: '缺少 Triggers 对象层（触发器/出生点等对象放这里）' })
  }

  // 4) 图块集引用有效性
  if (projectFiles) {
    for (const ts of map.tilesets) {
      if (ts.source && !projectFiles.has(ts.source)) {
        issues.push({ severity: 'error', message: `图块集引用文件不存在：${ts.source}` })
      }
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues }
}

/** 解码瓦片层数据并返回瓦片数；无法解码返回 null。
 * 支持 CSV 与 gzip/zlib base64（DecompressionStream 解压）；未知格式返回 null。 */
export async function decodedTileCount(layer: TmxLayer): Promise<number | null> {
  if (!layer.data) return 0
  const encoding = layer.encoding ?? 'csv'
  if (encoding === 'csv') {
    return layer.data.split(',').map((s) => s.trim()).filter(Boolean).length
  }
  if (encoding === 'base64') {
    try {
      const binary = atob(layer.data.replace(/\s+/g, ''))
      if (!layer.compression || layer.compression === 'none') {
        return Math.floor(binary.length / 4)
      }
      if (layer.compression === 'gzip' || layer.compression === 'zlib') {
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const out = await inflateBytes(bytes)
        return out === null ? null : Math.floor(out.length / 4)
      }
      return null
    } catch {
      return null
    }
  }
  return null
}

/** gzip/zlib 解压（DecompressionStream；Chromium 与 Node 18+ 均有） */
async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  try {
    // 先按 gzip 试（TMX 标准是 gzip）；失败再试 deflate（zlib 头部）
    for (const fmt of ['gzip', 'deflate'] as const) {
      try {
        const ds = new DecompressionStream(fmt)
        const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(ds)
        const buf = await new Response(stream).arrayBuffer()
        return new Uint8Array(buf)
      } catch {
        // 尝试下一种格式
      }
    }
    return null
  } catch {
    return null
  }
}

/** 地图可安全预览（尺寸合理 + 层数有限，防超大地图卡渲染） */
export function canPreviewSafely(map: TmxMap): boolean {
  return map.width > 0 && map.height > 0 && map.width * map.height <= 100_000 && map.layers.length <= 64
}
