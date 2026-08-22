import { describe, expect, it } from 'vitest'
import {
  checkTmx,
  decodeLayerGids,
  decodeTiledGid,
  normalizeProjectRelativePath,
  parseTmx,
  parseTsx,
  planMapOverview,
  resolveProjectReference,
  resolveTilesetForGid,
  tiledGidTransform,
  tileSourceRect,
} from '../src/features/map/tmx'

function base64Gids(values: number[]): string {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true))
  return Buffer.from(bytes).toString('base64')
}

describe('M36 tileset parsing', () => {
  it('parses inline tileset metadata and preserves embedded PNG base64', () => {
    const map = parseTmx(`<map width="2" height="1" tilewidth="16" tileheight="16">
      <tileset firstgid="5" name="inline" tilewidth="16" tileheight="16" tilecount="6" columns="3" spacing="2" margin="1">
        <image source="art/tiles.png" width="54" height="38" embedded_png="aGVsbG8="/>
      </tileset>
      <layer name="Ground"><data encoding="csv">5,6</data></layer>
    </map>`)!
    expect(map.tilesets[0]).toMatchObject({
      firstGid: 5,
      name: 'inline',
      tileWidth: 16,
      tileHeight: 16,
      tileCount: 6,
      columns: 3,
      spacing: 2,
      margin: 1,
      imageSource: 'art/tiles.png',
      imageWidth: 54,
      imageHeight: 38,
      embeddedPng: 'aGVsbG8=',
    })
  })

  it('parses Rusted Warfare embedded_png stored as a tileset property text node', () => {
    const map = parseTmx(`<map width="1" height="1" tilewidth="20" tileheight="20">
      <tileset firstgid="1" name="export_ground" columns="12" tilecount="360" tilewidth="20" tileheight="20">
        <properties><property name="embedded_png">aGVsbG8=</property></properties>
      </tileset>
      <layer name="Ground"><data encoding="csv">1</data></layer>
    </map>`)!
    expect(map.tilesets[0]).toMatchObject({ name: 'export_ground', embeddedPng: 'aGVsbG8=', columns: 12, tileCount: 360 })
  })

  it('parses TSX metadata using caller supplied firstgid', () => {
    const tileset = parseTsx(`<tileset name="external" tilewidth="32" tileheight="24" tilecount="4" columns="2">
      <image source="tiles.png" width="64" height="48" embedded_png="YWJj"/>
    </tileset>`, 17)!
    expect(tileset).toMatchObject({ firstGid: 17, name: 'external', tileWidth: 32, tileHeight: 24, tileCount: 4, columns: 2 })
    expect(tileset.imageSource).toBe('tiles.png')
    expect(tileset.embeddedPng).toBe('YWJj')
    expect(parseTsx('<map/>')).toBeNull()
  })
})

describe('M36 layer gid decoding', () => {
  it('retains XML gids and layer display/offset attributes', async () => {
    const map = parseTmx(`<map width="2" height="1" tilewidth="32" tileheight="32">
      <layer name="Ground" visible="0" opacity="0.5" x="3" y="4" offsetx="7" offsety="-8">
        <data><tile gid="2147483649"/><tile gid="2"/></data>
      </layer>
    </map>`)!
    const layer = map.layers[0]
    expect(Array.from(layer.xmlGids!)).toEqual([0x80000001, 2])
    expect(layer).toMatchObject({ visible: false, opacity: 0.5, x: 3, y: 4, offsetX: 7, offsetY: -8 })
    expect(Array.from((await decodeLayerGids(layer))!)).toEqual([0x80000001, 2])
  })

  it('decodes CSV and base64 little-endian gids and rejects corrupt inputs', async () => {
    expect(Array.from((await decodeLayerGids({ name: 'csv', kind: 'tile', encoding: 'csv', data: '1, 2147483649, 3' }))!))
      .toEqual([1, 0x80000001, 3])
    expect(Array.from((await decodeLayerGids({ name: 'b64', kind: 'tile', encoding: 'base64', data: base64Gids([1, 0x40000002]) }))!))
      .toEqual([1, 0x40000002])
    await expect(decodeLayerGids({ name: 'bad', kind: 'tile', encoding: 'csv', data: '1,nope' })).resolves.toBeNull()
    await expect(decodeLayerGids({ name: 'bad', kind: 'tile', encoding: 'csv', data: '1,,2' })).resolves.toBeNull()
    await expect(decodeLayerGids({ name: 'bad', kind: 'tile', encoding: 'csv', data: '1 2' })).resolves.toBeNull()
    await expect(decodeLayerGids({ name: 'bad', kind: 'tile', encoding: 'base64', data: 'AQ==' })).resolves.toBeNull()
  })

  it('decodes gzip and zlib base64 gids without losing flip bits', async () => {
    const { deflateSync, gzipSync } = await import('node:zlib')
    const raw = Buffer.from(base64Gids([0x80000001, 2]), 'base64')
    for (const [compression, bytes] of [['gzip', gzipSync(raw)], ['zlib', deflateSync(raw)]] as const) {
      const gids = await decodeLayerGids({ name: compression, kind: 'tile', encoding: 'base64', compression, data: Buffer.from(bytes).toString('base64') })
      expect(Array.from(gids ?? [])).toEqual([0x80000001, 2])
    }
  })
})

describe('M36 gid and source rectangle helpers', () => {
  it('separates Tiled flip flags and resolves the greatest matching firstgid', () => {
    expect(decodeTiledGid(0xe0000007)).toEqual({ gid: 7, flipH: true, flipV: true, flipD: true, rotateHex120: false })
    expect(decodeTiledGid(0x10000001)).toMatchObject({ gid: 1, rotateHex120: true })
    const a = { firstGid: 1, tileCount: 4 }
    const b = { firstGid: 5, tileCount: 4 }
    expect(resolveTilesetForGid(0x80000006, [a, b])).toEqual({ tileset: b, localId: 1 })
    expect(resolveTilesetForGid(4, [a, b])).toEqual({ tileset: a, localId: 3 })
    expect(resolveTilesetForGid(9, [a, b])).toBeNull() // tileCount 后的空洞不能误归属上一个图块集
    expect(resolveTilesetForGid(0, [a, b])).toBeNull()
  })

  it('uses all eight orthogonal H/V/D combinations as bounded unit-square matrices', () => {
    const matrices = new Set<string>()
    for (let flags = 0; flags < 8; flags++) {
      const raw = 1 | (flags & 1 ? 0x80000000 : 0) | (flags & 2 ? 0x40000000 : 0) | (flags & 4 ? 0x20000000 : 0)
      const t = tiledGidTransform(raw)
      matrices.add(JSON.stringify(t))
      for (const value of Object.values(t)) expect(Number.isFinite(value)).toBe(true)
    }
    expect(matrices.size).toBe(8)
    expect(tiledGidTransform(0x20000001)).toEqual({ a: 0, b: -1, c: -1, d: 0, e: 1, f: 1 })
  })

  it('calculates spacing/margin source rects and respects valid tile bounds', () => {
    const tileset = { firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 6, columns: 3, spacing: 2, margin: 1, imageWidth: 54, imageHeight: 38 }
    expect(tileSourceRect(tileset, 4)).toEqual({ sx: 19, sy: 19, sw: 16, sh: 16 })
    expect(tileSourceRect(tileset, 6)).toBeNull()
    expect(tileSourceRect({ ...tileset, tileCount: undefined, imageHeight: 20 }, 4)).toBeNull()
  })
})

describe('M36 project references and overview planning', () => {
  it('normalizes relative maps paths, resolves ../, and rejects absolute traversal', async () => {
    expect(normalizeProjectRelativePath('maps\\zone\\..\\tiles\\ground.tsx')).toBe('maps/tiles/ground.tsx')
    expect(normalizeProjectRelativePath('../ground.tsx')).toBeNull()
    expect(normalizeProjectRelativePath('C:\\maps\\ground.tsx')).toBeNull()
    expect(normalizeProjectRelativePath('/maps/ground.tsx')).toBeNull()
    expect(normalizeProjectRelativePath('maps/CON.tsx')).toBeNull()
    expect(normalizeProjectRelativePath('maps/\u0000ground.tsx')).toBeNull()
    expect(resolveProjectReference('maps\\levels', '..\\tiles\\ground.tsx')).toBe('maps/tiles/ground.tsx')
    expect(resolveProjectReference('maps', '../../ground.tsx')).toBeNull()

    const map = parseTmx(`<map width="1" height="1" tilewidth="16" tileheight="16"><tileset firstgid="1" source="..\\tiles\\ground.tsx"/>
      <layer name="Ground"><data encoding="csv">1</data></layer></map>`)!
    const result = await checkTmx(map, { mapDir: 'maps\\levels', projectFiles: new Set(['maps/tiles/ground.tsx']) })
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false)
    const caseVariant = await checkTmx(map, { mapDir: 'MAPS\\LEVELS', projectFiles: new Set(['Maps/Tiles/GROUND.tsx']) })
    expect(caseVariant.issues.some((issue) => issue.severity === 'error')).toBe(false)
  })

  it('rejects invalid XML gids and marks infinite maps as explicitly unsupported', async () => {
    const invalid = parseTmx('<map width="1" height="1" tilewidth="16" tileheight="16"><layer name="Ground"><data><tile gid="-1"/></data></layer></map>')!
    await expect(decodeLayerGids(invalid.layers[0])).resolves.toBeNull()
    expect(parseTmx('<map width="0.5" height="1" tilewidth="16" tileheight="16"/>')?.width).toBe(0)
    expect(parseTmx('<map width="1" height="1" tilewidth="16" tileheight="16"><layer></objectgroup></map>')).toBeNull()
    const infinite = parseTmx('<map infinite="1" width="1" height="1" tilewidth="16" tileheight="16"><layer name="Ground"><data><chunk x="0" y="0" width="1" height="1">1</chunk></data></layer></map>')!
    const issues = await checkTmx(infinite)
    expect(issues.issues.some((issue) => issue.message.includes('无限地图'))).toBe(true)
  })

  it('plans bounded, positive overviews for extreme aspect ratios', () => {
    for (const [sourceWidth, sourceHeight] of [[1, 100000], [100000, 1]] as const) {
      const overview = planMapOverview(sourceWidth, sourceHeight)
      expect(overview.width).toBeGreaterThanOrEqual(1)
      expect(overview.height).toBeGreaterThanOrEqual(1)
      expect(overview.width).toBeLessThanOrEqual(1024)
      expect(overview.height).toBeLessThanOrEqual(1024)
      expect(overview.stepX).toBeGreaterThan(0)
      expect(overview.stepY).toBeGreaterThan(0)
    }
  })
})
