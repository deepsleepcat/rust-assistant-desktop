/**
 * M35 F3 一键验证测试：deployMod 打包并部署到游戏 mods/units 目录。
 * 覆盖：部署成功（rwmod 写入且含单位文件、mods/units 自动创建）、同名未覆盖返回 EXISTS、
 * overwrite 覆盖成功、非法游戏目录/相对路径拒绝、项目根不存在抛错、符号链接目标拒绝、
 * 保留设备名项目名清洗。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { deployMod } from '../electron/modTools'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'rust-deploy-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 假项目：mod-info.txt + 一个单位文件（root 为项目根目录） */
function makeProject(root: string): void {
  mkdirSync(path.join(root, 'units', 'tank'), { recursive: true })
  writeFileSync(path.join(root, 'mod-info.txt'), '[mod]\ntitle: 测试模组\nversion: 1.0\n', 'utf8')
  writeFileSync(path.join(root, 'units', 'tank', 'tank.ini'), '[core]\nname: 测试坦克\nmaxHp: 100\n', 'utf8')
}

/** 假游戏目录：assets/units（判定标准）；mods/units 可选（不存在时部署应自动创建） */
function makeGame(gamePath: string, withModsDir = true): void {
  mkdirSync(path.join(gamePath, 'assets', 'units'), { recursive: true })
  if (withModsDir) mkdirSync(path.join(gamePath, 'mods', 'units'), { recursive: true })
}

describe('M35 deployMod（打包并部署到游戏目录）', () => {
  it('部署成功：rwmod 写入游戏 mods/units，内容非空且含单位文件', async () => {
    const root = tmp()
    const game = tmp()
    makeProject(root)
    makeGame(game)

    const result = await deployMod(root, game, {}, false)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filePath).toBe(path.join(game, 'mods', 'units', `${path.basename(root)}.rwmod`))
    expect(result.files).toBeGreaterThanOrEqual(2) // mod-info.txt + tank.ini
    expect(result.overwritten).toBe(false)
    const buf = readFileSync(result.filePath)
    expect(buf.byteLength).toBeGreaterThan(0)
    // rwmod 是 zip：解压验证单位文件真实进入产物
    const zip = await JSZip.loadAsync(buf)
    const tankIni = await zip.file('units/tank/tank.ini')?.async('string')
    expect(tankIni).toContain('测试坦克')
    expect(zip.file('mod-info.txt')).toBeDefined()
  })

  it('游戏 mods/units 目录不存在时自动创建', async () => {
    const root = tmp()
    const game = tmp()
    makeProject(root)
    makeGame(game, false) // 只有 assets/units

    const result = await deployMod(root, game, {}, false)

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(game, 'mods', 'units'))).toBe(true)
  })

  it('同名已存在且未 overwrite → EXISTS 不覆盖', async () => {
    const root = tmp()
    const game = tmp()
    makeProject(root)
    makeGame(game)
    await deployMod(root, game, {}, false)

    const second = await deployMod(root, game, {}, false)

    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('EXISTS')
    expect(second.filePath).toBe(path.join(game, 'mods', 'units', `${path.basename(root)}.rwmod`))
  })

  it('overwrite=true 覆盖同名模组成功', async () => {
    const root = tmp()
    const game = tmp()
    makeProject(root)
    makeGame(game)
    await deployMod(root, game, {}, false)

    const result = await deployMod(root, game, {}, true)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.overwritten).toBe(true)
  })

  it('非法游戏目录（无 assets/units）拒绝部署且不产生写入', async () => {
    const root = tmp()
    const game = tmp()
    makeProject(root)
    mkdirSync(path.join(game, 'mods')) // 有 mods 但没有 assets/units

    const result = await deployMod(root, game, {}, false)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('游戏目录校验失败')
    expect(existsSync(path.join(game, 'mods', 'units'))).toBe(false)
  })

  it('相对游戏路径拒绝（写游戏目录是唯一例外，路径必须绝对）', async () => {
    const root = tmp()
    makeProject(root)
    const result = await deployMod(root, 'relative/game/path', {}, false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('绝对路径')
  })

  it('项目根不存在 → 抛错（不产生任何游戏目录写入）', async () => {
    const root = tmp()
    const game = tmp()
    makeGame(game, false) // 只建 assets/units，mods/units 应保持不存在
    rmSync(root, { recursive: true, force: true }) // 项目根被删

    await expect(deployMod(root, game, {}, false)).rejects.toThrow()
    expect(existsSync(path.join(game, 'mods', 'units'))).toBe(false)
  })

  it('部署目标存在符号链接时拒绝写入（防链接重定向到游戏目录外）', async () => {
    const root = tmp()
    const game = tmp()
    makeProject(root)
    makeGame(game)
    // 项目根名字节数必须与目标文件名一致：目标 = <basename(root)>.rwmod
    const target = path.join(game, 'mods', 'units', `${path.basename(root)}.rwmod`)
    // Windows 建符号链接需要开发者模式/管理员权限；无权限时跳过本用例
    try {
      symlinkSync(path.join(game, 'outside-target'), target)
    } catch {
      return
    }

    const result = await deployMod(root, game, {}, false)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('符号链接')
  })

  it('项目名为 Windows 保留设备名（CON）时清洗为 _CON，部署成功', async () => {
    const base = tmp()
    const game = tmp()
    const root = path.join(base, 'CON')
    makeProject(root)
    makeGame(game)

    const result = await deployMod(root, game, {}, false)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(path.basename(result.filePath)).toBe('_CON.rwmod')
  })
})
