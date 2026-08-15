/**
 * TMX 地图轻量闭环（M15，任务 5）测试：解析/检查/解码。
 */
import { describe, expect, it } from 'vitest'
import { canPreviewSafely, checkTmx, decodedTileCount, normalizeTmx, parseSimpleXml, parseTmx, serializeSimpleXml } from '../src/features/map/tmx'

const CSV_MAP = `<?xml version="1.0"?>
<map version="1.2" orientation="orthogonal" width="10" height="8" tilewidth="32" tileheight="32">
  <tileset firstgid="1" name="ground" source="ground.tsx"/>
  <layer name="Ground" width="10" height="8">
    <data encoding="csv">
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1,
1,1,1,1,1,1,1,1,1,1
    </data>
  </layer>
  <layer name="Items" width="10" height="8">
    <data encoding="csv">
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0,
0,0,0,0,0,0,0,0,0,0
    </data>
  </layer>
  <objectgroup name="Triggers">
    <object id="1" x="100" y="100"/>
  </objectgroup>
</map>`

describe('parseSimpleXml', () => {
  it('解析元素/属性/文本/自闭合', () => {
    const root = parseSimpleXml('<map width="10"><layer name="Ground"><data encoding="csv">1,2</data></layer><objectgroup name="T"/></map>')!
    expect(root.tag).toBe('map')
    expect(root.attrs['width']).toBe('10')
    expect(root.children[0].tag).toBe('layer')
    expect(root.children[0].children[0].text).toBe('1,2')
    expect(root.children[1].tag).toBe('objectgroup')
  })

  it('注释与 XML 声明跳过', () => {
    const root = parseSimpleXml('<?xml version="1.0"?><!-- comment --><map width="5"/>')!
    expect(root.tag).toBe('map')
    expect(root.attrs['width']).toBe('5')
  })

  it('非 XML/损坏输入返回 null', () => {
    expect(parseSimpleXml('')).toBeNull()
    expect(parseSimpleXml('not xml')).toBeNull()
  })
})

describe('parseTmx', () => {
  it('解析元数据/图层/对象层/图块集', () => {
    const map = parseTmx(CSV_MAP)!
    expect(map.width).toBe(10)
    expect(map.height).toBe(8)
    expect(map.tileWidth).toBe(32)
    expect(map.layers.length).toBe(3)
    expect(map.layers[0].name).toBe('Ground')
    expect(map.layers[0].kind).toBe('tile')
    expect(map.layers[2].kind).toBe('objectgroup')
    expect(map.layers[2].objectCount).toBe(1)
    expect(map.tilesets[0].source).toBe('ground.tsx')
  })

  it('非地图 XML 返回 null', () => {
    expect(parseTmx('<html><body>x</body></html>')).toBeNull()
    expect(parseTmx('')).toBeNull()
  })
})

describe('checkTmx', () => {
  it('完整地图零问题（Ground 铺满 + Triggers 存在 + 图块集存在）', async () => {
    const map = parseTmx(CSV_MAP)!
    const result = await checkTmx(map, { projectFiles: new Set(['ground.tsx']) })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('Ground 未铺满报错', async () => {
    const bad = CSV_MAP.replace(/1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1,\n1,1,1,1,1,1,1,1,1,1/, '1,1,1,1,1,1,1,1,1,1')
    const map = parseTmx(bad)!
    const result = await checkTmx(map)
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('未铺满'))).toBe(true)
  })

  it('缺 Ground 层与 Triggers 层警告', async () => {
    const noLayers = `<?xml version="1.0"?><map width="4" height="4" tilewidth="32" tileheight="32"></map>`
    const map = parseTmx(noLayers)!
    const result = await checkTmx(map)
    expect(result.issues.some((i) => i.message.includes('Ground'))).toBe(true)
    expect(result.issues.some((i) => i.message.includes('Triggers'))).toBe(true)
  })

  it('图块集引用缺失报错（提供项目文件列表时）', async () => {
    const map = parseTmx(CSV_MAP)!
    const result = await checkTmx(map, { projectFiles: new Set(['other.tsx']) })
    expect(result.issues.some((i) => i.message.includes('ground.tsx'))).toBe(true)
  })

  it('gzip base64 数据解码（DecompressionStream 可用时）', async () => {
    const { gzipSync } = await import('node:zlib')
    // 80 个瓦片（10×8）→ 320 字节 uint32
    const tileData = new Uint32Array(80)
    for (let i = 0; i < 80; i++) tileData[i] = 1
    const raw = new Uint8Array(tileData.buffer)
    const gz = gzipSync(raw)
    const b64 = Buffer.from(gz).toString('base64')
    const layer = { name: 'Ground', kind: 'tile' as const, data: b64, encoding: 'base64', compression: 'gzip' }
    if (typeof DecompressionStream !== 'undefined') {
      expect(await decodedTileCount(layer)).toBe(80)
    } else {
      // Node 无 DecompressionStream：降级返回 null（不崩）
      expect(await decodedTileCount(layer)).toBeNull()
    }
  })
})

describe('canPreviewSafely', () => {
  it('尺寸合理可预览；超大/空地图拒绝', () => {
    const map = parseTmx(CSV_MAP)!
    expect(canPreviewSafely(map)).toBe(true)
    const huge = parseTmx('<map width="1000" height="1000" tilewidth="32" tileheight="32"></map>')!
    expect(canPreviewSafely(huge)).toBe(false)
  })
})

describe('M15 审查修复回归', () => {
  it('子目录地图的图块集引用按地图目录解析（标准 maps/ 布局）', async () => {
    const map = parseTmx(CSV_MAP)!
    // 地图在 maps/level.tmx：source="ground.tsx" → 实际文件 maps/ground.tsx
    const ok = await checkTmx(map, { projectFiles: new Set(['maps/ground.tsx']), mapDir: 'maps' })
    expect(ok.issues.some((i) => i.message.includes('ground.tsx'))).toBe(false)
    const bad = await checkTmx(map, { projectFiles: new Set(['ground.tsx']), mapDir: 'maps' })
    expect(bad.issues.some((i) => i.message.includes('maps/ground.tsx'))).toBe(true)
  })

  it('XML 编码 data（tile 子元素）计入瓦片数', async () => {
    const xml = `<map version="1.2" width="2" height="2" tilewidth="32" tileheight="32">
  <layer name="Ground"><data><tile gid="1"/><tile gid="1"/><tile gid="0"/><tile gid="1"/></data></layer>
</map>`
    const map = parseTmx(xml)!
    const result = await checkTmx(map)
    expect(result.ok).toBe(true)
  })

  it('CDATA 包裹的数据可解析', () => {
    const xml = `<map version="1.2" width="2" height="2"><layer name="Ground"><data><![CDATA[1,1,1,1]]></data></layer></map>`
    const map = parseTmx(xml)!
    expect(map.layers[0].data).toBe('1,1,1,1')
  })

  it('深度嵌套 XML 解析器有上限（不爆栈）', () => {
    const deep = '<a>'.repeat(500) + '</a>'.repeat(500)
    expect(parseSimpleXml(deep)).toBeNull()
  })

  it('属性值含 > 不误截断', () => {
    const root = parseSimpleXml('<map name="a>b"><layer/></map>')!
    expect(root.attrs['name']).toBe('a>b')
    expect(root.children.length).toBe(1)
  })
})

// ── M24 双向桥接：规范化导出（round-trip 不丢数据）────────────────
describe('normalizeTmx / serializeSimpleXml（M24 双向桥接）', () => {
  const MAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 地图注释（会被规范化丢弃，不影响数据） -->
<map version="1.9" orientation="orthogonal" width="32" height="24" tilewidth="32" tileheight="32">
  <tileset firstgid="1" name="ground" source="ground.tsx"/>
  <layer id="1" name="Ground" width="32" height="24">
    <data encoding="csv">
1,2,3,4,
5,6,7,8
</data>
  </layer>
  <objectgroup id="2" name="Triggers">
    <object id="1" x="64" y="128" width="32" height="32">
      <properties>
        <property name="type" value="spawn"/>
      </properties>
    </object>
  </objectgroup>
</map>
`

  it('规范化导出后 round-trip：图层/对象/图块集/数据完整一致', () => {
    const normalized = normalizeTmx(MAP_XML)
    expect(normalized).not.toBeNull()
    const before = parseTmx(MAP_XML)!
    const after = parseTmx(normalized!)!
    // 元数据
    expect(after.width).toBe(before.width)
    expect(after.height).toBe(before.height)
    expect(after.orientation).toBe(before.orientation)
    // 图块集（含外部引用 source）
    expect(after.tilesets).toEqual(before.tilesets)
    expect(after.tilesets[0].source).toBe('ground.tsx')
    // 图层与对象
    expect(after.layers.length).toBe(before.layers.length)
    expect(after.layers.map((l) => l.name)).toEqual(before.layers.map((l) => l.name))
    expect(after.layers.map((l) => l.kind)).toEqual(before.layers.map((l) => l.kind))
    // 瓦片层数据（CSV 文本原样保留——含行内换行与缩进）
    expect(after.layers[0].data).toBe(before.layers[0].data)
    expect(after.layers[1].objectCount).toBe(1)
    // 对象属性（properties → property）保留
    expect(normalized!).toContain('value="spawn"')
  })

  it('gzip base64 数据区原样保留（无 XML 特殊字符，转义不影响）', () => {
    const b64 = 'eJx7xMDAwMjAwPQcAAj/AfE='
    const xml = `<map version="1.9" orientation="orthogonal" width="8" height="8" tilewidth="32" tileheight="32">
  <tileset firstgid="1" name="ground" source="ground.tsx"/>
  <layer id="1" name="Ground" width="8" height="8">
    <data encoding="base64" compression="gzip">${b64}</data>
  </layer>
</map>
`
    const normalized = normalizeTmx(xml)!
    expect(normalized).toContain(b64)
    const after = parseTmx(normalized)!
    expect(after.layers[0].data).toBe(b64)
    expect(after.layers[0].encoding).toBe('base64')
    expect(after.layers[0].compression).toBe('gzip')
  })

  it('非法 XML/非 map 根返回 null（不抛错）', () => {
    expect(normalizeTmx('')).toBeNull()
    expect(normalizeTmx('<html></html>')).toBeNull()
    expect(normalizeTmx('<map><broken>')).toBeNull()
  })

  it('serializeSimpleXml：属性实体解码 + 转义后 round-trip 值一致', () => {
    const node = parseSimpleXml('<map name="a&quot;b &amp; c" width="8"/>')!
    // 解析器解码实体：属性值是真实字符
    expect(node.attrs['name']).toBe('a"b & c')
    const out = serializeSimpleXml(node)
    expect(out).toBe('<map name="a&quot;b &amp; c" width="8"/>')
    // 再解析回来属性值与解码后一致（导出 → 导入不丢不增）
    const again = parseSimpleXml(out)!
    expect(again.attrs).toEqual(node.attrs)
  })
})
