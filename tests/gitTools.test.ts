/**
 * 本地 git 辅助（M25，P3 任务 4）测试：
 * - 真实临时 git 仓库（git CLI）：仓库检测/分支/历史/状态/对比/回滚
 * - 冲突标记解析（纯函数）
 * - 参数校验（提交哈希/相对路径）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { conflictMarkers } from '../src/utils/conflictMarkers'
import { conflictFiles, diffBetween, gitAvailable, isValidCommit, isValidRelPath, logHistory, repoInfo, restoreFile, statusFiles } from '../electron/gitTools'

function run(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

let repo: string

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'))
  run(repo, ['init', '-q'])
  run(repo, ['config', 'user.email', 'test@example.com'])
  run(repo, ['config', 'user.name', '测试'])
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('repoInfo / gitAvailable', () => {
  it('非仓库目录：isRepo=false 且有提示（git 可用时）', async () => {
    if (!(await gitAvailable())) return // 环境无 git：跳过真实仓库断言
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-norepo-'))
    try {
      const info = await repoInfo(dir)
      expect(info.available).toBe(true)
      expect(info.isRepo).toBe(false)
      expect(info.message).toMatch(/不是 git 仓库/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('仓库信息：分支/改动数/分支列表', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'a.ini'), '[core]\nname: a\n')
    run(repo, ['add', 'a.ini'])
    run(repo, ['commit', '-q', '-m', 'init'])
    fs.writeFileSync(path.join(repo, 'b.ini'), '[core]\nname: b\n')
    const info = await repoInfo(repo)
    expect(info.isRepo).toBe(true)
    expect(info.branch).toBe('master') // git init 默认分支（环境无关断言：非空即可）
    expect(info.branch.length).toBeGreaterThan(0)
    expect(info.changedCount).toBe(1) // b.ini 未跟踪
    expect(info.branches).toContain(info.branch)
  })
})

describe('logHistory / statusFiles / diffBetween / restoreFile', () => {
  it('历史、改动、对比、回滚全链路', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'u.ini'), '[core]\nname: v1\n')
    run(repo, ['add', 'u.ini'])
    run(repo, ['commit', '-q', '-m', '第一版'])
    const first = run(repo, ['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(repo, 'u.ini'), '[core]\nname: v2\n')
    run(repo, ['add', 'u.ini'])
    run(repo, ['commit', '-q', '-m', '第二版'])
    const second = run(repo, ['rev-parse', 'HEAD'])

    const log = await logHistory(repo)
    expect(log.length).toBe(2)
    expect(log[0].subject).toBe('第二版')
    expect(log[0].short.length).toBeGreaterThanOrEqual(7)
    expect(log[1].subject).toBe('第一版')

    // 对比两个提交：应显示 name 从 v1 → v2
    const d = await diffBetween(repo, first, second)
    expect(d).toContain('v1')
    expect(d).toContain('v2')

    // 工作区改动：修改文件
    fs.writeFileSync(path.join(repo, 'u.ini'), '[core]\nname: v3-uncommitted\n')
    const st = await statusFiles(repo)
    expect(st.some((f) => f.path === 'u.ini' && f.status.includes('M'))).toBe(true)
    const dWorking = await diffBetween(repo, second, 'working', 'u.ini')
    expect(dWorking).toContain('v3-uncommitted')

    // 回滚到第二版：工作区恢复 v2
    const r = await restoreFile(repo, 'u.ini', second)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'u.ini'), 'utf8')).toContain('name: v2')

    // 回滚到第一版
    const r2 = await restoreFile(repo, 'u.ini', first)
    expect(r2.ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'u.ini'), 'utf8')).toContain('name: v1')
  })

  it('参数校验：非法哈希/路径拒绝', async () => {
    if (!(await gitAvailable())) return
    expect(isValidCommit('abc')).toBe(false)
    expect(isValidCommit('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(true)
    expect(isValidCommit('HEAD')).toBe(false) // 只有回滚入口允许 HEAD 字面量
    expect(isValidRelPath('../evil.ini')).toBe(false)
    expect(isValidRelPath('-x')).toBe(false)
    expect(isValidRelPath('units/a.ini')).toBe(true)
    const bad = await restoreFile(repo, '../evil', 'HEAD')
    expect(bad.ok).toBe(false)
    await expect(diffBetween(repo, 'abc', 'HEAD')).rejects.toThrow(/无效的提交哈希/)
  })
})

describe('conflictMarkers（冲突标记解析）', () => {
  it('解析 ours/theirs 与起始行；多块', () => {
    const content = [
      '[core]',
      'name: x',
      '<<<<<<< HEAD',
      'maxHp: 100',
      '=======',
      'maxHp: 200',
      '>>>>>>> branch-a',
      'price: 5',
      '<<<<<<< HEAD',
      'mass: 1',
      '=======',
      'mass: 2',
      '>>>>>>> branch-a',
    ].join('\n')
    const blocks = conflictMarkers(content)
    expect(blocks.length).toBe(2)
    expect(blocks[0].ours).toBe('maxHp: 100')
    expect(blocks[0].theirs).toBe('maxHp: 200')
    expect(blocks[0].startLine).toBe(3)
    expect(blocks[1].startLine).toBe(9)
    expect(blocks[1].ours).toBe('mass: 1')
  })

  it('无冲突标记返回空；残缺标记不误报', () => {
    expect(conflictMarkers('[core]\nname: x\n')).toEqual([])
    // 只有 <<<<<<< 没有结束：不构成块
    expect(conflictMarkers('<<<<<<< HEAD\nxxx\n')).toEqual([])
  })
})

describe('审查回归：statusFiles 空格文件名 / conflictFiles 拼根', () => {
  it('含空格文件名不引号、重命名合并为新路径', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'my unit.ini'), '[core]\nname: x\n')
    run(repo, ['add', 'my unit.ini'])
    run(repo, ['commit', '-q', '-m', 'add spaced'])
    fs.writeFileSync(path.join(repo, 'my unit.ini'), '[core]\nname: y\n')
    const st = await statusFiles(repo)
    const hit = st.find((f) => f.path === 'my unit.ini')
    expect(hit).toBeDefined()
    expect(hit!.path).not.toContain('"')
    // 重命名：old → new 合并为一条指向新路径
    run(repo, ['mv', 'my unit.ini', 'renamed.ini'])
    const st2 = await statusFiles(repo)
    const ren = st2.find((f) => f.status.startsWith('R'))
    expect(ren?.path).toBe('renamed.ini')
  })

  it('conflictFiles 用项目根拼接读取（非 CWD），能检测到冲突标记', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'c.ini'), '[core]\nname: base\n')
    run(repo, ['add', 'c.ini'])
    run(repo, ['commit', '-q', '-m', 'base'])
    fs.writeFileSync(path.join(repo, 'c.ini'), '[core]\nname: base\n<<<<<<< HEAD\nmaxHp: 1\n=======\nmaxHp: 2\n>>>>>>> other\n')
    const cf = await conflictFiles(repo)
    expect(cf).toContain('c.ini')
  })
})
