/**
 * 模组关系图（M20，P2 任务 4）测试：单位 → 图片/音效/弹体/炮塔引用提取、
 * 悬空引用标记、跨模组引用（ROOT:/CUSTOM:/SHARED:）、多帧/多行去重。
 */
import { describe, expect, it } from 'vitest'
import { buildRelationGraph } from '../src/features/graph/relationGraph'

function fakeBridge(files: Record<string, string>) {
  const ROOT = '/fake/root'
  void ROOT
  return {
    mod: {
      scanResources: async () => ({
        files: [...Object.keys(files), 'images/rifle.png', 'sounds/shoot.ogg'],
        unitNames: ['步枪兵', '坦克'],
      }),
    },
    project: {
      // 真实桥要求项目内绝对路径：fake 把前缀剥掉模拟
      readFile: async (_root: string, file: string) => ({ content: files[file.replace(/^\/fake\/root\//, '')] ?? '' }),
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
image_shadow: images/missing_shadow.png
[attack]
shoot_sound: 机枪
[action]
convertTo: landFactory
[turret_1]
x: 10
y: 20
image: images/rifle.png
[resource_1]
displayText: 弹药
image: images/missing_ammo.png
`

const ROOT_REF_CONTENT = `[core]
name: 重装兵
[graphics]
image: ROOT:units/other_mod/icon.png
image_wreak: SHARED:explosions/fire.png;CUSTOM:mymod/extra.png
`

const NON_UNIT_CONTENT = `[resource_1]
displayText: 资源
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

    // 单位引用：builtFrom 坦克（存在）
    const tank = unit.refs.find((r) => r.kind === 'unit' && r.target === '坦克')
    expect(tank?.missing).toBe(false)
    // requiredUnit 引擎无此键（幽灵键）→ 不再产出引用边
    expect(unit.refs.some((r) => r.kind === 'unit' && r.target === '不存在的单位')).toBe(false)
    // action 节 convertTo: landFactory → 游戏内置单位（BUILTIN_UNITS）不标缺失
    const landFactory = unit.refs.find((r) => r.kind === 'unit' && r.target === 'landFactory')
    expect(landFactory?.missing).toBe(false)

    // 炮塔引用
    const turret = unit.refs.find((r) => r.kind === 'turret' && r.target === 'turret_1')
    expect(turret).toBeDefined()
    expect(turret!.lines[0]).toBe(13)

    // 悬空汇总
    expect(g.missingRefs.map((m) => m.ref).sort()).toEqual(['images/missing_ammo.png', 'images/missing_shadow.png'])
    expect(g.totalRefs).toBe(unit.refs.length)
  })

  it('requiredUnit 是幽灵键（引擎无此键）不再产出引用边；convertTo/spawnUnit 真实键仍产出', async () => {
    const content = `[core]
name: 幽灵测试
requiredUnit: ghostUnitA
convertTo: ghostUnitB
spawnUnit: ghostUnitC
`
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/ghost.ini': content }))
    const unit = g.units[0]
    const targets = unit.refs.filter((r) => r.kind === 'unit').map((r) => r.target)
    // requiredUnit 不再产出引用边
    expect(targets).not.toContain('ghostUnitA')
    // convertTo/spawnUnit 真实键仍产出引用边（且悬空标红）
    expect(targets).toContain('ghostUnitB')
    expect(targets).toContain('ghostUnitC')
    expect(g.missingRefs.some((m) => m.ref === 'ghostUnitA')).toBe(false)
    expect(g.missingRefs.some((m) => m.ref === 'ghostUnitB')).toBe(true)
    expect(g.missingRefs.some((m) => m.ref === 'ghostUnitC')).toBe(true)
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

  it('大小写不敏感 + 反斜杠归一化的资源存在性判定（Windows 文件系统）', async () => {
    const content = UNIT_CONTENT.replace('images/rifle.png', 'Images\\Rifle.PNG')
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/rifle.ini': content }))
    const image = g.units[0].refs.find((r) => r.kind === 'image')
    expect(image?.missing).toBe(false)
  })

  it('NONE/AUTO 与 ${变量} 不构成资源引用（单位无引用则不进图）', async () => {
    const content = `[core]
name: 测试
[graphics]
image: NONE
image_wreak: AUTO
image_shadow: \${shadow}_1.png
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

  it('spawnUnits 参数/数量语法剥除：参数段不误当引用名，单位名正常检出', async () => {
    const content = `[core]\nname: x\nspawnUnits: 开馈赠(spawnChance=0.2,maxSpawnLimit=1),坦克*2\n`
    const g = await buildRelationGraph('/fake/root', {}, fakeBridge({ 'units/ghost.ini': content }))
    const unit = g.units[0]
    const targets = unit.refs.filter((r) => r.kind === 'unit').map((r) => r.target)
    // 坦克 在项目内 → 存在；开馈赠 不在项目 → 悬空
    expect(targets).toContain('坦克')
    const tank = unit.refs.find((r) => r.kind === 'unit' && r.target === '坦克')
    expect(tank?.missing).toBe(false)
    expect(g.missingRefs.some((m) => m.ref === '开馈赠')).toBe(true)
    // 参数段与 *数量 不残留成引用名（旧实现按裸逗号拆，maxSpawnLimit=1) 会误标红）
    expect(targets.some((t) => t.includes('spawnChance'))).toBe(false)
    expect(targets.some((t) => t.includes('*'))).toBe(false)
  })
})
