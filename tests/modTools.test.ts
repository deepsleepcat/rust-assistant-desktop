/**
 * M5 模组工具测试：模板内容、打包排除规则、单位检查逻辑。
 * M6.5：模板系统（listTemplates / buildFileFromTemplate / createUnitFromTemplate）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildModInfo,
  buildUnitSkeleton,
  isExcluded,
  createMod,
  createUnit,
  createUnitFromTemplate,
  listTemplates,
  buildFileFromTemplate,
  packModBuffer,
  checkMod,
} from '../electron/modTools'
import type { RawTemplate } from '../electron/modTools'

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
  it('新建模组生成 mod-info.txt、units/ 和示例单位', async () => {
    const root = makeTempProject()
    try {
      const { files } = await createMod(root, { name: 'demo', title: '演示模组' })
      expect(files).toContain('mod-info.txt')
      expect(files.some((f) => f.includes('.ini'))).toBe(true)
      expect(readFileSync(path.join(root, 'mod-info.txt'), 'utf8')).toContain('title: 演示模组')
      // 重复创建不覆盖已有内容
      await createMod(root, { name: 'demo', title: '其他标题' })
      expect(readFileSync(path.join(root, 'mod-info.txt'), 'utf8')).toContain('title: 演示模组')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('新建单位生成骨架且不覆盖已有文件', async () => {
    const root = makeTempProject()
    try {
      mkdirSync(path.join(root, 'units'), { recursive: true })
      const { path: rel } = await createUnit(root, { name: 'tank', displayName: '坦克' })
      expect(rel).toBe('units/tank/tank.ini')
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
      expect(result.issues.every((i) => i.level === 'error')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      expect(rel).toBe('units/my-tank/my-tank.ini')
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
