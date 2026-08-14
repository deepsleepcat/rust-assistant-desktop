/**
 * M5 模组工具测试：模板内容、打包排除规则、单位检查逻辑。
 * M6.5：模板系统（listTemplates / buildFileFromTemplate / createUnitFromTemplate）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  buildModInfo,
  buildUnitSkeleton,
  isExcluded,
  createMod,
  createUnit,
  createUnitFromTemplate,
  importModBuffer,
  listTemplates,
  buildFileFromTemplate,
  packModBuffer,
  checkMod,
  runChainInspection,
  scanOptimization,
  applyOptimization,
  processSourceForPack,
  formatIniText,
  readModInfo,
  writeModInfo,
  buildTemplateFromFile,
  saveFileAsTemplate,
  scanResources,
  transcodeToOgg,
  globalOp,
} from '../electron/modTools'
import type { ChainRule, RawTemplate } from '../electron/modTools'
import { parseTurrets, updateTurretValue, findUnitImage } from '../src/features/editor/turretUtils'

function makeTempProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rust-modtools-'))
  return dir
}

describe('M5 模板生成', () => {
  it('mod-info.txt 包含必填与可选字段', () => {
    const info = buildModInfo({
      name: 'my-mod',
      title: '我的模组',
      description: '第一行\n第二行',
      author: '测试者',
      version: '1.2',
      thumbnail: 'icon.png',
    })
    expect(info).toContain('[mod]')
    expect(info).toContain('title: 我的模组')
    expect(info).toContain('description: 第一行\\n第二行')
    expect(info).toContain('author: 测试者')
    expect(info).toContain('version: 1.2')
    expect(info).toContain('thumbnail: icon.png')
    expect(info).toContain('minVersion: 1.15p9')
    expect(info).toContain('[music]')
    expect(info).toContain('[maps]')
  })

  it('单位骨架包含四个必备节', () => {
    const ini = buildUnitSkeleton('scout-tank', '侦察坦克')
    expect(ini).toContain('[core]')
    expect(ini).toContain('name: 侦察坦克')
    expect(ini).toContain('[graphics]')
    expect(ini).toContain('image: scout-tank.png')
    expect(ini).toContain('[attack]')
    expect(ini).toContain('[movement]')
    expect(ini).toContain('movementType: LAND')
  })
})

describe('M5 打包排除规则', () => {
  it('排除 .git、node_modules、临时文件与系统垃圾', () => {
    expect(isExcluded('.git/config')).toBe(true)
    expect(isExcluded('node_modules/pi/index.js')).toBe(true)
    expect(isExcluded('units/a.ini.tmp')).toBe(true)
    expect(isExcluded('Thumbs.db')).toBe(true)
    expect(isExcluded('units/hero.ini')).toBe(false)
    expect(isExcluded('mod-info.txt')).toBe(false)
  })

  it('打包结果不包含被排除的文件', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      mkdirSync(path.join(root, '.git'), { recursive: true })
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: t\n', 'utf8')
      writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\nname: a\n', 'utf8')
      writeFileSync(path.join(root, '.git', 'config'), 'secret', 'utf8')
      writeFileSync(path.join(root, 'units', 'a.ini.tmp'), 'junk', 'utf8')

      const buf = await packModBuffer(root)
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(buf)
      const names = Object.keys(zip.files)
      expect(names).toContain('mod-info.txt')
      expect(names).toContain('units/a.ini')
      expect(names.some((n) => n.includes('.git'))).toBe(false)
      expect(names.some((n) => n.endsWith('.tmp'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M5 新建模组与单位', () => {
  it('创建模组自述文件：只写 mod-info.txt，不生成单位', async () => {
    const root = makeTempProject()
    try {
      const { files } = await createMod(root, { title: '演示模组' })
      expect(files).toEqual(['mod-info.txt'])
      expect(readFileSync(path.join(root, 'mod-info.txt'), 'utf8')).toContain('title: 演示模组')
      // 不生成任何单位/示例目录
      expect(files.some((f) => f.endsWith('.ini'))).toBe(false)
      // 重复创建不覆盖已有内容
      await createMod(root, { title: '其他标题' })
      expect(readFileSync(path.join(root, 'mod-info.txt'), 'utf8')).toContain('title: 演示模组')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('新建单位生成骨架且不覆盖已有文件', async () => {
    const root = makeTempProject()
    try {
      const { path: rel } = await createUnit(root, { name: 'tank', displayName: '坦克' })
      expect(rel).toBe('tank/tank.ini')
      expect(readFileSync(path.join(root, rel), 'utf8')).toContain('name: 坦克')
      await expect(createUnit(root, { name: 'tank' })).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M5 单位检查', () => {
  it('检出缺失 name、重复 name 与正常单位', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'ok.ini'), '[core]\nname: 好单位\nmaxHp: 100\n', 'utf8')
      writeFileSync(path.join(root, 'units', 'dup-a.ini'), '[core]\nname: 重复\n', 'utf8')
      writeFileSync(path.join(root, 'units', 'dup-b.ini'), '[core]\nname: 重复\n', 'utf8')
      writeFileSync(path.join(root, 'units', 'no-name.ini'), '[core]\nmaxHp: 50\n', 'utf8')
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: x\n', 'utf8')

      const result = await checkMod(root)
      expect(result.unitCount).toBe(4)
      const messages = result.issues.map((i) => i.message).join(';')
      expect(messages).toContain('「重复」')
      expect(messages).toContain('name:（单位名必填）')
      expect(result.issues.some((i) => i.level === 'error')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('链式检查：canAttack=true 时提示补充可攻击目标键', () => {
    const rules: ChainRule[] = [
      { id: 'canAttack', key: 'canAttack', value: 'true', type: 'key', list: 'canAttackFlyingUnits,canAttackLandUnits,canAttackUnderwaterUnits' },
    ]
    const content = '[attack]\ncanAttack: true\n'
    const issues = runChainInspection(content, rules, 'units/a.ini')
    expect(issues.some((i) => i.message.includes('canAttackFlyingUnits'))).toBe(true)
    expect(issues.every((i) => i.level === 'warning')).toBe(true)
  })

  it('链式检查：canAttack=false 不触发', () => {
    const rules: ChainRule[] = [
      { id: 'canAttack', key: 'canAttack', value: 'true', type: 'key', list: 'canAttackFlyingUnits' },
    ]
    expect(runChainInspection('[attack]\ncanAttack: false\n', rules, 'a.ini')).toEqual([])
  })

  it('链式检查：section 规则匹配编号节（turret → turret_1）', () => {
    const rules: ChainRule[] = [{ id: 'turret-section', key: '', value: 'turret', type: 'section', list: 'x,y' }]
    // turret_1 节存在但缺 x,y → 警告
    const issues = runChainInspection('[turret_1]\nz: 5\n', rules, 'a.ini')
    expect(issues.some((i) => i.message.includes('turret_1') && i.message.includes('x'))).toBe(true)
    // 无 turret 节 → 不检查
    expect(runChainInspection('[core]\nname: a\n', rules, 'a.ini')).toEqual([])
    // 有 x,y → 通过
    expect(runChainInspection('[turret_2]\nx: 0\ny: 0\n', rules, 'a.ini')).toEqual([])
  })

  it('链式检查：@file 规则提示缺失的必备节', () => {
    const rules: ChainRule[] = [{ id: 'base', key: '', value: '', type: '@file', list: 'core,attack,graphics,movement' }]
    const issues = runChainInspection('[core]\nname: a\n', rules, 'a.ini')
    const missing = issues.map((i) => i.message).join(';')
    expect(missing).toContain('[attack]')
    expect(missing).toContain('[graphics]')
    expect(missing).not.toContain('[core]')
  })

  it('链式检查：@auto 键存在即触发，@tip 输出提示', () => {
    const rules: ChainRule[] = [
      { id: 'showInEditor', key: 'showInEditor', value: 'false', type: 'key', list: '@tip(无法在沙盒编辑器内显示此单位)' },
      { id: 'streamingCost', key: 'streamingCost', value: '@auto', type: 'key', list: 'buildSpeed' },
    ]
    const issues = runChainInspection('[core]\nshowInEditor: false\nstreamingCost: 1\n', rules, 'a.ini')
    const messages = issues.map((i) => i.message).join(';')
    expect(messages).toContain('无法在沙盒编辑器内显示此单位')
    expect(messages).toContain('streamingCost')
    expect(messages).toContain('buildSpeed')
    // @tip 是提示级别（info），不是警告
    const tip = issues.find((i) => i.message.includes('无法在沙盒编辑器'))
    expect(tip?.level).toBe('info')
  })
})

describe('M6.5 模板系统', () => {
  it('listTemplates 返回全部模板（≥16 个）', async () => {
    const metas = await listTemplates()
    expect(metas.length).toBeGreaterThanOrEqual(16)
    expect(metas[0]).toHaveProperty('key')
    expect(metas[0]).toHaveProperty('name')
    expect(metas[0]).toHaveProperty('actions')
    // 模板 data 中的默认值已提取
    const tank = metas.find((m) => m.key === 'base_tank_template')
    expect(tank).toBeDefined()
    expect(tank?.defaults['name-core']).toBe('基础坦克')
  })

  it('buildFileFromTemplate 用用户输入替换对应节字段，保留其余默认', () => {
    const raw: RawTemplate = {
      name: '测试模板',
      data: '[core]\nname: 基础坦克\nprice: 350\n\n[graphics]\nimage: tank.png',
      action: [
        { name: '名称', key: 'name', section: 'core', tag: 'name-core', type: 'input' },
        { name: '价格', key: 'price', section: 'core', tag: 'price-core', type: 'input' },
      ],
    }
    const out = buildFileFromTemplate(raw, { 'name-core': '侦察坦克', 'price-core': '500' })
    expect(out).toContain('name: 侦察坦克')
    expect(out).toContain('price: 500')
    expect(out).toContain('image: tank.png')
  })

  it('createUnitFromTemplate 写盘且不覆盖已有文件', async () => {
    const dir = makeTempProject()
    try {
      const { path: rel } = await createUnitFromTemplate(dir, {
        name: 'my-tank',
        templateKey: 'base_tank_template',
        values: { 'name-core': '我的坦克' },
      })
      expect(rel).toBe('my-tank/my-tank.ini')
      const content = readFileSync(path.join(dir, rel), 'utf8')
      expect(content).toContain('name: 我的坦克')
      expect(content).toContain('[graphics]')
      // 已存在时报错
      await expect(createUnitFromTemplate(dir, { name: 'my-tank', templateKey: 'base_tank_template', values: {} })).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('M6.5 导入 .rwmod', () => {
  it('打包 → 导入往返一致，且拒绝 zip-slip', async () => {
    const dir = makeTempProject()
    try {
      // 造一个模组目录并打包
      mkdirSync(path.join(dir, 'units', 'tank'), { recursive: true })
      writeFileSync(path.join(dir, 'mod-info.txt'), '[mod]\ntitle: 测试模组\n')
      writeFileSync(path.join(dir, 'units', 'tank', 'tank.ini'), '[core]\nname: 坦克\n')
      const buffer = await packModBuffer(dir)

      // 导入到新目录
      const dest = path.join(dir, 'imported')
      const { files } = await importModBuffer(buffer, dest)
      expect(files).toBe(2)
      expect(readFileSync(path.join(dest, 'mod-info.txt'), 'utf8')).toContain('title: 测试模组')
      expect(readFileSync(path.join(dest, 'units', 'tank', 'tank.ini'), 'utf8')).toContain('name: 坦克')

      // zip-slip 防护：../evil.txt 会被 JSZip 读取时规范化为 evil.txt（不会越界写盘）
      const evil = new JSZip()
      evil.file('../evil.txt', 'bad')
      const evilBuf = await evil.generateAsync({ type: 'nodebuffer' })
      const evilDest = path.join(dir, 'evil')
      await importModBuffer(Buffer.from(evilBuf), evilDest)
      // 文件只出现在目标目录内（被规范化为 evil.txt），父目录无残留
      expect(readFileSync(path.join(evilDest, 'evil.txt'), 'utf8')).toBe('bad')
      expect(() => readFileSync(path.join(dir, 'evil.txt'))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('M7 优化工具', () => {
  it('扫描出空文件/空文件夹/.bak/空行/注释', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      mkdirSync(path.join(root, 'empty-dir'), { recursive: true })
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: t\n\n', 'utf8') // 空行
      writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\n# 注释\nname: a\n\nmaxHp: 100\n', 'utf8') // 空行+注释
      writeFileSync(path.join(root, 'units', 'a.ini.bak'), 'backup', 'utf8') // 备份文件
      writeFileSync(path.join(root, 'units', 'empty.txt'), '', 'utf8') // 空文件

      const items = await scanOptimization(root)
      const kinds = new Map(items.map((i) => [i.kind, i]))
      expect(kinds.has('emptyFile')).toBe(true)
      expect(kinds.has('emptyFolder')).toBe(true)
      expect(kinds.has('backupFile')).toBe(true)
      expect(kinds.has('emptyLine')).toBe(true)
      expect(kinds.has('comment')).toBe(true)
      // 空行/注释 detail 记录条数
      expect(kinds.get('emptyLine')?.detail).toBe('2 行') // mod-info.txt 1 行 + a.ini 1 行
      expect(kinds.get('comment')?.detail).toBe('1 行')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('应用优化：删空文件/.bak、去空行与注释、删空文件夹', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      mkdirSync(path.join(root, 'empty-dir'), { recursive: true })
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: t\n', 'utf8')
      writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\n# 注释\nname: a\n\nmaxHp: 100\n', 'utf8')
      writeFileSync(path.join(root, 'units', 'a.ini.bak'), 'backup', 'utf8')
      writeFileSync(path.join(root, 'units', 'empty.txt'), '', 'utf8')

      const items = await scanOptimization(root)
      const ids = items.filter((i) => i.kind !== 'emptyLine').map((i) => i.id)
      const result = await applyOptimization(root, ids)
      expect(result.failed).toBe(0)

      // 空文件与 .bak 已删除
      expect(() => readFileSync(path.join(root, 'units', 'empty.txt'))).toThrow()
      expect(() => readFileSync(path.join(root, 'units', 'a.ini.bak'))).toThrow()
      // 空文件夹已删除
      expect(() => readFileSync(path.join(root, 'empty-dir'))).toThrow()
      // 未勾选空行 → 注释已去除但空行保留
      const content = readFileSync(path.join(root, 'units', 'a.ini'), 'utf8')
      expect(content).not.toContain('#')
      expect(content).toContain('\n\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('父目录因删文件变空时被一并清理', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units', 'trash'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'trash', 'x.txt'), '', 'utf8')
      const items = await scanOptimization(root)
      const emptyFile = items.find((i) => i.kind === 'emptyFile')
      expect(emptyFile).toBeTruthy()
      await applyOptimization(root, [emptyFile!.id])
      // trash 与 units 均因变空被清理
      expect(() => readFileSync(path.join(root, 'units', 'trash'))).toThrow()
      expect(() => readFileSync(path.join(root, 'units'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('只勾选空行时不会删除任何文件夹（prune 门控）', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'keep-me'), { recursive: true })
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\nname: a\n\nmaxHp: 100\n', 'utf8')
      const items = await scanOptimization(root)
      const emptyLine = items.find((i) => i.kind === 'emptyLine')
      expect(emptyLine).toBeTruthy()
      const result = await applyOptimization(root, [emptyLine!.id])
      expect(result.failed).toBe(0)
      // 只勾选空行：keep-me 空文件夹与 units 都不应被删
      expect(existsSync(path.join(root, 'keep-me'))).toBe(true)
      expect(readFileSync(path.join(root, 'units', 'a.ini'), 'utf8')).toContain('name: a')
      // 空行被去除
      const content = readFileSync(path.join(root, 'units', 'a.ini'), 'utf8')
      expect(content).not.toContain('\n\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('只含排除文件（Thumbs.db）的目录不误报为空文件夹', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'onlyjunk'), { recursive: true })
      writeFileSync(path.join(root, 'onlyjunk', 'Thumbs.db'), 'junk', 'utf8')
      const items = await scanOptimization(root)
      expect(items.some((i) => i.kind === 'emptyFolder' && i.rel === 'onlyjunk')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M7 打包选项', () => {
  it('processSourceForPack：去空行/去注释/格式化', () => {
    const src = '  [core]\n\nname: 坦克   \n# 注释\n\nmaxHp: 100\n'
    expect(processSourceForPack(src, {})).toBe(src)
    const noEmpty = processSourceForPack(src, { removeEmptyLines: true })
    expect(noEmpty).not.toContain('\n\n')
    const noComment = processSourceForPack(src, { removeComments: true })
    expect(noComment).not.toContain('# 注释')
    const formatted = processSourceForPack(src, { formatCode: true })
    expect(formatted).toContain('name: 坦克')
    expect(formatted).not.toContain('坦克   ')
  })

  it('formatIniText：节前留空行、key 规整', () => {
    const out = formatIniText('[core]\nname: 坦克\n\n[graphics]\nimage: a.png')
    const lines = out.split('\n')
    // 首节前无空行，第二节前有空行
    expect(lines[0]).toBe('[core]')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('[graphics]')
  })

  it('打包时按选项清理源文件内容', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: t\n')
      writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\n# 注释\nname: a\n\nmaxHp: 100\n')
      writeFileSync(path.join(root, 'units', 'empty.ini'), '  \n')

      const buf = await packModBuffer(root, { removeEmptyFiles: true, removeEmptyLines: true, removeComments: true })
      const zip = await JSZip.loadAsync(buf)
      // 空文件被排除
      expect(Object.keys(zip.files).some((n) => n.endsWith('empty.ini'))).toBe(false)
      // 注释与空行被清理
      const aIni = await zip.file('units/a.ini')!.async('string')
      expect(aIni).not.toContain('#')
      expect(aIni).not.toContain('\n\n')
      expect(aIni).toContain('name: a')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M7 mod-info 编辑', () => {
  it('readModInfo 解析各节与 music/maps 目录', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'music'), { recursive: true })
      mkdirSync(path.join(root, 'maps'), { recursive: true })
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: 我的模组\ndescription: 描述\nauthor: 作者\nversion: 2.0\nthumbnail: icon.png\nminVersion: 1.15p9\n\n[music]\nsourceFolder: music/\nwhenUsingUnitsFromThisMod_playExclusively: true\n\n[maps]\nsourceFolder: maps/\naddExtraMapsForPath: true\n', 'utf8')
      writeFileSync(path.join(root, 'music', 'bgm.ogg'), 'ogg', 'utf8')
      writeFileSync(path.join(root, 'maps', 'map.tmx'), 'tmx', 'utf8')

      const info = await readModInfo(root)
      expect(info).not.toBeNull()
      expect(info!.title).toBe('我的模组')
      expect(info!.author).toBe('作者')
      expect(info!.thumbnail).toBe('icon.png')
      expect(info!.musicExclusive).toBe(true)
      expect(info!.mapsExtra).toBe(true)
      expect(info!.musicFiles).toEqual(['music/bgm.ogg'])
      expect(info!.mapsFiles).toEqual(['maps/map.tmx'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('readModInfo 不存在时返回 null', async () => {
    const root = makeTempProject()
    try {
      expect(await readModInfo(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writeModInfo 覆盖写回，重新读取一致', async () => {
    const root = makeTempProject()
    try {
      await writeModInfo(root, {
        title: '新标题', description: '新描述', author: '新作者', version: '3.0',
        thumbnail: 'icon.png', minVersion: '1.15p9',
        musicFiles: ['music/a.ogg'], musicExclusive: true,
        mapsFiles: [], mapsExtra: false,
      })
      const content = readFileSync(path.join(root, 'mod-info.txt'), 'utf8')
      expect(content).toContain('title: 新标题')
      expect(content).toContain('author: 新作者')
      expect(content).toContain('whenUsingUnitsFromThisMod_playExclusively: true')

      const info = await readModInfo(root)
      expect(info!.title).toBe('新标题')
      expect(info!.musicExclusive).toBe(true)
      expect(info!.musicFiles).toEqual([]) // 目录里没有实际文件
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M7 模板制作（保存当前文件为模板）', () => {
  it('buildTemplateFromFile：data 原文 + 自动生成 name/maxHp/price 输入项', () => {
    const raw = buildTemplateFromFile('[core]\nname: 坦克\nmaxHp: 100\nprice: 200\n[graphics]\nimage: tank.png\n', '我的坦克模板')
    expect(raw.name).toBe('我的坦克模板')
    expect(raw.data).toContain('[core]')
    expect(raw.data).toContain('image: tank.png')
    expect(raw.action).toHaveLength(3)
    expect(raw.action!.map((a) => a.key)).toEqual(['name', 'maxHp', 'price'])
    expect(raw.action![0]).toMatchObject({ section: 'core', type: 'input', tag: 'name-core' })
  })

  it('buildTemplateFromFile：文件缺哪个键就不生成对应输入项', () => {
    const raw = buildTemplateFromFile('[core]\nname: 矿场\n', '矿场')
    expect(raw.action!.map((a) => a.key)).toEqual(['name'])
  })

  it('saveFileAsTemplate 写入用户模板目录，listTemplates 合并读取', async () => {
    const root = makeTempProject()
    const userTpl = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units', 'my-tank'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'my-tank', 'my-tank.ini'), '[core]\nname: 我的坦克\nmaxHp: 500\nprice: 300\n')
      const { key } = await saveFileAsTemplate(root, 'units/my-tank/my-tank.ini', '我的坦克模板', userTpl)
      expect(key).toBe('my-tank')
      // 用户模板文件已写入
      expect(readFileSync(path.join(userTpl, 'my-tank.json'), 'utf8')).toContain('我的坦克模板')
      // listTemplates 合并：内置模板 + 用户模板都在
      const metas = await listTemplates([userTpl])
      const mine = metas.find((m) => m.key === 'my-tank')
      expect(mine).toBeDefined()
      expect(mine?.name).toBe('我的坦克模板')
      expect(mine?.actions.some((a) => a.key === 'price')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(userTpl, { recursive: true, force: true })
    }
  })
})

describe('M7 审查修复回归', () => {
  it('mod-info 值含 # 不被截断（往返一致）', async () => {
    const root = makeTempProject()
    try {
      await writeModInfo(root, { title: '我的#模组', description: '第一行\n第二行', author: '作者', version: '1.0', musicFiles: [], musicExclusive: false, mapsFiles: [], mapsExtra: false })
      const info = await readModInfo(root)
      expect(info!.title).toBe('我的#模组')
      // 换行转义往返还原
      expect(info!.description).toBe('第一行\n第二行')
      // 再次写回 → 读回仍一致（不叠加转义）
      await writeModInfo(root, info!)
      const again = await readModInfo(root)
      expect(again!.title).toBe('我的#模组')
      expect(again!.description).toBe('第一行\n第二行')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('mod-info 节名大小写不敏感', async () => {
    const root = makeTempProject()
    try {
      writeFileSync(path.join(root, 'mod-info.txt'), '[Mod]\ntitle: 大写节\n', 'utf8')
      const info = await readModInfo(root)
      expect(info!.title).toBe('大写节')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('saveFileAsTemplate 中文名不碰撞、重复保存追加序号', async () => {
    const root = makeTempProject()
    const userTpl = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'units', '坦克.ini'), '[core]\nname: 坦克\nmaxHp: 100\n')
      writeFileSync(path.join(root, 'units', '侦察车.ini'), '[core]\nname: 侦察车\nmaxHp: 80\n')
      const a = await saveFileAsTemplate(root, 'units/坦克.ini', '坦克模板', userTpl)
      const b = await saveFileAsTemplate(root, 'units/侦察车.ini', '侦察车模板', userTpl)
      expect(a.key).toBe('坦克')
      expect(b.key).toBe('侦察车')
      // 同名重复保存 → 追加 -2
      const c = await saveFileAsTemplate(root, 'units/坦克.ini', '坦克模板2', userTpl)
      expect(c.key).toBe('坦克-2')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(userTpl, { recursive: true, force: true })
    }
  })

  it('listTemplates 跳过损坏的用户模板 JSON，不拖垮其它模板', async () => {
    const userTpl = makeTempProject()
    try {
      writeFileSync(path.join(userTpl, 'broken.json'), '{ not valid json', 'utf8')
      const metas = await listTemplates([userTpl])
      // 内置模板仍然可加载
      expect(metas.length).toBeGreaterThanOrEqual(16)
    } finally {
      rmSync(userTpl, { recursive: true, force: true })
    }
  })
})

describe('M8 第二轮审查修复回归', () => {
  it('writeModInfo 只更新已知键，保留注释/自定义键/未知节', async () => {
    const root = makeTempProject()
    try {
      writeFileSync(path.join(root, 'mod-info.txt'), [
        '# 顶部说明',
        '[Mod]',
        'title: 旧标题',
        'customKey: 请保留我',
        '',
        '[custom_section]',
        'anything: 原样保留',
      ].join('\n'), 'utf8')
      await writeModInfo(root, { title: '新标题', musicFiles: [], musicExclusive: false, mapsFiles: [], mapsExtra: false })
      const content = readFileSync(path.join(root, 'mod-info.txt'), 'utf8')
      expect(content).toContain('title: 新标题')
      expect(content).toContain('customKey: 请保留我')
      expect(content).toContain('[custom_section]')
      expect(content).toContain('anything: 原样保留')
      expect(content).toContain('# 顶部说明')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writeModInfo 音乐删光后移除 sourceFolder 真实键', async () => {
    const root = makeTempProject()
    try {
      writeFileSync(path.join(root, 'mod-info.txt'), '[music]\nsourceFolder: music/\nwhenUsingUnitsFromThisMod_playExclusively: true\n', 'utf8')
      await writeModInfo(root, { title: 't', musicFiles: [], musicExclusive: false, mapsFiles: [], mapsExtra: false })
      const content = readFileSync(path.join(root, 'mod-info.txt'), 'utf8')
      expect(content).not.toContain('sourceFolder: music/')
      expect(content).not.toContain('playExclusively')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('用户保存的模板（含中文键名）可用来创建单位', async () => {
    const root = makeTempProject()
    const userTpl = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'units', '坦克.ini'), '[core]\nname: 坦克\nmaxHp: 100\n', 'utf8')
      const { key } = await saveFileAsTemplate(root, 'units/坦克.ini', '坦克模板', userTpl)
      expect(key).toBe('坦克')
      const { path: rel } = await createUnitFromTemplate(root, { name: 'my-tank', templateKey: key, values: {} }, [userTpl])
      expect(rel).toBe('my-tank/my-tank.ini')
      expect(readFileSync(path.join(root, 'my-tank', 'my-tank.ini'), 'utf8')).toContain('name: 坦克')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(userTpl, { recursive: true, force: true })
    }
  })

  it('scanResources 单位名剥离行内注释（与 scanUnits 一致）', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units', 'tank'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'tank', 'tank.ini'), '[core]\nname: 坦克        # 单位名，全模组唯一\nmaxHp: 100\n', 'utf8')
      const { unitNames } = await scanResources(root)
      expect(unitNames).toContain('坦克')
      expect(unitNames.every((n) => !n.includes('#'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('链式检查节名大小写不敏感（[CORE]/[Graphics] 不误报）', () => {
    const rules: ChainRule[] = [
      { id: '1', type: '@file', list: 'core,graphics' },
      { id: '2', type: 'section', value: 'core', list: 'name' },
    ]
    const issues = runChainInspection('[CORE]\nname: x\n[Graphics]\nimage: a.png\n', rules, 'a.ini')
    expect(issues).toEqual([])
  })

  it('导入包跳过空条目名（"." 条目不报 EISDIR）', async () => {
    const root = makeTempProject()
    try {
      const zip = new JSZip()
      zip.file('.', 'junk')
      zip.file('units/a.ini', 'x')
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      const dest = path.join(root, 'out')
      const { files } = await importModBuffer(Buffer.from(buf), dest)
      expect(files).toBe(1)
      expect(existsSync(path.join(dest, 'units', 'a.ini'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同批导入同名音乐不互相覆盖（自动追加 -2）', async () => {
    const root = makeTempProject()
    try {
      const srcA = path.join(root, 'src-a')
      const srcB = path.join(root, 'src-b')
      mkdirSync(srcA)
      mkdirSync(srcB)
      writeFileSync(path.join(srcA, 'bgm.ogg'), 'A', 'utf8')
      writeFileSync(path.join(srcB, 'bgm.ogg'), 'B', 'utf8')
      const dest = path.join(root, 'out')
      mkdirSync(dest)
      const used = new Set<string>()
      const first = await transcodeToOgg(path.join(srcA, 'bgm.ogg'), dest, used)
      const second = await transcodeToOgg(path.join(srcB, 'bgm.ogg'), dest, used)
      expect(path.basename(first)).toBe('bgm.ogg')
      expect(path.basename(second)).toBe('bgm-2.ogg')
      expect(readFileSync(dest + '/bgm.ogg', 'utf8')).toBe('A')
      expect(readFileSync(dest + '/bgm-2.ogg', 'utf8')).toBe('B')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M9 第三轮审查修复回归', () => {
  it('readModInfo 读回自定义 sourceFolder，writeModInfo 写回保留', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'mybgm'), { recursive: true })
      writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: t\n[music]\nsourceFolder: mybgm/\n', 'utf8')
      const info = await readModInfo(root)
      expect(info!.musicSourceFolder).toBe('mybgm/')
      await writeModInfo(root, { title: '新标题', musicFiles: [], musicExclusive: false, mapsFiles: [], mapsExtra: false, musicSourceFolder: info!.musicSourceFolder })
      const content = readFileSync(path.join(root, 'mod-info.txt'), 'utf8')
      expect(content).toContain('sourceFolder: mybgm/')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('mod-info 键名大小写不敏感（Title:/MINVERSION: 也能读写一致）', async () => {
    const root = makeTempProject()
    try {
      writeFileSync(path.join(root, 'mod-info.txt'), '[Mod]\nTitle: 大写标题\nMINVERSION: 1.16\n', 'utf8')
      const info = await readModInfo(root)
      expect(info!.title).toBe('大写标题')
      expect(info!.minVersion).toBe('1.16')
      // 写回后值保留（不被规范默认值覆盖；键名统一为规范小写，值大小写敏感内容不动）
      await writeModInfo(root, info!)
      const content = readFileSync(path.join(root, 'mod-info.txt'), 'utf8')
      expect(content).toContain('title: 大写标题')
      expect(content).toContain('minVersion: 1.16')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M10 第九轮修复回归', () => {
  it('非 ogg 源（wav）经 ffmpeg 转码产出有效 ogg（-f ogg 参数）', async () => {
    const root = makeTempProject()
    try {
      const src = path.join(root, 'bgm.wav')
      // 用 ffmpeg 生成一个 0.2s 的测试 wav（环境无 ffmpeg 时跳过）
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:a', 'pcm_s16le', src], { stdio: 'pipe' })
      } catch {
        return // 环境无 ffmpeg：跳过该用例（其余断言不执行）
      }
      const dest = path.join(root, 'out')
      mkdirSync(dest, { recursive: true })
      const used = new Set<string>()
      const outFile = await transcodeToOgg(src, dest, used)
      expect(path.basename(outFile)).toBe('bgm.ogg')
      expect(existsSync(outFile)).toBe(true)
      // 内容确实是 ogg（OggS 魔数）
      const buf = readFileSync(outFile)
      expect(buf[0]).toBe(0x4f) // O
      expect(buf[1]).toBe(0x67) // g
      expect(buf[2]).toBe(0x67) // g
      expect(buf[3]).toBe(0x53) // S
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M11 全局操作（批量替换/附加）', () => {
  it('替换文本：全局替换源文件内容，无匹配不写盘', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'a.ini'), 'maxHp: 100\nmaxHp: 200\n# 注释')
      writeFileSync(path.join(root, 'units', 'b.template'), 'maxHp: 300')
      writeFileSync(path.join(root, 'note.txt'), 'maxHp: 999') // 非源文件：不处理
      const r1 = await globalOp(root, { kind: 'replace', find: 'maxHp', text: 'health' })
      expect(r1.files).toBe(2) // 只统计 .ini/.template
      expect(r1.changed).toBe(2)
      expect(r1.skipped).toBe(0)
      expect(readFileSync(path.join(root, 'units', 'a.ini'), 'utf8')).toBe('health: 100\nhealth: 200\n# 注释')
      expect(readFileSync(path.join(root, 'units', 'b.template'), 'utf8')).toBe('health: 300')
      expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('maxHp: 999') // 未动

      // 无匹配：不写盘（mtime 不变无从验证，但 changed=0 且内容一致）
      const r2 = await globalOp(root, { kind: 'replace', find: '不存在', text: 'x' })
      expect(r2.changed).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('头部/尾部附加：所有源文件统一插入', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\nname: a')
      const head = await globalOp(root, { kind: 'prepend', text: '# 生成的模组\n' })
      expect(head.changed).toBe(1)
      expect(readFileSync(path.join(root, 'units', 'a.ini'), 'utf8')).toBe('# 生成的模组\n[core]\nname: a')
      const tail = await globalOp(root, { kind: 'append', text: '\n# 结束' })
      expect(tail.changed).toBe(1)
      expect(readFileSync(path.join(root, 'units', 'a.ini'), 'utf8')).toBe('# 生成的模组\n[core]\nname: a\n# 结束')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('参数校验：replace 缺 find、非法 kind 抛错', async () => {
    const root = makeTempProject()
    try {
      await expect(globalOp(root, { kind: 'replace', find: '', text: 'x' } as never)).rejects.toThrow()
      await expect(globalOp(root, { kind: 'bad' as never, text: 'x' } as never)).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M12 炮塔解析/写回', () => {
  const SAMPLE = `[core]
name: 示例
[graphics]
image: 示例.png
imageScale: 0.6
[turret_1]
x: 0
y: -5
idleDir: 0
projectile: 1
size: 8
[turret_2]
x: 12
y: 3
projectile: 2
[attack]
canAttack: true
`

  it('解析全部 turret 段与键值', () => {
    const ts = parseTurrets(SAMPLE)
    expect(ts.length).toBe(2)
    expect(ts[0].index).toBe(1)
    expect(ts[0].values.get('x')).toBe('0')
    expect(ts[0].values.get('y')).toBe('-5')
    expect(ts[0].values.get('projectile')).toBe('1')
    expect(ts[1].index).toBe(2)
    expect(ts[1].values.get('x')).toBe('12')
  })

  it('行级替换只改目标键，保留其余格式', () => {
    const out = updateTurretValue(SAMPLE, 1, 'x', '8')
    expect(out).toContain('x: 8')
    expect(out).toContain('y: -5') // 其它键不动
    expect(out).toContain('idleDir: 0')
    // turret_2 的 x 不受影响
    const t2 = parseTurrets(out).find((t) => t.index === 2)
    expect(t2?.values.get('x')).toBe('12')
    // 不存在的键：在段尾追加一行（中文模式写回新键的路径）
    const withNew = updateTurretValue(SAMPLE, 1, '不存在', '1')
    expect(withNew).toContain('不存在: 1')
    expect(withNew).toContain('x: 0') // 原有键不受影响
  })

  it('提取 graphics image 路径', () => {
    expect(findUnitImage(SAMPLE)).toBe('示例.png')
    expect(findUnitImage('[core]\nname: x\n')).toBeUndefined()
  })
})

describe('M14 炮塔中文显示层（回译匹配）', () => {
  // 中文显示层内容（词典桩：炮塔→turret、x坐标→x、y坐标→y、主体图像→image、图形→graphics）
  const ZH_DICT: Record<string, string> = {
    '炮塔': 'turret', 'x坐标': 'x', 'y坐标': 'y', '主体图像': 'image', '图形': 'graphics',
    '闲时角度': 'idleDir', '抛射体': 'projectile', '炮塔大小': 'size',
  }
  const zhToEn = (s: string) => ZH_DICT[s]
  const enToZh = (s: string) => Object.entries(ZH_DICT).find(([, v]) => v === s)?.[0]

  const SAMPLE_ZH = `[核心]
名称: 示例
[图形]
主体图像: 示例.png
[炮塔_1]
x坐标: 0
y坐标: -5
闲时角度: 0
抛射体: 1
炮塔大小: 8
[攻击]
可以攻击: 是
`

  it('中文节名/键名解析为英文规范键', () => {
    const ts = parseTurrets(SAMPLE_ZH, zhToEn)
    expect(ts.length).toBe(1)
    expect(ts[0].index).toBe(1)
    expect(ts[0].values.get('x')).toBe('0')
    expect(ts[0].values.get('y')).toBe('-5')
    expect(ts[0].values.get('projectile')).toBe('1')
  })

  it('中文键写回保留原始键名（x坐标 行）', () => {
    const out = updateTurretValue(SAMPLE_ZH, 1, 'x', '8', zhToEn, enToZh)
    expect(out).toContain('x坐标: 8')
    expect(out).toContain('y坐标: -5') // 其它键不动
    expect(out).not.toContain('x: 8') // 不混入英文键
  })

  it('中文模式追加新键用中文显示键（enToZh 反查）', () => {
    const out = updateTurretValue(SAMPLE_ZH, 1, 'shoot_sound', 'tank_firing', zhToEn, enToZh)
    expect(out).toContain('shoot_sound: tank_firing') // 无中文译名时用英文键
    // 有中文译名的键（如 x）追加时用中文
    const out2 = updateTurretValue('[炮塔_1]\nx坐标: 0', 1, 'size', '10', zhToEn, enToZh)
    expect(out2).toContain('炮塔大小: 10')
  })

  it('CRLF 文件行尾保真 + 行内注释保留', () => {
    const crlf = '[turret_1]\r\nx: 0 # 炮塔注释\r\ny: 5\r\n'
    const out = updateTurretValue(crlf, 1, 'x', '8')
    expect(out).toContain('\r\n') // 保持 CRLF
    expect(out).toContain('x: 8 # 炮塔注释') // 注释保留
    expect(out.split('\r\n').length).toBe(4)
  })

  it('中文 graphics 节提取 image', () => {
    expect(findUnitImage(SAMPLE_ZH, zhToEn)).toBe('示例.png')
  })
})
