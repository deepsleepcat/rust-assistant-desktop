/**
 * M34 单位复制测试：主进程 copyUnit 的安全规则与复制行为。
 * 覆盖：同模组/跨模组成功复制、非单位/非法扩展名拒绝、目标已存在不覆盖、
 * 源路径越界拒绝、复制内容逐字节一致、源与目标目录分离时写入目标。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyUnit } from '../electron/modTools'

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'rust-copyunit-'))
}

/** 带注释/中文节名的合法单位文件（保留原始换行与内容） */
const UNIT_SOURCE = `# 单位注释保留
[core]
name: 重型坦克
displayDescription: 重甲主力，嘲讽抗线
maxHp: 1200

[graphics]
image: ROOT:/tanks/tank.png
image_wreak: ROOT:/tanks/tank_wreck.png

[attack]
aimImage: ROOT:/tanks/turret.png
`

describe('M34 copyUnit 主进程', () => {
  it('同模组内复制：写入 <name>/<name>.ini，内容逐字节一致', async () => {
    const root = tmp()
    mkdirSync(path.join(root, 'units', 'tank'), { recursive: true })
    writeFileSync(path.join(root, 'units', 'tank', 'tank.ini'), UNIT_SOURCE, 'utf8')

    const result = await copyUnit({
      sourceRoot: root,
      sourceFilePath: 'units/tank/tank.ini',
      targetRoot: root,
      targetName: 'tank_copy',
    })

    expect(result.path).toBe('tank_copy/tank_copy.ini')
    expect(readFileSync(path.join(root, 'tank_copy', 'tank_copy.ini'), 'utf8')).toBe(UNIT_SOURCE)
    rmSync(root, { recursive: true, force: true })
  })

  it('跨模组复制：源项目读取、目标项目写入', async () => {
    const src = tmp()
    const dst = tmp()
    mkdirSync(path.join(src, 'units', 'rifle'), { recursive: true })
    writeFileSync(path.join(src, 'units', 'rifle', 'rifle.ini'), UNIT_SOURCE, 'utf8')

    const result = await copyUnit({
      sourceRoot: src,
      sourceFilePath: 'units/rifle/rifle.ini',
      targetRoot: dst,
      targetName: 'strangerRifle',
      targetFolder: 'units',
    })

    expect(result.path).toBe('units/strangerRifle/strangerRifle.ini')
    expect(existsSync(path.join(dst, 'units', 'strangerRifle', 'strangerRifle.ini'))).toBe(true)
    expect(existsSync(path.join(src, 'units', 'strangerRifle'))).toBe(false) // 源目录不被污染
    rmSync(src, { recursive: true, force: true })
    rmSync(dst, { recursive: true, force: true })
  })

  it('非单位文件拒绝（缺少 [core] / [核心] 节）', async () => {
    const root = tmp()
    mkdirSync(path.join(root, 'units'), { recursive: true })
    writeFileSync(path.join(root, 'units', 'a.ini'), '[graphics]\nimage: x.png\n', 'utf8')

    await expect(
      copyUnit({ sourceRoot: root, sourceFilePath: 'units/a.ini', targetRoot: root, targetName: 'b' }),
    ).rejects.toThrow('不是单位文件')
    rmSync(root, { recursive: true, force: true })
  })

  it('非法扩展名拒绝（只允许 .ini / .template）', async () => {
    const root = tmp()
    writeFileSync(path.join(root, 'notes.txt'), '[core]\nname: x\n', 'utf8')

    await expect(
      copyUnit({ sourceRoot: root, sourceFilePath: 'notes.txt', targetRoot: root, targetName: 'b' }),
    ).rejects.toThrow('只能复制 .ini')
    rmSync(root, { recursive: true, force: true })
  })

  it('源路径越界拒绝（../ 穿越）', async () => {
    const root = tmp()
    await expect(
      copyUnit({ sourceRoot: root, sourceFilePath: '../evil.ini', targetRoot: root, targetName: 'b' }),
    ).rejects.toThrow('超出项目目录范围')
    rmSync(root, { recursive: true, force: true })
  })

  it('目标已存在时拒绝覆盖，源文件不受影响', async () => {
    const root = tmp()
    mkdirSync(path.join(root, 'units'), { recursive: true })
    writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\nname: a\n', 'utf8')
    mkdirSync(path.join(root, 'dup'), { recursive: true })
    writeFileSync(path.join(root, 'dup', 'dup.ini'), '[core]\nname: original\n', 'utf8')

    await expect(
      copyUnit({ sourceRoot: root, sourceFilePath: 'units/a.ini', targetRoot: root, targetName: 'dup' }),
    ).rejects.toThrow('已存在')
    // 已有文件未被覆盖
    expect(readFileSync(path.join(root, 'dup', 'dup.ini'), 'utf8')).toContain('name: original')
    rmSync(root, { recursive: true, force: true })
  })

  it('节名大小写不敏感：[CORE] / [Core] 也能识别（与 scanUnits 一致）', async () => {
    const root = tmp()
    mkdirSync(path.join(root, 'units'), { recursive: true })
    writeFileSync(path.join(root, 'units', 'big.ini'), '[CORE]\nname: BigTank\n', 'utf8')

    await copyUnit({
      sourceRoot: root,
      sourceFilePath: 'units/big.ini',
      targetRoot: root,
      targetName: 'bigCopy',
    })

    expect(readFileSync(path.join(root, 'bigCopy', 'bigCopy.ini'), 'utf8')).toContain('[CORE]')
    rmSync(root, { recursive: true, force: true })
  })

  it('非法目标名中的路径分隔符被替换为 -，不会穿目录', async () => {
    const root = tmp()
    mkdirSync(path.join(root, 'units'), { recursive: true })
    writeFileSync(path.join(root, 'units', 'a.ini'), '[core]\nname: a\n', 'utf8')

    const result = await copyUnit({
      sourceRoot: root,
      sourceFilePath: 'units/a.ini',
      targetRoot: root,
      targetName: 'a/../evil',
    })

    // 分隔符被替换，路径段里不存在 '..'（不会穿越），目标文件在 root 内
    expect(result.path.split(/[\\/]/)).not.toContain('..')
    expect(existsSync(path.join(root, result.path))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})