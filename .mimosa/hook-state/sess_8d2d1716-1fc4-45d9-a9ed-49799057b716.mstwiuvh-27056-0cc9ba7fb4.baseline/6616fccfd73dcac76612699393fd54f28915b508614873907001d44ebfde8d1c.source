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
async function runGit(root: string, args: string[]): Promise<string> {
  const r = await execFileAsync('git', args, {
    cwd: root,
    timeout: GIT_TIMEOUT,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    encoding: 'utf8',
  })
  return r.stdout
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

/** 相对路径校验（防越界/选项注入） */
export function isValidRelPath(rel: string): boolean {
  if (!rel || rel.includes('..') || rel.startsWith('-') || rel.includes('\\')) return false
  return true
}

/** 仓库信息（可用性/分支/领先落后/改动数/分支列表） */
export async function repoInfo(root: string): Promise<GitRepoInfo> {
  const info: GitRepoInfo = { available: false, isRepo: false, branch: '', ahead: 0, behind: 0, changedCount: 0, branches: [] }
  if (!(await gitAvailable())) {
    info.message = '未检测到 git（需安装 Git for Windows）'
    return info
  }
  info.available = true
  try {
    await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    info.message = '项目不是 git 仓库（可安装 git 后在项目目录执行 git init）'
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

/** 两个提交间的文件差异文本（b 为 'working' 时对比工作区） */
export async function diffBetween(root: string, a: string, b: string, file?: string): Promise<string> {
  if (!isValidCommit(a)) throw new Error('无效的提交哈希')
  const args = ['diff', '--no-color']
  if (b === 'working') {
    args.push(a, '--')
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
    // 相对仓库根的路径必须拼上 root（主进程 CWD 不是项目根，相对路径读不到文件）
    const abs = path.join(root, f.path)
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

/** 回滚单个文件到指定提交（只影响工作区该文件；提交缺省 = HEAD） */
export async function restoreFile(root: string, file: string, commit = 'HEAD'): Promise<{ ok: boolean; message?: string }> {
  if (!isValidRelPath(file)) return { ok: false, message: '无效的文件路径' }
  if (commit !== 'HEAD' && !isValidCommit(commit)) return { ok: false, message: '无效的提交哈希' }
  try {
    // 文件可能尚未跟踪（?? 状态）：checkout 会失败——先尝试，失败给出提示
    await runGit(root, ['checkout', commit, '--', file])
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}
