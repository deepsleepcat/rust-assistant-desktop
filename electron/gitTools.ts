/**
 * 本地 git 辅助（M25，P3 任务 4，本地单人部分）：
 * 历史可视化 / 冲突预览 / 回滚——只做本地单人使用，无服务器、无多人协作。
 *
 * 安全设计：
 * - 全部经 git CLI（参数数组，不经 shell）；cwd 固定为项目根；
 * - commit/路径参数严格校验（十六进制哈希 / 无 .. / 不以 - 开头）；
 * - 命令超时（15s）防挂死；输出大小上限（8MB）；
 * - 回滚（checkout -- file）只影响工作区指定文件，不碰其它文件与分支。
 * 多人协作（邀请/权限）依赖服务器，不在本阶段。
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import { conflictMarkers } from '../src/utils/conflictMarkers.js'
import { promisify } from 'node:util'
import { isAnyPlatformAbsolute } from './paths'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)

/** 命令超时（毫秒） */
const GIT_TIMEOUT = 15_000
/** 输出上限（git log 大仓库可能输出很多） */
const MAX_OUTPUT = 8 * 1024 * 1024

export interface GitRepoInfo {
  /** git 是否可用（未安装 git 时所有功能不可用） */
  available: boolean
  /** 项目是否在 git 仓库内 */
  isRepo: boolean
  branch: string
  /** 领先/落后远端提交数（无远端时 0） */
  ahead: number
  behind: number
  /** 未提交改动文件数（工作区 + 暂存区） */
  changedCount: number
  branches: string[]
  /** 提交者身份（user.name + user.email）是否已配置（isRepo 时才检查） */
  hasIdentity: boolean
  message?: string
}

export interface GitCommitEntry {
  hash: string
  short: string
  author: string
  at: number
  subject: string
}

export interface GitStatusEntry {
  /** 状态码（M/A/D/R/?/U 等，porcelain v1 双字母取首个非空） */
  status: string
  path: string
}

/** 执行 git（cwd=项目根；失败抛错） */
async function runGitOnce(root: string, args: string[]): Promise<string> {
  const r = await execFileAsync('git', args, {
    cwd: root,
    timeout: GIT_TIMEOUT,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    encoding: 'utf8',
  })
  return r.stdout
}

/** 报错是否为 index.lock 占用（git 崩溃/被杀后会残留锁文件，挡住后续所有写操作） */
function isLockError(err: unknown): boolean {
  const e = err as Partial<{ stderr: unknown; message: unknown }> | null
  const text = `${typeof e?.stderr === 'string' ? e.stderr : ''} ${typeof e?.message === 'string' ? e.message : ''}`
  return text.includes('index.lock')
}

/** 清理残留锁：只清「已经存在 ≥10 秒」的锁——活着的 git 进程随时可能在写，
 * 新鲜的锁（≤10s）不碰，留给正常流程释放。 */
async function removeStaleIndexLock(root: string): Promise<boolean> {
  const lock = path.join(root, '.git', 'index.lock')
  try {
    const st = await fs.stat(lock)
    if (Date.now() - st.mtimeMs < 10_000) return false
    await fs.rm(lock, { force: true })
    return true
  } catch {
    return false
  }
}

/** 执行 git：遇到残留 index.lock 自动清理后重试一次 */
async function runGit(root: string, args: string[]): Promise<string> {
  try {
    return await runGitOnce(root, args)
  } catch (err) {
    if (isLockError(err) && (await removeStaleIndexLock(root))) {
      return await runGitOnce(root, args)
    }
    throw err
  }
}

/** git 是否可用 */
export async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 提交哈希校验（7-40 位十六进制；防参数注入） */
export function isValidCommit(hash: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(hash)
}

/** 相对路径校验（防越界/选项注入/绝对路径拼接） */
export function isValidRelPath(rel: string): boolean {
  if (!rel || rel.includes('..') || rel.startsWith('-') || rel.includes('\\')) return false
  // 任何平台的绝对路径一律拒绝（win32 的盘符会让 path.join 丢弃 root；非 win32 则是安全校验兜底）
  if (isAnyPlatformAbsolute(rel)) return false
  return true
}

/** 仓库信息（可用性/分支/领先落后/改动数/分支列表/提交者身份） */
export async function repoInfo(root: string): Promise<GitRepoInfo> {
  const info: GitRepoInfo = { available: false, isRepo: false, branch: '', ahead: 0, behind: 0, changedCount: 0, branches: [], hasIdentity: false }
  if (!(await gitAvailable())) {
    info.message = '未检测到 git（需安装 Git for Windows）'
    return info
  }
  info.available = true
  try {
    await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    info.message = '项目还不是 git 仓库——可在 Git 面板一键初始化'
    return info
  }
  info.isRepo = true
  // 状态：分支行 `## main...origin/main [ahead 1, behind 2]` + 改动行
  const status = await runGit(root, ['status', '--porcelain=v1', '-b']).catch(() => '')
  const lines = status.split('\n').filter((l) => l.trim())
  const branchLine = lines.find((l) => l.startsWith('## ')) ?? ''
  // 空仓提示（No commits yet on main）/ 分离头（HEAD (no branch)）：先剔除再解析
  const cleaned = branchLine.replace(/^## /, '').replace(/\(no branch\)$/, '').replace(/^No commits yet on /, '')
  const m = /^([^\s]+?)(?:\.\.\.([^\s\]]+))?(?: \[(.*?)\])?$/.exec(cleaned)
  if (m) {
    info.branch = m[1] === 'HEAD' ? '(分离头)' : m[1]
    const meta = m[3] ?? ''
    const ahead = /ahead (\d+)/.exec(meta)
    const behind = /behind (\d+)/.exec(meta)
    info.ahead = ahead ? Number(ahead[1]) : 0
    info.behind = behind ? Number(behind[1]) : 0
  }
  info.changedCount = lines.filter((l) => !l.startsWith('## ')).length
  info.branches = (await runGit(root, ['branch', '--format=%(refname:short)']).catch(() => '')).split('\n').filter(Boolean)
  // 提交者身份检查（空仓首次提交前必须配置；读取失败视为未配置）
  info.hasIdentity = Boolean(
    (await runGit(root, ['config', 'user.name']).catch(() => '')).trim()
    && (await runGit(root, ['config', 'user.email']).catch(() => '')).trim(),
  )
  return info
}

/** 提交历史（最新在前） */
export async function logHistory(root: string, limit = 40): Promise<GitCommitEntry[]> {
  const out = await runGit(root, [
    'log',
    `--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s`,
    '-n',
    String(Math.min(Math.max(limit, 1), 200)),
  ]).catch(() => '')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, author, at, subject] = line.split('\x1f')
      return { hash, short, author, at: Number(at) || 0, subject: subject ?? '' }
    })
}

/** 合法状态字符（porcelain v1 首位/次位：M/A/D/R/C/U/?/空格） */
const STATUS_CHARS = new Set(['M', 'A', 'D', 'R', 'C', 'U', '?', ' '])

/** 工作区改动清单（porcelain v1 -z：NUL 分隔，含空格文件名不带引号，可直接用）。
 * -z 的重命名格式为 "R  new\0old\0"：第二段是裸旧路径（无状态列）——
 * 新路径已在第一条记录里，续段直接丢弃 */
export async function statusFiles(root: string): Promise<GitStatusEntry[]> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-z']).catch(() => '')
  const parts = out.split('\u0000').filter((p) => p.length > 0)
  const entries: GitStatusEntry[] = []
  for (const raw of parts) {
    // 合法记录 = 2 个状态字符 + 1 空格 + 路径；其余（重命名/复制的续段）跳过
    const status = raw.slice(0, 2)
    if (![...status].every((c) => STATUS_CHARS.has(c)) || raw[2] !== ' ') continue
    entries.push({ status: status.trim() || '?', path: raw.slice(3) })
  }
  return entries
}

/** 两个提交间的文件差异文本（b 为 'working' 时对比工作区；'staged' 时对比暂存区）。
 * a 允许 'HEAD' 字面量（Git 面板差异展开用；空仓库无 HEAD 时 git 自身报错透传）。 */
export async function diffBetween(root: string, a: string, b: string, file?: string): Promise<string> {
  if (a !== 'HEAD' && !isValidCommit(a)) throw new Error('无效的提交哈希')
  const args = ['diff', '--no-color']
  if (b === 'working') {
    args.push(a, '--')
  } else if (b === 'staged') {
    // 暂存区 vs 提交：git diff --cached <commit> -- <file>
    args.push('--cached', a, '--')
  } else {
    if (!isValidCommit(b)) throw new Error('无效的提交哈希')
    args.push(a, b, '--')
  }
  if (file) {
    if (!isValidRelPath(file)) throw new Error('无效的文件路径')
    args.push(file)
  }
  return runGit(root, args).catch(() => '（无法生成差异）')
}

/** 有冲突标记的文件（扫描工作区改动文件，上限 10 个 × 1MB） */
export async function conflictFiles(root: string): Promise<string[]> {
  const files = await statusFiles(root)
  const out: string[] = []
  for (const f of files) {
    if (out.length >= 10) break
    if (!isValidRelPath(f.path)) continue
    // 相对仓库根的路径必须拼上 root（主进程 CWD 不是项目根，相对路径读不到文件）。
    // resolve + 显式边界校验（isValidRelPath 之外的双保险，静态检查可见）
    const abs = path.resolve(root, f.path)
    const base = path.resolve(root)
    if (abs !== base && !abs.startsWith(base + path.sep)) continue
    try {
      const st = await fs.stat(abs)
      if (!st.isFile() || st.size > 1024 * 1024) continue
      const content = await fs.readFile(abs, 'utf8')
      if (conflictMarkers(content).length > 0) out.push(f.path)
    } catch {
      // 文件不存在（已删）等：跳过
    }
  }
  return out
}

/** 回滚单个文件到指定提交（只恢复工作区，不动暂存区；提交缺省 = HEAD）。
 * 用 git restore --worktree 而非 checkout <commit> -- <file>：后者同时恢复
 * 暂存区，会把用户已暂存的内容一并覆盖（与界面文案「只影响工作区」矛盾）。 */
export async function restoreFile(root: string, file: string, commit = 'HEAD'): Promise<{ ok: boolean; message?: string }> {
  if (!isValidRelPath(file)) return { ok: false, message: '无效的文件路径' }
  if (commit !== 'HEAD' && !isValidCommit(commit)) return { ok: false, message: '无效的提交哈希' }
  try {
    // 文件可能尚未跟踪（?? 状态）：restore 会失败——先尝试，失败给出提示
    await runGit(root, ['restore', '--worktree', `--source=${commit}`, '--', file])
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}

// ── Git 可视化中心（feat/git-visual-center）：写操作全部沿用上述安全模式 ─────────
// 设计约束：execFile 参数数组不经 shell；路径过 isValidRelPath；分支名过白名单正则；
// 写操作返回 {ok, message?}（不抛错），读操作失败降级为空结果。

/** 双列状态条目（porcelain v1：X=暂存区状态，Y=工作区状态，??=未跟踪） */
export interface GitStatusDetail {
  /** 暂存区状态（M/A/D/R/C；空格 = 暂存区无变化） */
  staged: string
  /** 工作区状态（M/D；空格 = 工作区无进一步改动） */
  unstaged: string
  /** 未跟踪文件（?? 状态） */
  untracked: boolean
  path: string
}

/** 行数统计条目（numstat；二进制文件 add/del 为 null） */
export interface GitNumstatEntry {
  path: string
  /** 新增行数（二进制文件为 null） */
  add: number | null
  /** 删除行数（二进制文件为 null） */
  del: number | null
}

/** 分支名白名单（git check-ref-format 规则的安全子集）：
 * 拒绝空名/过长、`-` 开头（防选项注入）、`..`、`~^:?*[\` 控制字符、
 * 空格、`//`、`@{`、首尾 `/` 与 `.`、`.lock` 结尾段。 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false
  if (name.startsWith('-') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes(' ') || name.includes('//') || name.includes('@{')) return false
  // eslint-disable-next-line no-control-regex -- 分支名中的控制字符必须拒绝（防终端/参数注入）
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  if (/[~^:?*[\\\]]/.test(name)) return false
  if (/(^|\/)\.lock$/.test(name)) return false
  return true
}

/** 清理提交描述：去除控制字符（保留空格）、折叠空白为单行、截断 2000 字符 */
export function sanitizeCommitMessage(message: string): string {
  // eslint-disable-next-line no-control-regex -- 提交信息只需要可读单行文本
  return message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000)
}

/** 统一结果包装（写操作不抛错，错误取 git stderr 首行给 UI 直显）。
 * 不能用 err.message：execFile 的 message 是「Command failed: <整条命令及全部参数>」，
 * 暂存几百个文件时会把所有文件名原样 dump 进提示框。 */
function toResult(err: unknown): { ok: false; message: string } {
  const e = err as Partial<{ stderr: unknown; code: unknown; message: string }> | null
  // 首选 git stderr 首行（如「fatal: pathspec … did not match」）
  let msg = ''
  if (e && typeof e.stderr === 'string' && e.stderr.trim()) {
    msg = e.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  }
  if (!msg && e && typeof e.code === 'string' && e.code) {
    // spawn 层失败（没到 git 进程）：命令行超长 / 超时等，给可读文案
    if (e.code === 'ENAMETOOLONG') return { ok: false, message: '命令行过长：文件太多，请改用「全部暂存」' }
    if (e.code === 'ETIMEDOUT') return { ok: false, message: 'git 命令超时（15 秒）' }
    return { ok: false, message: `git 命令执行失败（${e.code}）` }
  }
  if (!msg) msg = (e?.message ?? String(err)).split('\n')[0]
  // 锁文件还新鲜（≤10s 内创建，可能真有 git 在跑，自动清理不敢碰）
  if (msg.includes('index.lock')) return { ok: false, message: 'git 正被另一个操作占用，请等几秒重试；反复出现请重启应用' }
  // 兜底：message 形如「Command failed: git add -- <全部参数>」，只留通用文案
  return { ok: false, message: msg.startsWith('Command failed:') ? 'git 命令执行失败' : msg }
}

/** 暂存指定文件（未跟踪文件也会加入；路径过白名单校验） */
export async function stageFiles(root: string, paths: string[]): Promise<{ ok: boolean; message?: string }> {
  const valid = paths.filter(isValidRelPath)
  if (valid.length === 0) return { ok: false, message: '没有有效的文件路径' }
  try {
    await runGit(root, ['add', '--', ...valid])
    return { ok: true }
  } catch (err) {
    return toResult(err)
  }
}

/** 暂存全部改动（含新增与删除），范围限定项目根目录。
 * 必须带 `-- .`：项目允许位于父仓库的子目录中，裸 `git add -A` 会把
 * 仓库里项目目录之外的文件也一并暂存进来。 */
export async function stageAllFiles(root: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await runGit(root, ['add', '-A', '--', '.'])
    return { ok: true }
  } catch (err) {
    return toResult(err)
  }
}

/** 取消暂存（改动保留在工作区）。空仓库（无 HEAD）时退回 git rm --cached。 */
export async function unstageFiles(root: string, paths: string[]): Promise<{ ok: boolean; message?: string }> {
  const valid = paths.filter(isValidRelPath)
  if (valid.length === 0) return { ok: false, message: '没有有效的文件路径' }
  try {
    await runGit(root, ['reset', '-q', 'HEAD', '--', ...valid])
    return { ok: true }
  } catch {
    // 空仓库没有 HEAD：reset 失败——改用 rm --cached 把文件移出暂存区
    try {
      await runGit(root, ['rm', '--cached', '-q', '--', ...valid])
      return { ok: true }
    } catch (err) {
      return toResult(err)
    }
  }
}

/** 提交暂存内容。缺少提交者身份时 code='identity'，UI 引导配置后重试。 */
export async function commitFiles(root: string, message: string): Promise<{ ok: boolean; hash?: string; message?: string; code?: 'identity' }> {
  const clean = sanitizeCommitMessage(message)
  if (!clean) return { ok: false, message: '提交描述不能为空' }
  try {
    await runGit(root, ['commit', '-m', clean])
    const hash = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
    return { ok: true, hash }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // 典型报错：「Please tell me who you are」/「unable to auto-detect email address」
    if (/who you are|ident|user\.name|user\.email/i.test(raw)) {
      return { ok: false, code: 'identity', message: '需要先设置提交者身份（用户名与邮箱）' }
    }
    return { ok: false, message: raw.split('\n')[0] }
  }
}

/** 新建分支（checkout=true 时立即切换；切换携带未提交改动由 git 自行拒绝并透报） */
export async function createBranch(root: string, name: string, checkout = true): Promise<{ ok: boolean; message?: string }> {
  if (!isValidBranchName(name)) return { ok: false, message: '分支名不合法（不能含空格 ~ ^ : ? * [ ] 与 ..，不能以 - / . 结尾）' }
  try {
    await runGit(root, checkout ? ['checkout', '-b', name] : ['branch', name])
    return { ok: true }
  } catch (err) {
    return toResult(err)
  }
}

/** 切换分支（工作区有冲突改动时 git 拒绝并透报原因） */
export async function checkoutBranch(root: string, name: string): Promise<{ ok: boolean; message?: string }> {
  if (!isValidBranchName(name)) return { ok: false, message: '分支名不合法' }
  try {
    await runGit(root, ['checkout', name])
    return { ok: true }
  } catch (err) {
    return toResult(err)
  }
}

/** 删除分支（默认安全删除 -d；当前分支拒绝；未合并改动需 force=true 强删） */
export async function deleteBranch(root: string, name: string, force = false): Promise<{ ok: boolean; message?: string }> {
  if (!isValidBranchName(name)) return { ok: false, message: '分支名不合法' }
  try {
    const current = (await runGit(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim()
    if (current === name) return { ok: false, message: '不能删除当前所在的分支' }
    await runGit(root, force ? ['branch', '-D', name] : ['branch', '-d', name])
    return { ok: true }
  } catch (err) {
    return toResult(err)
  }
}

/** 一键初始化仓库（已存在时幂等返回成功） */
export async function initRepo(root: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await runGit(root, ['rev-parse', '--is-inside-work-tree'])
    return { ok: true }
  } catch {
    try {
      await runGit(root, ['init'])
      return { ok: true }
    } catch (err) {
      return toResult(err)
    }
  }
}

/** 丢弃单文件工作区改动（从暂存区恢复；未跟踪文件直接删除）。
 * 与 restoreFile 的区别：只动工作区，不覆盖暂存区内容。
 * checkout -- 失败不一定意味着未跟踪：合并冲突（unmerged）的已跟踪文件同样
 * 会失败——必须先经 statusDetailed 确认该文件确为未跟踪才允许 fs.rm，否则
 * 会把冲突中的已跟踪文件直接删掉。 */
export async function discardFileWorktree(root: string, file: string): Promise<{ ok: boolean; message?: string }> {
  if (!isValidRelPath(file)) return { ok: false, message: '无效的文件路径' }
  try {
    await runGit(root, ['checkout', '--', file])
    return { ok: true }
  } catch {
    const st = await statusDetailed(root).catch(() => [])
    const entry = st.find((e) => e.path === file)
    if (!entry?.untracked) {
      // 已跟踪文件（含冲突/已暂存状态）：不能删，把拒绝原因交界面
      return { ok: false, message: '该文件已被 git 跟踪（或处于冲突中），不能直接丢弃——请先解决冲突或使用回滚' }
    }
    // 未跟踪文件：确认在根内后直接删除
    const abs = path.resolve(root, file)
    const base = path.resolve(root)
    if (abs !== base && !abs.startsWith(base + path.sep)) return { ok: false, message: '无效的文件路径' }
    try {
      await fs.rm(abs, { force: true })
      return { ok: true }
    } catch (err) {
      return toResult(err)
    }
  }
}

/** 双列状态清单（porcelain v1 -z：NUL 分隔；重命名续段为裸旧路径，跳过） */
export async function statusDetailed(root: string): Promise<GitStatusDetail[]> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-z']).catch(() => '')
  const parts = out.split('\u0000').filter((p) => p.length > 0)
  const entries: GitStatusDetail[] = []
  for (const raw of parts) {
    const x = raw[0]
    const y = raw[1]
    if (raw[2] !== ' ' || !STATUS_CHARS.has(x) || !STATUS_CHARS.has(y)) continue
    if (x === '?' && y === '?') {
      entries.push({ staged: '', unstaged: '', untracked: true, path: raw.slice(3) })
    } else {
      entries.push({ staged: x === ' ' ? '' : x, unstaged: y === ' ' ? '' : y, untracked: false, path: raw.slice(3) })
    }
  }
  return entries
}

/** 解析 numstat -z 单段：`add\tdel\tpath`；二进制为 `-\t-\t`；续段（裸旧路径）无 tab */
function parseNumstatSegment(segment: string): GitNumstatEntry | null {
  const parts = segment.split('\t')
  if (parts.length < 3) return null
  const [addRaw, delRaw, ...pathParts] = parts
  const file = pathParts.join('\t')
  if (!file) return null
  if (addRaw === '-' || delRaw === '-') return { path: file, add: null, del: null }
  const add = Number(addRaw)
  const del = Number(delRaw)
  if (!Number.isFinite(add) || !Number.isFinite(del)) return null
  return { path: file, add, del }
}

/** 行数统计：工作区（vs 暂存区）与暂存区（vs HEAD）两组；空仓库暂存组为空 */
export async function diffNumstat(root: string): Promise<{ unstaged: GitNumstatEntry[]; staged: GitNumstatEntry[] }> {
  const parse = (out: string): GitNumstatEntry[] =>
    out.split('\u0000')
      .map(parseNumstatSegment)
      .filter((e): e is GitNumstatEntry => e !== null)
  const unstaged = parse(await runGit(root, ['diff', '--numstat', '-z']).catch(() => ''))
  const staged = parse(await runGit(root, ['diff', '--cached', '--numstat', '-z']).catch(() => ''))
  return { unstaged, staged }
}

/** 配置键白名单（仓库级 user.name / user.email，供首次提交身份引导） */
const CONFIG_KEYS = new Set(['user.name', 'user.email'])

/** 读仓库级配置（未设置返回 null；键必须白名单内） */
export async function getRepoConfig(root: string, key: string): Promise<string | null> {
  if (!CONFIG_KEYS.has(key)) throw new Error('不支持的配置键')
  const out = (await runGit(root, ['config', '--local', key]).catch(() => '')).trim()
  return out || null
}

/** 写仓库级配置（值去控制字符、单行、≤200 字符；键必须白名单内） */
export async function setRepoConfig(root: string, key: string, value: string): Promise<{ ok: boolean; message?: string }> {
  if (!CONFIG_KEYS.has(key)) return { ok: false, message: '不支持的配置键' }
  // eslint-disable-next-line no-control-regex -- 配置值不允许控制字符（换行/终端注入面）
  const clean = value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200)
  if (!clean) return { ok: false, message: '配置值不能为空' }
  try {
    await runGit(root, ['config', '--local', key, clean])
    return { ok: true }
  } catch (err) {
    return toResult(err)
  }
}
