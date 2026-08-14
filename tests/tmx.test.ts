/**
 * TMX 地图轻量闭环（M15，任务 5）测试：解析/检查/解码。
 */
import { describe, expect, it } from 'vitest'
import { canPreviewSafely, checkTmx, decodedTileCount, parseSimpleXml, parseTmx } from '../src/features/map/tmx'

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
