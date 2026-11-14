/**
 * Git 审计缺陷修复验证（外部审计 2026-11-14 报告的 8 项，本文件覆盖主进程可单测的 1/3/4/5
 * 与云同步锁库语义；组件侧 2/6/7/8 由代码评审与浏览器验证覆盖）。
 * 断言均为「修复后的正确行为」——审计原用例断言的是缺陷存在时的错误行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffBetween, discardFileWorktree, restoreFile, stageAllFiles } from '../electron/gitTools'
import { acquireCloudBagOperation } from '../src/services/cloudBagOperation'
import { pullRemoteVersion } from '../src/services/cloudBagSync'

let repo: string
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-audit-fix-'))
  git('init', '-q', '-b', 'audit-main')
  git('config', 'user.name', 'Audit')
  git('config', 'user.email', 'audit@example.invalid')
  git('config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: base\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe('审计缺陷修复（feat/git-visual-center）', () => {
  it('⑤ diff 接受 HEAD：working 与 staged 两种展开都可用', async () => {
    fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: working\n')
    git('add', 'unit.ini')
    fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: working2\n')
    const wt = await diffBetween(repo, 'HEAD', 'working', 'unit.ini')
    expect(wt).toContain('value: working2')
    const sg = await diffBetween(repo, 'HEAD', 'staged', 'unit.ini')
    expect(sg).toContain('value: working')
  })

  it('③ 回滚只恢复工作区：暂存区内容不被覆盖', async () => {
    fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: staged\n')
    git('add', 'unit.ini')
    fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: working\n')
    expect((await restoreFile(repo, 'unit.ini', 'HEAD')).ok).toBe(true)
    // 暂存区仍是用户已暂存的 staged 内容；工作区回到 base
    expect(git('show', ':unit.ini')).toBe('value: staged')
    expect(fs.readFileSync(path.join(repo, 'unit.ini'), 'utf8')).toBe('value: base\n')
  })

  it('① 丢弃冲突中的已跟踪文件被拒绝且文件保留', async () => {
    git('checkout', '-q', '-b', 'audit-other')
    fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: other\n')
    git('commit', '-qam', 'other')
    git('checkout', '-q', 'audit-main')
    fs.writeFileSync(path.join(repo, 'unit.ini'), 'value: main\n')
    git('commit', '-qam', 'main')
    expect(() => git('merge', 'audit-other')).toThrow()
    expect(fs.readFileSync(path.join(repo, 'unit.ini'), 'utf8')).toContain('<<<<<<<')
    const r = await discardFileWorktree(repo, 'unit.ini')
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(repo, 'unit.ini'))).toBe(true)
  })

  it('① 丢弃未跟踪文件仍然直接删除', async () => {
    fs.writeFileSync(path.join(repo, 'new.ini'), 'new\n')
    expect((await discardFileWorktree(repo, 'new.ini')).ok).toBe(true)
    expect(fs.existsSync(path.join(repo, 'new.ini'))).toBe(false)
  })

  it('④ 嵌套子目录项目的全部暂存不再波及项目外文件', async () => {
    const nested = path.join(repo, 'mod')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, 'local.ini'), 'local\n')
    fs.writeFileSync(path.join(repo, 'outside.ini'), 'outside\n')
    expect((await stageAllFiles(nested)).ok).toBe(true)
    const staged = git('diff', '--cached', '--name-only')
    expect(staged).toContain('mod/local.ini')
    expect(staged).not.toContain('outside.ini')
  })

  it('⑥ 云同步锁库语义：外部 lease 在辅助函数失败后仍由调用方持有', async () => {
    const lease = acquireCloudBagOperation(repo)!
    try {
      const outcome = await pullRemoteVersion({
        rootPath: repo,
        repoSlug: 'audit',
        api: { exportRwmod: async () => { throw new Error('audit download failure') } },
        bridge: {},
        onProgress: () => undefined,
        isAborted: () => false,
        operationLease: lease,
      } as unknown as Parameters<typeof pullRemoteVersion>[0], { versionNo: 1 })
      expect(outcome.status).toBe('failed')
      expect(acquireCloudBagOperation(repo)).toBeNull()
    } finally { lease() }
    // 调用方释放后锁回到可用状态（组件侧的 finally lease() 修复保证这一点）
    expect(acquireCloudBagOperation(repo)).not.toBeNull()
  })
})
