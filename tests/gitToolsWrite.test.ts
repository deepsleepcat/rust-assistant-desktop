/**
 * git 写操作测试（feat/git-visual-center）：
 * 真实临时 git 仓库（git CLI）覆盖 暂存/提交/分支/初始化/行数统计/双列状态/仓库配置。
 * 与 gitTools.test.ts 分离：原文件含历史遗留 NUL 字节导致工具链无法读取编辑。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkoutBranch, commitFiles, createBranch, deleteBranch, diffBetween, diffNumstat, discardFileWorktree,
  getRepoConfig, gitAvailable, initRepo, isValidBranchName, logHistory, repoInfo, sanitizeCommitMessage,
  setRepoConfig, stageAllFiles, stageFiles, statusDetailed, unstageFiles,
} from '../electron/gitTools'

function run(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

let repo: string

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-write-test-'))
  run(repo, ['init', '-q'])
  run(repo, ['config', 'user.email', 'test@example.com'])
  run(repo, ['config', 'user.name', '测试'])
})

afterEach(() => {
  // Windows 在 git 刚提交完时会短暂持有目录句柄（Defender/索引器也会），EPERM 是瞬时的：
  // 带重试删除，避免测试因清理阶段的环境抖动误报。
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 })
})

describe('git 写操作（feat/git-visual-center）', () => {
  it('isValidBranchName：白名单规则', () => {
    expect(isValidBranchName('main')).toBe(true)
    expect(isValidBranchName('feat/new-unit')).toBe(true)
    expect(isValidBranchName('ui/optical-alignment')).toBe(true)
    expect(isValidBranchName('')).toBe(false)
    expect(isValidBranchName('-flag')).toBe(false)
    expect(isValidBranchName('a..b')).toBe(false)
    expect(isValidBranchName('has space')).toBe(false)
    expect(isValidBranchName('tilde~x')).toBe(false)
    expect(isValidBranchName('caret^x')).toBe(false)
    expect(isValidBranchName('colon:x')).toBe(false)
    expect(isValidBranchName('star*x')).toBe(false)
    expect(isValidBranchName('lock.lock')).toBe(true)
    expect(isValidBranchName('x/.lock')).toBe(false)
    expect(isValidBranchName('end/')).toBe(false)
    expect(isValidBranchName('end.')).toBe(false)
    expect(isValidBranchName('at@{x')).toBe(false)
  })

  it('sanitizeCommitMessage：去控制字符/折叠空白/截断', () => {
    expect(sanitizeCommitMessage('  修复  单位\n血量 ')).toBe('修复 单位 血量')
    expect(sanitizeCommitMessage('a\x00b\x1fc')).toBe('abc')
    expect(sanitizeCommitMessage('x'.repeat(2100)).length).toBe(2000)
    expect(sanitizeCommitMessage('   ')).toBe('')
  })

  it('statusDetailed：XY 双列解析（暂存/工作区/未跟踪）', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'a.ini'), '[core]\nname: a\n')
    fs.writeFileSync(path.join(repo, 'b.ini'), '[core]\nname: b\n')
    run(repo, ['add', 'a.ini'])
    fs.appendFileSync(path.join(repo, 'a.ini'), 'extra: 1\n')
    const st = await statusDetailed(repo)
    const a = st.find((e) => e.path === 'a.ini')
    const b = st.find((e) => e.path === 'b.ini')
    expect(a?.staged).toBe('A')
    expect(a?.unstaged).toBe('M')
    expect(b?.untracked).toBe(true)
    expect(a?.untracked).toBe(false)
  })

  it('stageFiles/unstageFiles：暂存与取消暂存（空仓库走 rm --cached 兜底）', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'a.ini'), '[core]\nname: a\n')
    // 空仓库（无 HEAD）：unstage 的 reset 兜底路径
    expect(await stageFiles(repo, ['a.ini'])).toEqual({ ok: true })
    expect(await unstageFiles(repo, ['a.ini'])).toEqual({ ok: true })
    expect(await statusDetailed(repo)).toEqual([{ staged: '', unstaged: '', untracked: true, path: 'a.ini' }])
    // 有提交后：正常 reset 流程
    expect(await stageFiles(repo, ['a.ini'])).toEqual({ ok: true })
    expect(await commitFiles(repo, 'init')).toMatchObject({ ok: true })
    fs.writeFileSync(path.join(repo, 'a.ini'), '[core]\nname: a2\n')
    expect(await stageFiles(repo, ['a.ini'])).toEqual({ ok: true })
    expect(await unstageFiles(repo, ['a.ini'])).toEqual({ ok: true })
    const st = await statusDetailed(repo)
    expect(st[0]?.staged).toBe('')
    expect(st[0]?.unstaged).toBe('M')
  })

  it('stageFiles 拒绝非法路径', async () => {
    if (!(await gitAvailable())) return
    expect((await stageFiles(repo, ['../escape.ini'])).ok).toBe(false)
    expect((await stageFiles(repo, [])).ok).toBe(false)
  })

  it('commitFiles：提交返回哈希；空描述拒绝', async () => {
    if (!(await gitAvailable())) return
    expect((await commitFiles(repo, '   ')).ok).toBe(false)
    fs.writeFileSync(path.join(repo, 'a.ini'), 'a: 1\n')
    await stageAllFiles(repo)
    const r = await commitFiles(repo, 'init 提交')
    expect(r.ok).toBe(true)
    expect(r.hash).toMatch(/^[0-9a-f]{40}$/)
    // sanitize：控制字符被清理后仍可提交
    fs.appendFileSync(path.join(repo, 'a.ini'), 'extra: 1\n')
    await stageAllFiles(repo)
    expect((await commitFiles(repo, 'bad\x00msg')).ok).toBe(true)
  })

  it('diffNumstat：工作区/暂存区两组行数统计；二进制为 null', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 't.ini'), 'a: 1\n')
    await stageAllFiles(repo)
    await commitFiles(repo, 'base')
    fs.writeFileSync(path.join(repo, 't.ini'), 'a: 2\nb: 3\nc: 4\n')
    // 未跟踪文件（s.ini）不出现在 numstat——git diff 只看已跟踪文件
    fs.writeFileSync(path.join(repo, 's.ini'), 'x: 1\n')
    const n = await diffNumstat(repo)
    const unstagedT = n.unstaged.find((e) => e.path === 't.ini')
    expect(unstagedT?.add).toBe(3)
    expect(unstagedT?.del).toBe(1)
    expect(n.unstaged.find((e) => e.path === 's.ini')).toBeUndefined()
    // 暂存区 vs HEAD：暂存后出现条目
    await stageFiles(repo, ['t.ini', 's.ini'])
    const n2 = await diffNumstat(repo)
    expect(n2.staged.find((e) => e.path === 't.ini')?.add).toBe(3)
    expect(n2.staged.find((e) => e.path === 's.ini')?.add).toBe(1)
    // 二进制文件：add/del 为 null
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    await stageFiles(repo, ['bin.dat'])
    const n3 = await diffNumstat(repo)
    expect(n3.staged.find((e) => e.path === 'bin.dat')?.add).toBeNull()
  })

  it('createBranch/checkoutBranch/deleteBranch：分支生命周期（含未合并强删）', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'a.ini'), 'a: 1\n')
    await stageAllFiles(repo)
    await commitFiles(repo, 'base')
    expect((await createBranch(repo, 'feat/x')).ok).toBe(true)
    expect((await repoInfo(repo)).branch).toBe('feat/x')
    expect((await checkoutBranch(repo, 'master')).ok).toBe(true)
    expect((await repoInfo(repo)).branch).toBe('master')
    // 非法分支名拒绝
    expect((await createBranch(repo, '-bad')).ok).toBe(false)
    expect((await checkoutBranch(repo, '../escape')).ok).toBe(false)
    // 安全删除已合并分支；当前分支拒绝
    expect((await deleteBranch(repo, 'feat/x')).ok).toBe(true)
    expect((await deleteBranch(repo, 'master')).ok).toBe(false)
    // 未合并分支：-d 拒绝，-D 强删成功
    run(repo, ['checkout', '-q', '-b', 'orphan'])
    fs.writeFileSync(path.join(repo, 'o.ini'), 'o: 1\n')
    await stageAllFiles(repo)
    await commitFiles(repo, 'orphan commit')
    await checkoutBranch(repo, 'master')
    expect((await deleteBranch(repo, 'orphan')).ok).toBe(false)
    expect((await deleteBranch(repo, 'orphan', true)).ok).toBe(true)
  }, 15_000)

  it('initRepo：非仓库目录初始化；已存在时幂等', async () => {
    if (!(await gitAvailable())) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-init-'))
    try {
      expect((await initRepo(dir)).ok).toBe(true)
      expect((await repoInfo(dir)).isRepo).toBe(true)
      expect((await initRepo(dir)).ok).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discardFileWorktree：丢弃工作区改动；未跟踪文件删除', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'a.ini'), 'a: 1\n')
    await stageAllFiles(repo)
    await commitFiles(repo, 'base')
    fs.writeFileSync(path.join(repo, 'a.ini'), 'a: 2\n')
    fs.writeFileSync(path.join(repo, 'new.ini'), 'new\n')
    expect((await discardFileWorktree(repo, 'a.ini')).ok).toBe(true)
    // Windows 上 core.autocrlf 会把恢复出的文件写成 CRLF：按行内容比较（归一换行）
    expect(fs.readFileSync(path.join(repo, 'a.ini'), 'utf8').replace(/\r\n/g, '\n')).toBe('a: 1\n')
    expect((await discardFileWorktree(repo, 'new.ini')).ok).toBe(true)
    expect(fs.existsSync(path.join(repo, 'new.ini'))).toBe(false)
    // 越界路径拒绝
    expect((await discardFileWorktree(repo, '../x.ini')).ok).toBe(false)
  })

  it('getRepoConfig/setRepoConfig：仓库级身份配置（白名单键）', async () => {
    if (!(await gitAvailable())) return
    expect(await getRepoConfig(repo, 'user.name')).toBe('测试')
    expect((await setRepoConfig(repo, 'user.email', 'dev@example.com')).ok).toBe(true)
    expect(await getRepoConfig(repo, 'user.email')).toBe('dev@example.com')
    // 非白名单键拒绝
    expect((await setRepoConfig(repo, 'core.hooksPath', '/tmp')).ok).toBe(false)
    await expect(getRepoConfig(repo, 'core.hooksPath')).rejects.toThrow('不支持的配置键')
    // 空值拒绝
    expect((await setRepoConfig(repo, 'user.name', '  ')).ok).toBe(false)
  })

  it('repoInfo.hasIdentity：未配置时 commit 返回 identity 错误码', async () => {
    if (!(await gitAvailable())) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ident-'))
    try {
      run(dir, ['init', '-q'])
      // 本机全局 git 配置可能存在：仅当全局无身份时才有确定性断言
      let globalIdentity = true
      try {
        globalIdentity = Boolean(execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', windowsHide: true }).trim())
      } catch {
        globalIdentity = false
      }
      const info = await repoInfo(dir)
      expect(info.isRepo).toBe(true)
      if (!globalIdentity) {
        expect(info.hasIdentity).toBe(false)
        expect((await commitFiles(dir, 'x')).code).toBe('identity')
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('写操作错误信息：直显 git stderr 首行，不 dump 整条命令与参数', async () => {
    if (!(await gitAvailable())) return
    // 有效但不存在的路径 → git 报错「pathspec … did not match」：取 stderr 首行而非「Command failed: git add -- …」
    const r = await stageFiles(repo, ['不存在/路径.ini'])
    expect(r.ok).toBe(false)
    expect(r.message).toContain('pathspec')
    expect(r.message).not.toContain('Command failed')
    expect(r.message).not.toContain('git add')
    // 未跟踪文件 stageAllFiles 也能全部暂存（UI「全部暂存」按钮的正解路径）
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b')
    expect((await stageAllFiles(repo)).ok).toBe(true)
    expect(run(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).length).toBe(2)
  })

  it('空仓库（unborn HEAD）：repoInfo.hasCommits=false；建/切分支引导先提交', async () => {
    if (!(await gitAvailable())) return
    // beforeEach 刚 init 的仓库还没有提交
    const before = await repoInfo(repo)
    expect(before.hasCommits).toBe(false)
    expect(before.branches).toEqual([])
    // 建分支拒绝并提示先提交（否则只是顶掉占位名，旧名字「消失」）
    const create = await createBranch(repo, 'feat/x')
    expect(create.ok).toBe(false)
    expect(create.message).toContain('提交')
    const checkout = await checkoutBranch(repo, 'feat/x')
    expect(checkout.ok).toBe(false)
    expect(checkout.message).toContain('提交')
    // 首次提交前：差异展开用空树兜底（staged/working 都能看到「全文件新增」），历史为空不报错
    fs.writeFileSync(path.join(repo, 'first.txt'), 'hello')
    expect((await stageAllFiles(repo)).ok).toBe(true)
    const stagedDiff = await diffBetween(repo, 'HEAD', 'staged', 'first.txt')
    expect(stagedDiff).toContain('+hello')
    const workingDiff = await diffBetween(repo, 'HEAD', 'working', 'first.txt')
    expect(workingDiff).toContain('+hello')
    expect(await logHistory(repo)).toEqual([])
    // 首次提交后：hasCommits=true，分支正常创建
    expect((await commitFiles(repo, 'first')).ok).toBe(true)
    const after = await repoInfo(repo)
    expect(after.hasCommits).toBe(true)
    expect(after.branches).toEqual(['master'])
    expect((await createBranch(repo, 'feat/x')).ok).toBe(true)
  })

  it('index.lock：残留锁（≥10s）自动清理重试；新鲜锁拒绝并提示', async () => {
    if (!(await gitAvailable())) return
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c')
    // 残留锁：把 mtime 倒回 1 小时前，模拟上次 git 崩溃留下的死锁
    const stale = path.join(repo, '.git', 'index.lock')
    fs.writeFileSync(stale, '')
    const hourAgo = new Date(Date.now() - 3_600_000)
    fs.utimesSync(stale, hourAgo, hourAgo)
    expect((await stageAllFiles(repo)).ok).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
    expect(run(repo, ['diff', '--cached', '--name-only'])).toContain('c.txt')
    // 新鲜锁：刚刚创建，可能真有 git 在跑——不自动清，返回人话提示
    fs.writeFileSync(path.join(repo, 'd.txt'), 'd')
    fs.writeFileSync(stale, '')
    const r = await stageAllFiles(repo)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('占用')
    expect(fs.existsSync(stale)).toBe(true)
    // 收尾：清掉锁让 afterEach 删目录不受影响
    fs.rmSync(stale, { force: true })
  })
}, 30_000)
