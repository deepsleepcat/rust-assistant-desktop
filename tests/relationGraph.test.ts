/**
 * 模组关系图（M20，P2 任务 4）测试：单位 → 图片/音效/弹体/炮塔引用提取、
 * 悬空引用标记、跨模组引用（ROOT:/CUSTOM:/SHARED:）、多帧/多行去重。
 */
import { describe, expect, it } from 'vitest'
import { buildRelationGraph } from '../src/features/graph/relationGraph'

function fakeBridge(files: Record<string, string>) {
  return {
    mod: {
      scanResources: async () => ({
        files: [...Object.keys(files), 'images/rifle.png', 'sounds/shoot.ogg'],
        unitNames: ['步枪兵', '坦克'],
      }),
    },
    project: {
      readFile: async (_root: string, file: string) => ({ content: files[file] ?? '' }),
    },
  }
}

const UNIT_CONTENT = `[core]
name: 步枪兵
maxHp: 200
builtFrom_1_name: 坦克
requiredUnit: 不存在的单位
[graphics]
image: images/rifle.png
shadowImage: images/missing_shadow.png
[attack]
shoot_sound: 机枪
[action]
convertTo: landFactory
[turret_1]
x: 10
y: 20
image: images/rifle.png
[resource_1]
displayName: 弹药
image: images/missing_ammo.png
`

const ROOT_REF_CONTENT = `[core]
name: 重装兵
[graphics]
image: ROOT:units/other_mod/icon.png
deathImage: SHARED:explosions/fire.png;CUSTOM:mymod/extra.png
`

const NON_UNIT_CONTENT = `[resource_1]
displayName: 资源
image: images/missing_ammo.png
`

describe('buildRelationGraph', () => {
  it('提取图片/音效/单位/炮塔引用，多行合并去重', async () => {
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/rifle.ini': UNIT_CONTENT }))
    expect(g.units.length).toBe(1)
    const unit = g.units[0]
    expect(unit.name).toBe('步枪兵')
    expect(unit.file).toBe('units/rifle.ini')

    const image = unit.refs.find((r) => r.kind === 'image' && r.target === 'images/rifle.png')
    expect(image).toBeDefined()
    expect(image!.lines).toEqual([7, 16]) // graphics.image + turret_1.image 合并
    expect(image!.missing).toBe(false)

    // 音效：shoot_sound 是码名（无扩展名）→ 不构成音效引用
    expect(unit.refs.some((r) => r.kind === 'audio')).toBe(false)

    // 单位引用：builtFrom 坦克（存在）+ requiredUnit 不存在（悬空）
    const tank = unit.refs.find((r) => r.kind === 'unit' && r.target === '坦克')
    expect(tank?.missing).toBe(false)
    const ghost = unit.refs.find((r) => r.kind === 'unit' && r.target === '不存在的单位')
    expect(ghost?.missing).toBe(true)
    // action 节 convertTo: landFactory → 游戏内置单位（BUILTIN_UNITS）不标缺失
    const landFactory = unit.refs.find((r) => r.kind === 'unit' && r.target === 'landFactory')
    expect(landFactory?.missing).toBe(false)

    // 炮塔引用
    const turret = unit.refs.find((r) => r.kind === 'turret' && r.target === 'turret_1')
    expect(turret).toBeDefined()
    expect(turret!.lines[0]).toBe(13)

    // 悬空汇总
    expect(g.missingRefs.map((m) => m.ref).sort()).toEqual(['images/missing_ammo.png', 'images/missing_shadow.png', '不存在的单位'])
    expect(g.totalRefs).toBe(unit.refs.length)
  })

  it('跨模组引用（ROOT:/CUSTOM:/SHARED:）不标缺失，聚合计数', async () => {
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/heavy.ini': ROOT_REF_CONTENT }))
    const unit = g.units[0]
    const root = unit.refs.find((r) => r.target === 'ROOT:units/other_mod/icon.png')
    expect(root?.crossMod).toBe(true)
    expect(root?.missing).toBe(false)
    // 多帧拆分：SHARED: + CUSTOM: 两条
    const shared = unit.refs.find((r) => r.target === 'SHARED:explosions/fire.png')
    const custom = unit.refs.find((r) => r.target === 'CUSTOM:mymod/extra.png')
    expect(shared?.crossMod).toBe(true)
    expect(custom?.crossMod).toBe(true)
    expect(g.crossModRefs.length).toBe(3)
    expect(g.crossModRefs.some((c) => c.ref === 'ROOT:units/other_mod/icon.png' && c.count === 1)).toBe(true)
    expect(g.missingRefs.length).toBe(0)
  })

  it('无 [core] 节的文件不是单位节点（不产出引用）', async () => {
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'resources/r.ini': NON_UNIT_CONTENT }))
    expect(g.units.length).toBe(0)
    expect(g.missingRefs.length).toBe(0)
  })

  it('大小写不敏感的资源存在性判定（Windows 文件系统）', async () => {
    const content = UNIT_CONTENT.replace('images/rifle.png', 'Images/Rifle.PNG')
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/rifle.ini': content }))
    const image = g.units[0].refs.find((r) => r.kind === 'image')
    expect(image?.missing).toBe(false)
  })

  it('NONE/AUTO 与 ${变量} 不构成资源引用（单位无引用则不进图）', async () => {
    const content = `[core]
name: 测试
[graphics]
image: NONE
deathImage: AUTO
shadowImage: \${shadow}_1.png
`
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/t.ini': content }))
    expect(g.units).toEqual([])
    expect(g.missingRefs).toEqual([])
  })

  it('进度回调按批推进', async () => {
    const seen: Array<[number, number]> = []
    await buildRelationGraph(
      '/fake/root',
      { onProgress: (d, t) => seen.push([d, t]) },
      fakeBridge({ 'units/a.ini': '[core]\nname: A\n', 'units/b.ini': '[core]\nname: B\n' }),
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toEqual([2, 2])
  })
})
