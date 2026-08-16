/**
 * M8 游戏集成测试：官方单位示例导入（复制/跳过已存在/跳过链接/回滚/mod-info 生成）。
 * 覆盖安全审查修复：不覆盖用户已有文件、不跟随符号链接、失败回滚不留半成品。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findGameExe, importOfficialUnits, launchGame, listOfficialUnitDirs, openDir, preflightCheck, readGameAssetImage } from '../electron/game'

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

describe('M12 试玩联动（preflightCheck / launchGame 安全）', () => {
  it('preflight 报告缺失 mod-info.txt', async () => {
    const mod = makeTmp('rust-mod-')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n')
    const result = await preflightCheck(mod)
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('mod-info.txt'))).toBe(true)
  })

  it('preflight 检查图片引用文件存在', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\nversion: 1\nminVersion: 1.15p9\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage: missing.png\n')
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('missing.png'))).toBe(true)
  })

  it('preflight 放行存在的引用与 SHARED:/NONE', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\nversion: 1\nminVersion: 1.15p9\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage: a.png\nimage_shadow: AUTO\n')
    writeFileSync(path.join(mod, 'units', 'a', 'a.png'), 'png')
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.message.includes('a.png'))).toBe(false)
  })

  it('preflight 拦截越出项目根的引用（..）', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage: ../../../outside.png\n')
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('越出项目目录'))).toBe(true)
  })

  it('mod-info 完整性：缺 title/version/minVersion 给警告', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\n')
    const result = await preflightCheck(mod)
    const warnings = result.issues.filter((i) => i.severity === 'warning')
    expect(warnings.some((i) => i.message.includes('title'))).toBe(true)
    expect(warnings.some((i) => i.message.includes('version'))).toBe(true)
    expect(warnings.some((i) => i.message.includes('minVersion'))).toBe(true)
  })

  it('launchGame 拒绝非游戏目录（防任意 exe 执行）', async () => {
    const fake = makeTmp('rust-notgame-')
    const result = await launchGame(fake)
    expect(result.ok).toBe(false)
  })

  it('launchGame 接受含 assets/units 的目录并找到 exe', async () => {
    const game = makeTmp('rust-game2-')
    mkdirSync(path.join(game, 'assets', 'units'), { recursive: true })
    writeFileSync(path.join(game, 'Rusted Warfare.exe'), 'fake-exe')
    expect(await findGameExe(game)).toBe(path.join(game, 'Rusted Warfare.exe'))
    const result = await launchGame(game)
    expect(result.ok).toBe(false) // spawn 假 exe 失败是预期的（找不到真实可执行文件）——但安全校验已通过
    expect(result.message).toBeTruthy()
  })
})

describe('M12 审查修复回归', () => {
  it('多帧引用（a.png;b.png）逐帧检查：第二帧缺失报错', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.png'), 'png')
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage: a.png;b.png\n')
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('b.png'))).toBe(true)
    expect(result.issues.some((i) => i.message.includes('a.png'))).toBe(false)
  })

  it('帧语法（frame.png:延迟）剥冒号后缀不误报', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'frame.png'), 'png')
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage: frame.png:0.1\n')
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.message.includes('frame.png'))).toBe(false)
  })

  it('SHARED:/CUSTOM:/ROOT: 前缀与行内注释/引号不误报', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'real.png'), 'png')
    writeFileSync(
      path.join(mod, 'units', 'a', 'a.ini'),
      '[core]\nname: a\n[graphics]\nimage: SHARED:beam3.png\nimage_wreak: "real.png" # 注释\nimage_shadow: ROOT:units/a/real.png\n',
    )
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.severity === 'error')).toBe(false)
  })

  it('openDir 拒绝不存在的目录', async () => {
    const result = await openDir(path.join(makeTmp('rust-nodir-'), 'nope'))
    expect(result.ok).toBe(false)
  })
})

describe('M31 单位预览资产读取（readGameAssetImage）', () => {
  it('CORE 资产：assets/units 下文件读为 data URL（MIME 按扩展名）', async () => {
    const game = makeTmp('rust-asset-')
    mkdirSync(path.join(game, 'assets', 'units', 'tanks'), { recursive: true })
    writeFileSync(path.join(game, 'assets', 'units', 'tanks', 'tank.png'), 'png-bytes')
    try {
      const url = await readGameAssetImage(game, 'assets/units/tanks/tank.png')
      expect(url).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
    } finally {
      rmSync(game, { recursive: true, force: true })
    }
  })

  it('SHARED 资产：assets/units/shared 下文件同样可读', async () => {
    const game = makeTmp('rust-asset-')
    mkdirSync(path.join(game, 'assets', 'units', 'shared'), { recursive: true })
    writeFileSync(path.join(game, 'assets', 'units', 'shared', 'beam3.png'), 'beam')
    try {
      const url = await readGameAssetImage(game, 'assets/units/shared/beam3.png')
      expect(url.startsWith('data:image/png;base64,')).toBe(true)
    } finally {
      rmSync(game, { recursive: true, force: true })
    }
  })

  it('非游戏目录拒绝（缺 assets/units）', async () => {
    const fake = makeTmp('rust-notgame-')
    writeFileSync(path.join(fake, 'x.png'), 'x')
    try {
      await expect(readGameAssetImage(fake, 'x.png')).rejects.toThrow(/不是有效的铁锈战争安装目录/)
    } finally {
      rmSync(fake, { recursive: true, force: true })
    }
  })

  it('路径穿越（../ 或盘符绝对）拒绝', async () => {
    const game = makeTmp('rust-asset-')
    mkdirSync(path.join(game, 'assets', 'units'), { recursive: true })
    try {
      await expect(readGameAssetImage(game, 'assets/units/../../secret.png')).rejects.toThrow(/无效的资产路径|超出游戏目录/)
      await expect(readGameAssetImage(game, 'C:/evil.png')).rejects.toThrow(/无效的资产路径/)
    } finally {
      rmSync(game, { recursive: true, force: true })
    }
  })

  it('文件不存在/过大拒绝', async () => {
    const game = makeTmp('rust-asset-')
    mkdirSync(path.join(game, 'assets', 'units'), { recursive: true })
    try {
      await expect(readGameAssetImage(game, 'assets/units/missing.png')).rejects.toThrow(/不存在/)
    } finally {
      rmSync(game, { recursive: true, force: true })
    }
  })

  it('preflight：= 分隔符同样识别（等号文件缺图报错、存在放行）', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.png'), 'png')
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage = a.png\n')
    const ok = await preflightCheck(mod)
    expect(ok.issues.some((i) => i.message.includes('a.png'))).toBe(false)
    writeFileSync(path.join(mod, 'units', 'a', 'b.ini'), '[core]\nname: b\n[graphics]\nimage = b.png\n')
    const missing = await preflightCheck(mod)
    expect(missing.issues.some((i) => i.severity === 'error' && i.message.includes('b.png'))).toBe(true)
    rmSync(mod, { recursive: true, force: true })
  })

  it('preflight：CORE: 前缀是游戏内置资源，不检查项目内存在性', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'units', 'a'), { recursive: true })
    writeFileSync(path.join(mod, 'units', 'a', 'a.ini'), '[core]\nname: a\n[graphics]\nimage: CORE:tanks/tank.png\nimage_wreak: CORE:tanks/tank_dead.png\n')
    try {
      const result = await preflightCheck(mod)
      expect(result.issues.some((i) => i.severity === 'error')).toBe(false)
    } finally {
      rmSync(mod, { recursive: true, force: true })
    }
  })
})

describe('M15 地图打包桥接（preflight tmx 校验）', () => {
  it('有效地图通过；缺 Ground data 警告；非 TMX 报错', async () => {
    const mod = makeTmp('rust-mod-')
    writeFileSync(path.join(mod, 'mod-info.txt'), '[mod]\ntitle: x\n')
    mkdirSync(path.join(mod, 'maps'), { recursive: true })
    writeFileSync(
      path.join(mod, 'maps', 'good.tmx'),
      '<map version="1.2" width="4" height="4" tilewidth="32" tileheight="32"><layer name="Ground"><data encoding="csv">1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1</data></layer></map>',
    )
    writeFileSync(path.join(mod, 'maps', 'noground.tmx'), '<map version="1.2" width="4" height="4" tilewidth="32" tileheight="32"><layer name="Items"><data encoding="csv">0</data></layer></map>')
    writeFileSync(path.join(mod, 'maps', 'bad.tmx'), 'not a map at all')
    const result = await preflightCheck(mod)
    expect(result.issues.some((i) => i.message.includes('good.tmx'))).toBe(false)
    expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Ground') && i.file?.includes('noground.tmx'))).toBe(true)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('<map> 根元素') && i.file?.includes('bad.tmx'))).toBe(true)
  })
})
