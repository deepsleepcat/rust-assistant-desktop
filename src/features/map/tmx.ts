/**
 * TMX 地图轻量解析与检查：纯数据解析、图块 gid 解码、引用路径与安全总览规划。
 * 解析器不依赖 DOM，供测试与渲染层共同使用。
 */

export interface SimpleXmlNode {
  tag: string
  attrs: Record<string, string>
  children: SimpleXmlNode[]
  text: string
}

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(ENTITY_RE, (m, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] as string
    const code = dec !== undefined ? Number(dec) : parseInt(hex as string, 16)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

/** 轻量 XML 解析（TMX 子集）：元素/属性/文本/注释/CDATA/自闭合。 */
export function parseSimpleXml(xml: string): SimpleXmlNode | null {
  if (!xml || xml.length > MAX_XML_BYTES) return null
  let pos = 0
  let nodeCount = 0
  const root = parseElement(0)
  if (!root) return null
  // 根元素后只能有空白、注释或处理指令；不能悄悄吞掉第二个根/普通尾随文本。
  for (;;) {
    pos += /^\s*/.exec(xml.slice(pos))?.[0].length ?? 0
    if (pos >= xml.length) return root
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
    return null
  }

  function parseElement(depth: number): SimpleXmlNode | null {
    if (depth > 200 || ++nodeCount > MAX_XML_NODES) return null
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
      if (xml.startsWith('<![CDATA[', pos)) {
        const end = xml.indexOf(']]>', pos)
        if (end < 0) return null
        pos = end + 3
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
      // Tiled/TSX 通常用双引号，但 XML 合法的单引号也应解析（第三方地图常见）。
      const nameMatch = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml.slice(pos))
      if (!nameMatch || nameMatch[1] in attrs) return null
      attrs[nameMatch[1]] = decodeEntities(nameMatch[2] ?? nameMatch[3] ?? '')
      pos += nameMatch[0].length
    }
    if (xml.startsWith('/>', pos)) {
      pos += 2
      return { tag, attrs, children: [], text: '' }
    }
    pos++

    const node: SimpleXmlNode = { tag, attrs, children: [], text: '' }
    for (;;) {
      const lt = xml.indexOf('<', pos)
      if (lt < 0) return null
      if (lt > pos) node.text += decodeEntities(xml.slice(pos, lt))
      pos = lt
      if (xml.startsWith('</', pos)) {
        const close = /^<\/([a-zA-Z0-9_:.-]+)\s*>/.exec(xml.slice(pos))
        if (!close || close[1] !== tag) return null
        pos += close[0].length
        return node
      }
      if (xml.startsWith('<!--', pos)) {
        const end = xml.indexOf('-->', pos)
        if (end < 0) return null
        pos = end + 3
        continue
      }
      if (xml.startsWith('<![CDATA[', pos)) {
        const end = xml.indexOf(']]>', pos)
        if (end < 0) return null
        node.text += xml.slice(pos + 9, end)
        pos = end + 3
        continue
      }
      const child = parseElement(depth + 1)
      if (!child) return null
      node.children.push(child)
    }
  }
}

export interface TmxLayer {
  name: string
  kind: 'tile' | 'objectgroup'
  /** CSV/base64 原始数据；XML 编码的 gid 存在 xmlGids。 */
  data?: string
  encoding?: string
  compression?: string
  /** XML <tile gid="..."/> 的原始 uint32 gid，保留翻转标记。 */
  xmlGids?: Uint32Array
  /** XML tile gid 存在非法整数或超出安全上限；解码时必须拒绝而不是静默改成 0。 */
  xmlDataInvalid?: boolean
  /** 以下四项由 parseTmx 填充；可选以兼容旧调用方构造的最小 layer。 */
  visible?: boolean
  opacity?: number
  x?: number
  y?: number
  offsetX?: number
  offsetY?: number
  objectCount?: number
}

export interface TmxTileset {
  firstGid: number
  name?: string
  /** 外部图块集引用（.tsx 文件）。 */
  source?: string
  tileWidth?: number
  tileHeight?: number
  tileCount?: number
  columns?: number
  spacing?: number
  margin?: number
  imageSource?: string
  imageWidth?: number
  imageHeight?: number
  /** collection-of-images tileset：每个 <tile> 自带 image，本期只提示、不伪装成图集支持。 */
  collectionOfImages?: boolean
  /** embedded_png 属性的原始 base64 字符串，不在数据层解码。 */
  embeddedPng?: string
}

export interface TmxMap {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
  orientation: string
  /** Tiled infinite="1" 使用 chunk 数据，本期保留检查信息但不做真实瓦片渲染。 */
  infinite: boolean
  layers: TmxLayer[]
  tilesets: TmxTileset[]
  raw: string
}

export interface TmxCheckIssue {
  severity: 'error' | 'warning'
  message: string
}

export interface TmxCheckResult {
  ok: boolean
  issues: TmxCheckIssue[]
}

const TILE_FLIP_H = 0x80000000
const TILE_FLIP_V = 0x40000000
const TILE_FLIP_D = 0x20000000
/** Tiled 在 hexagonal 地图使用的 120° 旋转标志；正交渲染不应用它，但必须从 gid 剥离。 */
const TILE_ROTATED_HEX120 = 0x10000000
const TILE_GID_MASK = 0x0fffffff
/** 单个图层安全解码上限：8M gid = 32MB Uint32Array，避免压缩炸弹/超大图耗尽 renderer。 */
const MAX_DECODED_GIDS = 8_000_000
const MAX_DECODED_TILE_BYTES = MAX_DECODED_GIDS * 4
const MAX_BASE64_CHARS = Math.ceil(MAX_DECODED_TILE_BYTES * 4 / 3) + 4096
const MAX_XML_BYTES = 64 * 1024 * 1024
const MAX_XML_NODES = 100_000

function numberAttr(attrs: Record<string, string>, key: string, fallback = 0): number {
  const value = Number(attrs[key])
  return Number.isFinite(value) ? value : fallback
}

function booleanAttr(attrs: Record<string, string>, key: string, fallback: boolean): boolean {
  const value = attrs[key]
  return value === undefined ? fallback : value !== '0' && value.toLowerCase() !== 'false'
}

function parseUint32(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : null
}

/** TMX map 尺寸必须是正整数；限制到可被 UI/Canvas 安全表示的范围。 */
function positiveMapInteger(attrs: Record<string, string>, key: string): number {
  const value = Number(attrs[key])
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : 0
}

function parseTilesetNode(node: SimpleXmlNode, fallbackFirstGid = 1): TmxTileset {
  const image = node.children.find((child) => child.tag.toLowerCase() === 'image')
  // Rusted Warfare 导出的 TMX 把大块 base64 放在 <properties><property
  // name="embedded_png">...</property></properties>，不是标准 <image> 属性。
  const property = node.children
    .find((child) => child.tag.toLowerCase() === 'properties')
    ?.children.find((child) => child.tag.toLowerCase() === 'property' && child.attrs['name'] === 'embedded_png')
  const embeddedPng = image?.attrs['embedded_png'] ?? node.attrs['embedded_png'] ?? property?.attrs['value'] ?? property?.text.trim()
  const collectionOfImages = !image && node.children.some((child) => child.tag.toLowerCase() === 'tile' && child.children.some((nested) => nested.tag.toLowerCase() === 'image'))
  return {
    firstGid: numberAttr(node.attrs, 'firstgid', fallbackFirstGid),
    name: node.attrs['name'],
    source: node.attrs['source'],
    tileWidth: node.attrs['tilewidth'] === undefined ? undefined : numberAttr(node.attrs, 'tilewidth'),
    tileHeight: node.attrs['tileheight'] === undefined ? undefined : numberAttr(node.attrs, 'tileheight'),
    tileCount: node.attrs['tilecount'] === undefined ? undefined : numberAttr(node.attrs, 'tilecount'),
    columns: node.attrs['columns'] === undefined ? undefined : numberAttr(node.attrs, 'columns'),
    spacing: numberAttr(node.attrs, 'spacing'),
    margin: numberAttr(node.attrs, 'margin'),
    imageSource: image?.attrs['source'],
    imageWidth: image ? numberAttr(image.attrs, 'width') || undefined : undefined,
    imageHeight: image ? numberAttr(image.attrs, 'height') || undefined : undefined,
    collectionOfImages,
    embeddedPng,
  }
}

/** 解析外部 TSX；参数 firstGid 来自 TMX 中引用它的 <tileset>。 */
export function parseTsx(xml: string, firstGid = 1): TmxTileset | null {
  const root = parseSimpleXml(xml)
  if (!root || root.tag.toLowerCase() !== 'tileset') return null
  return { ...parseTilesetNode(root, firstGid), firstGid }
}

/** 解析 TMX：返回 null 表示不是合法地图 XML。 */
export function parseTmx(xml: string): TmxMap | null {
  if (!xml) return null
  const root = parseSimpleXml(xml)
  if (!root || root.tag.toLowerCase() !== 'map') return null

  const layers: TmxLayer[] = []
  const tilesets: TmxTileset[] = []
  for (const child of root.children) {
    const tag = child.tag.toLowerCase()
    if (tag === 'layer') {
      if (layers.length >= 128) return null
      const dataEl = child.children.find((candidate) => candidate.tag.toLowerCase() === 'data')
      const xmlTiles = dataEl?.children.filter((candidate) => candidate.tag.toLowerCase() === 'tile') ?? []
      const xmlValues = !dataEl?.attrs['encoding'] && xmlTiles.length > 0
        ? xmlTiles.map((tile) => parseUint32(tile.attrs['gid']))
        : undefined
      const xmlDataInvalid = xmlValues?.some((gid) => gid === null) ?? false
      const xmlGids = xmlValues && !xmlDataInvalid && xmlValues.length <= MAX_DECODED_GIDS
        ? Uint32Array.from(xmlValues as number[])
        : undefined
      layers.push({
        name: child.attrs['name'] ?? '',
        kind: 'tile',
        data: dataEl?.text ?? undefined,
        encoding: dataEl?.attrs['encoding'],
        compression: dataEl?.attrs['compression'],
        xmlGids,
        xmlDataInvalid: xmlDataInvalid || (xmlValues?.length ?? 0) > MAX_DECODED_GIDS,
        visible: booleanAttr(child.attrs, 'visible', true),
        opacity: numberAttr(child.attrs, 'opacity', 1),
        x: numberAttr(child.attrs, 'x'),
        y: numberAttr(child.attrs, 'y'),
        offsetX: numberAttr(child.attrs, 'offsetx'),
        offsetY: numberAttr(child.attrs, 'offsety'),
      })
    } else if (tag === 'objectgroup') {
      if (layers.length >= 128) return null
      layers.push({
        name: child.attrs['name'] ?? '',
        kind: 'objectgroup',
        objectCount: child.children.filter((candidate) => candidate.tag.toLowerCase() === 'object').length,
        visible: booleanAttr(child.attrs, 'visible', true),
        opacity: numberAttr(child.attrs, 'opacity', 1),
        x: numberAttr(child.attrs, 'x'),
        y: numberAttr(child.attrs, 'y'),
        offsetX: numberAttr(child.attrs, 'offsetx'),
        offsetY: numberAttr(child.attrs, 'offsety'),
      })
    } else if (tag === 'tileset') {
      if (tilesets.length >= 256) return null
      tilesets.push(parseTilesetNode(child))
    }
  }

  return {
    width: positiveMapInteger(root.attrs, 'width'),
    height: positiveMapInteger(root.attrs, 'height'),
    tileWidth: positiveMapInteger(root.attrs, 'tilewidth'),
    tileHeight: positiveMapInteger(root.attrs, 'tileheight'),
    orientation: root.attrs['orientation'] ?? 'orthogonal',
    infinite: booleanAttr(root.attrs, 'infinite', false),
    layers,
    tilesets,
    raw: xml,
  }
}

/** XML 文本/属性转义（base64/CSV 数据不受影响）。 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 把解析树重新序列化为整洁 XML。 */
export function serializeSimpleXml(node: SimpleXmlNode): string {
  const attrStr = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('')
  if (node.children.length === 0 && !node.text) return `<${node.tag}${attrStr}/>`
  const inner = node.children.map((child) => serializeSimpleXml(child)).join('') + (node.text ? escapeXml(node.text) : '')
  return `<${node.tag}${attrStr}>${inner}</${node.tag}>`
}

/** 规范化 TMX；返回 null 表示不是合法地图 XML。 */
export function normalizeTmx(xml: string): string | null {
  const root = parseSimpleXml(xml)
  if (!root || root.tag.toLowerCase() !== 'map') return null
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeSimpleXml(root)}`
}

/**
 * 规范化项目内相对路径。拒绝绝对路径、盘符路径及任何越过项目根的 ..。
 * 空路径不是可引用的项目文件，返回 null。
 */
export function normalizeProjectRelativePath(ref: string): string | null {
  if (!ref || /^[\\/]/.test(ref) || /^[a-zA-Z]:/.test(ref)) return null
  const parts: string[] = []
  for (const segment of ref.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      // 交给主进程做最终 realpath 校验前，先拒绝不可见控制字符和 Windows 设备名。
      // eslint-disable-next-line no-control-regex -- 文件引用中的控制字符不可见且会破坏路径语义，必须拒绝。
      if (/[\x00-\x1f]/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) return null
      parts.push(segment)
    }
  }
  return parts.length > 0 ? parts.join('/') : null
}

/** 将地图目录与引用拼接后规范化，允许 ref 在地图目录范围内使用 ../。 */
export function resolveProjectReference(baseDir: string, ref: string): string | null {
  if (!ref || /^[\\/]/.test(ref) || /^[a-zA-Z]:/.test(ref)) return null
  const normalizedBase = baseDir ? normalizeProjectRelativePath(baseDir) : ''
  if (baseDir && !normalizedBase) return null
  return normalizeProjectRelativePath(normalizedBase ? `${normalizedBase}/${ref}` : ref)
}

/** 检查地图（tileset source 的存在性由 projectFiles 提供）。 */
export async function checkTmx(
  map: TmxMap,
  options: { projectFiles?: ReadonlySet<string>; mapDir?: string } = {},
): Promise<TmxCheckResult> {
  const issues: TmxCheckIssue[] = []
  if (map.width <= 0 || map.height <= 0 || map.tileWidth <= 0 || map.tileHeight <= 0) {
    issues.push({ severity: 'error', message: '地图尺寸无效（width/height/tilewidth/tileheight 必须为正整数）' })
  }
  if (map.infinite) {
    issues.push({ severity: 'warning', message: '无限地图（chunk）当前仅保留检查信息，真实瓦片预览暂不支持' })
  }

  const groundLayer = map.layers.find((layer) => layer.kind === 'tile' && layer.name.toLowerCase() === 'ground')
  if (!groundLayer) {
    issues.push({ severity: 'warning', message: '缺少 Ground 瓦片层（游戏可能无法识别地形）' })
  } else if (map.width > 0 && map.height > 0) {
    const tileCount = await decodedTileCount(groundLayer)
    if (tileCount === null) {
      issues.push({
        severity: 'error',
        message: `Ground 层数据无法解码（encoding=${groundLayer.encoding ?? 'xml'} compression=${groundLayer.compression ?? '无'}），游戏可能无法加载`,
      })
    } else if (tileCount !== map.width * map.height) {
      issues.push({
        severity: 'error',
        message: `Ground 层瓦片数 ${tileCount} 与地图尺寸 ${map.width}×${map.height}（需 ${map.width * map.height}）不符，地形未铺满`,
      })
    }
  }

  const hasTriggers = map.layers.some((layer) => layer.kind === 'objectgroup' && layer.name.toLowerCase() === 'triggers')
  if (!hasTriggers) issues.push({ severity: 'warning', message: '缺少 Triggers 对象层（触发器/出生点等对象放这里）' })

  if (options.projectFiles) {
    const projectFiles = new Set<string>()
    for (const file of options.projectFiles) {
      const normalized = normalizeProjectRelativePath(file)
      if (normalized) projectFiles.add(normalized.toLowerCase())
    }
    for (const tileset of map.tilesets) {
      if (!tileset.source) continue
      const ref = resolveProjectReference(options.mapDir ?? '', tileset.source)
      if (!ref) {
        issues.push({ severity: 'error', message: `图块集引用路径无效：${tileset.source}` })
      } else if (!projectFiles.has(ref.toLowerCase())) {
        issues.push({ severity: 'error', message: `图块集引用文件不存在：${ref}` })
      }
    }
  }
  return { ok: issues.every((issue) => issue.severity !== 'error'), issues }
}

function base64Bytes(data: string): Uint8Array | null {
  try {
    const clean = data.replace(/\s+/g, '')
    if (!clean || clean.length > MAX_BASE64_CHARS) return null
    const binary = atob(clean)
    if (binary.length > MAX_DECODED_TILE_BYTES) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

function uint32LittleEndian(bytes: Uint8Array): Uint32Array | null {
  if (bytes.byteLength % 4 !== 0 || bytes.byteLength > MAX_DECODED_TILE_BYTES) return null
  const result = new Uint32Array(bytes.byteLength / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < result.length; index++) result[index] = view.getUint32(index * 4, true)
  return result
}

/**
 * CSV gid 流式解析：不使用 split/map，避免大型地图产生海量临时字符串。
 * 仅允许数字、逗号和空白；最后一个逗号可省略/保留，中间空 gid 一律拒绝。
 */
function scanCsvGids(data: string, target?: Uint32Array): number | null {
  let count = 0
  let value = 0
  let digits = 0
  let sawComma = false
  let whitespaceAfterDigits = false
  const finish = (): boolean => {
    if (digits === 0 || count >= MAX_DECODED_GIDS) return false
    if (target) target[count] = value
    count++
    return true
  }
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code >= 48 && code <= 57) {
      if (digits > 0 && whitespaceAfterDigits) return null
      value = value * 10 + code - 48
      if (value > 0xffffffff) return null
      digits++
      sawComma = false
      whitespaceAfterDigits = false
      continue
    }
    if (code === 44) {
      if (!finish()) return null
      value = 0
      digits = 0
      sawComma = true
      whitespaceAfterDigits = false
      continue
    }
    // 空白只允许出现在 token 前后，不能把 1 2 静默拼接为 12。
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      if (digits > 0) whitespaceAfterDigits = true
      continue
    }
    return null
  }
  if (digits > 0) {
    if (!finish()) return null
  } else if (!sawComma || count === 0) {
    return null
  }
  return count
}

function decodeCsvGids(data: string): Uint32Array | null {
  // 两遍字符扫描：第一遍计数、第二遍写入 Uint32Array，不为大型地图额外保留 number[]。
  const count = scanCsvGids(data)
  if (!count) return null
  const gids = new Uint32Array(count)
  return scanCsvGids(data, gids) === count ? gids : null
}

/** 解码瓦片层 gid；未知编码、缺失数据或损坏数据返回 null。 */
export async function decodeLayerGids(layer: TmxLayer): Promise<Uint32Array | null> {
  if (layer.xmlDataInvalid) return null
  if (layer.xmlGids) return layer.xmlGids
  if (layer.encoding === undefined) return null
  if (layer.encoding === 'csv') {
    if (layer.data === undefined) return null
    return decodeCsvGids(layer.data)
  }
  if (layer.encoding !== 'base64' || layer.data === undefined) return null
  let bytes = base64Bytes(layer.data)
  if (!bytes) return null
  if (layer.compression && layer.compression !== 'none') {
    if (layer.compression !== 'gzip' && layer.compression !== 'zlib') return null
    bytes = await inflateBytes(bytes)
    if (!bytes) return null
  }
  return uint32LittleEndian(bytes)
}

/** 解码瓦片层数据并返回瓦片数；检查阶段不额外分配 Uint32Array。
 * 保留旧 xmlTileCount 参数兼容旧调用方。 */
export async function decodedTileCount(layer: TmxLayer, xmlTileCount?: number): Promise<number | null> {
  if (layer.xmlDataInvalid) return null
  if (layer.xmlGids) return layer.xmlGids.length
  if (layer.encoding === undefined) return xmlTileCount ?? null
  if (layer.data === undefined) return null
  if (layer.encoding === 'csv') return scanCsvGids(layer.data)
  if (layer.encoding !== 'base64') return null
  let bytes = base64Bytes(layer.data)
  if (!bytes) return null
  if (layer.compression && layer.compression !== 'none') {
    if (layer.compression !== 'gzip' && layer.compression !== 'zlib') return null
    bytes = await inflateBytes(bytes)
    if (!bytes) return null
  }
  return bytes.byteLength % 4 === 0 && bytes.byteLength <= MAX_DECODED_TILE_BYTES ? bytes.byteLength / 4 : null
}

/** gzip/zlib 解压（DecompressionStream；Chromium 与 Node 18+ 均有）。
 * 使用 reader 累积并限制输出，防小型压缩输入膨胀为超大 Uint32Array。 */
export async function inflateBytes(bytes: Uint8Array, maxBytes = MAX_DECODED_TILE_BYTES): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined' || bytes.byteLength > maxBytes || maxBytes <= 0) return null
  try {
    for (const format of ['gzip', 'deflate'] as const) {
      try {
        const stream = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]).stream()
          .pipeThrough(new DecompressionStream(format))
        const reader = stream.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            return null
          }
          chunks.push(value)
        }
        const output = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          output.set(chunk, offset)
          offset += chunk.byteLength
        }
        return output
      } catch {
        // 尝试另一种压缩包装格式。
      }
    }
  } catch {
    // 浏览器不支持流式解压时按无法解码处理。
  }
  return null
}

/** 从 Tiled raw gid 分离翻转标记与清理后的全局 gid。 */
export function decodeTiledGid(raw: number): { gid: number; flipH: boolean; flipV: boolean; flipD: boolean; rotateHex120: boolean } {
  const value = raw >>> 0
  return {
    gid: value & TILE_GID_MASK,
    flipH: (value & TILE_FLIP_H) !== 0,
    flipV: (value & TILE_FLIP_V) !== 0,
    flipD: (value & TILE_FLIP_D) !== 0,
    rotateHex120: (value & TILE_ROTATED_HEX120) !== 0,
  }
}

/**
 * 正交 Tiled H/V/D flag 的单位方格仿射矩阵。
 * Tiled 的 D 是沿反对角线翻转；其后依次施加 H/V。返回值可直接用于
 * ctx.transform(a,b,c,d,e,f)，再在 0..1 目标方格内绘制图块，因此非正方 tile
 * 不会被 90° 旋转时的宽高交换拉伸。
 */
export function tiledGidTransform(raw: number): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const { flipH, flipV, flipD } = decodeTiledGid(raw)
  const h = flipH ? -1 : 1
  const v = flipV ? -1 : 1
  if (!flipD) return { a: h, b: 0, c: 0, d: v, e: flipH ? 1 : 0, f: flipV ? 1 : 0 }
  // D alone: x'=1-y, y'=1-x。H/V 按 Tiled 规则在 D 之后作用。
  return {
    a: 0,
    b: flipV ? 1 : -1,
    c: flipH ? 1 : -1,
    d: 0,
    e: flipH ? 0 : 1,
    f: flipV ? 0 : 1,
  }
}

/** 按最大的 firstGid <= 清理后 gid 查找图块集。 */
export function resolveTilesetForGid(rawGid: number, tilesets: readonly TmxTileset[]): { tileset: TmxTileset; localId: number } | null {
  const gid = decodeTiledGid(rawGid).gid
  if (gid === 0) return null
  let selected: TmxTileset | null = null
  for (const tileset of tilesets) {
    if (Number.isInteger(tileset.firstGid) && tileset.firstGid > 0 && tileset.firstGid <= gid
      && (!selected || tileset.firstGid > selected.firstGid)) selected = tileset
  }
  if (!selected) return null
  const localId = gid - selected.firstGid
  // 有 tileCount 时，两个 tileset firstgid 之间的空洞不是前一个图块集的有效图块。
  if (selected.tileCount !== undefined && localId >= selected.tileCount) return null
  return { tileset: selected, localId }
}

/** 返回图块在 tileset 图像中的源矩形；元数据不足或 localId 非法时返回 null。 */
export function tileSourceRect(tileset: TmxTileset, localId: number): { sx: number; sy: number; sw: number; sh: number } | null {
  const tileWidth = tileset.tileWidth ?? 0
  const tileHeight = tileset.tileHeight ?? 0
  const spacing = tileset.spacing ?? 0
  const margin = tileset.margin ?? 0
  if (!Number.isInteger(localId) || localId < 0 || tileWidth <= 0 || tileHeight <= 0 || spacing < 0 || margin < 0) return null
  if (tileset.tileCount !== undefined && (!Number.isInteger(tileset.tileCount) || tileset.tileCount < 0 || localId >= tileset.tileCount)) return null

  let columns = tileset.columns ?? 0
  if (!Number.isInteger(columns) || columns <= 0) {
    if (!tileset.imageWidth || tileset.imageWidth <= 0) return null
    columns = Math.floor((tileset.imageWidth - margin * 2 + spacing) / (tileWidth + spacing))
  }
  if (columns <= 0) return null

  const sx = margin + (localId % columns) * (tileWidth + spacing)
  const sy = margin + Math.floor(localId / columns) * (tileHeight + spacing)
  if (tileset.imageWidth !== undefined && sx + tileWidth > tileset.imageWidth - margin) return null
  if (tileset.imageHeight !== undefined && sy + tileHeight > tileset.imageHeight - margin) return null
  return { sx, sy, sw: tileWidth, sh: tileHeight }
}

/** 为固定总览画布规划按地图单元采样的尺寸，避免极端长宽比触发画布尺寸上限。 */
export function planMapOverview(width: number, height: number, maxWidth = 1024, maxHeight = 1024): { width: number; height: number; stepX: number; stepY: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 0, height: 0, stepX: 0, stepY: 0 }
  const sourceWidth = Math.floor(width)
  const sourceHeight = Math.floor(height)
  const limitWidth = Math.max(1, Math.floor(Number.isFinite(maxWidth) ? maxWidth : 1024))
  const limitHeight = Math.max(1, Math.floor(Number.isFinite(maxHeight) ? maxHeight : 1024))
  const scale = Math.min(1, limitWidth / sourceWidth, limitHeight / sourceHeight)
  const overviewWidth = Math.min(limitWidth, Math.max(1, Math.floor(sourceWidth * scale)))
  const overviewHeight = Math.min(limitHeight, Math.max(1, Math.floor(sourceHeight * scale)))
  return { width: overviewWidth, height: overviewHeight, stepX: sourceWidth / overviewWidth, stepY: sourceHeight / overviewHeight }
}

/** 地图可安全预览（尺寸合理 + 层数有限，防超大地图卡渲染）。 */
export function canPreviewSafely(map: TmxMap): boolean {
  return map.width > 0 && map.height > 0 && map.width * map.height <= 100_000 && map.layers.length <= 64
}
