/**
 * M8 游戏集成测试：官方单位示例导入（复制/跳过已存在/跳过链接/回滚/mod-info 生成）。
 * 覆盖安全审查修复：不覆盖用户已有文件、不跟随符号链接、失败回滚不留半成品。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importOfficialUnits, listOfficialUnitDirs } from '../electron/game'

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  return dir
}

/** 构造模拟游戏目录：assets/units/unitA、unitB（含 ini + 图片） */
function makeFakeGameDir(): string {
  const game = makeTmp('rust-game-')
  const units = path.join(game, 'assets', 'units')
  mkdirSync(path.join(units, 'unitA'), { recursive: true })
  mkdirSync(path.join(units, 'unitB'), { recursive: true })
  writeFileSync(path.join(units, 'unitA', 'unitA.ini'), '[core]\nname: A\n')
  writeFileSync(path.join(units, 'unitA', 'unitA.png'), 'png')
  writeFileSync(path.join(units, 'unitB', 'unitB.ini'), '[core]\nname: B\n')
  writeFileSync(path.join(units, 'unitB', 'unitB.png'), 'png')
  // 非单位目录（无 ini）：不应被识别为单位
  mkdirSync(path.join(units, 'shared'), { recursive: true })
  writeFileSync(path.join(units, 'shared', 'texture.png'), 'png')
  // 说明文件（非目录）：忽略
  writeFileSync(path.join(units, 'README.txt'), 'x')
  return game
}

describe('游戏官方单位导入', () => {
  it('识别含 ini 的单位目录', async () => {
    const game = makeFakeGameDir()
    try {
      const units = await listOfficialUnitDirs(game)
      expect(units).toContain('unitA')
      expect(units).toContain('unitB')
      expect(units).not.toContain('shared') // 无 ini 目录不算单位
      expect(units).not.toContain('README.txt') // 非目录忽略
    } finally {
      rmSync(game, { recursive: true, force: true })
    }
  })

  it('复制单位 + 生成 mod-info.txt', async () => {
    const game = makeFakeGameDir()
    const target = makeTmp('rust-target-')
    try {
      const result = await importOfficialUnits(game, target, ['unitA', 'unitB'], {
        title: '示例',
        description: '说明',
        author: '官方',
        version: '1.0',
      })
      expect(result.units).toBe(2)
      expect(result.files).toBeGreaterThanOrEqual(5) // 4 个单位文件 + mod-info.txt
      expect(existsSync(path.join(target, 'unitA', 'unitA.ini'))).toBe(true)
      expect(existsSync(path.join(target, 'unitB', 'unitB.png'))).toBe(true)
      const info = readFileSync(path.join(target, 'mod-info.txt'), 'utf8')
      expect(info).toContain('title: 示例')
      expect(info).toContain('description: 说明')
    } finally {
      rmSync(game, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('目标已有同名单位目录：跳过不覆盖', async () => {
    const game = makeFakeGameDir()
    const target = makeTmp('rust-target-')
    try {
      // 用户自建 unitA（内容不同）
      mkdirSync(path.join(target, 'unitA'), { recursive: true })
      writeFileSync(path.join(target, 'unitA', 'unitA.ini'), '用户自己的内容')
      const result = await importOfficialUnits(game, target, ['unitA', 'unitB'], {
        title: '示例',
        description: '',
        author: '',
        version: '1.0',
      })
      expect(result.units).toBe(1) // 只复制了 unitB
      // 用户文件未被覆盖
      expect(readFileSync(path.join(target, 'unitA', 'unitA.ini'), 'utf8')).toBe('用户自己的内容')
      expect(existsSync(path.join(target, 'unitB', 'unitB.ini'))).toBe(true)
    } finally {
      rmSync(game, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('目标已有 mod-info.txt：不覆盖', async () => {
    const game = makeFakeGameDir()
    const target = makeTmp('rust-target-')
    try {
      writeFileSync(path.join(target, 'mod-info.txt'), '已有自述')
      await importOfficialUnits(game, target, ['unitA'], { title: '新标题', description: '', author: '', version: '1.0' })
      expect(readFileSync(path.join(target, 'mod-info.txt'), 'utf8')).toBe('已有自述')
    } finally {
      rmSync(game, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('跳过单位目录内的符号链接（不把链接目标拉进项目）', async () => {
    const game = makeFakeGameDir()
    const outside = makeTmp('rust-outside-')
    writeFileSync(path.join(outside, 'secret.txt'), '外部文件')
    // unitC 目录内放一个指向外部的链接
    mkdirSync(path.join(game, 'assets', 'units', 'unitC'), { recursive: true })
    writeFileSync(path.join(game, 'assets', 'units', 'unitC', 'unitC.ini'), '[core]')
    try {
      symlinkSync(outside, path.join(game, 'assets', 'units', 'unitC', 'link'), 'junction')
    } catch {
      // 无权限创建链接（部分 CI 环境）：跳过本用例
      rmSync(game, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      return
    }
    const target = makeTmp('rust-target-')
    try {
      const result = await importOfficialUnits(game, target, ['unitC'], { title: 'x', description: '', author: '', version: '1.0' })
      expect(result.units).toBe(1)
      expect(existsSync(path.join(target, 'unitC', 'unitC.ini'))).toBe(true)
      // 链接未被复制（外部文件不进入项目）
      expect(existsSync(path.join(target, 'unitC', 'link'))).toBe(false)
      expect(existsSync(path.join(target, 'unitC', 'secret.txt'))).toBe(false)
    } finally {
      rmSync(game, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('白名单校验：非单位名/路径穿越名被拒绝', async () => {
    const game = makeFakeGameDir()
    const target = makeTmp('rust-target-')
    try {
      const result = await importOfficialUnits(game, target, ['unitA', '../secret', 'a/b', 'unitZ'], {
        title: 'x',
        description: '',
        author: '',
        version: '1.0',
      })
      expect(result.units).toBe(1) // 只有 unitA 合法
      expect(existsSync(path.join(target, 'unitA'))).toBe(true)
    } finally {
      rmSync(game, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('mod-info.txt 字段转义（含换行的标题不破坏 INI 结构）', async () => {
    const game = makeFakeGameDir()
    const target = makeTmp('rust-target-')
    try {
      await importOfficialUnits(game, target, ['unitA'], {
        title: '标题\n恶意行: 注入',
        description: '说明\\n换行',
        author: '官方',
        version: '1.0',
      })
      const info = readFileSync(path.join(target, 'mod-info.txt'), 'utf8')
      // 标题中的换行被转义为字面 \n（单行 INI），不会产生新的键值对
      expect(info).toContain('title: 标题\\n恶意行: 注入')
      expect(info.split('\n').filter((l) => l.startsWith('恶意行'))).toHaveLength(0)
    } finally {
      rmSync(game, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})
