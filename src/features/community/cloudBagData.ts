/**
 * 云书包纯逻辑层（UI 之外的判定/解析/格式化，全部可单测，不依赖 Electron 与网络）。
 * 与后端契约（ohmytxhouduan/docs/CLOUD-BAG-API-DATA-CONTRACT.md §1.5/§3.3）逐字对齐：
 * 扩展名白名单、路径规则、四分态同步判定、锚点结构。
 */
import type { CloudBagDiffEntry, CloudBagTreeEntry } from '../../services/cloudBagApi'

/** 树内文件扩展名白名单（后端契约 §1.5，来源 modPack/modReport/tmx） */
export const CLOUDBAG_ALLOWED_EXTENSIONS = [
  '.ini', '.template', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.ogg', '.wav', '.mp3', '.flac', '.tmx', '.tsx', '.txt',
] as const

/** 单文件上传上限（J5：V1 无两阶段大文件上传） */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024

/** Windows 保留设备名（与后端 cloudbagDeviceNameRE 及 electron/cloudbagTree.ts 同口径，
 * 逐路径段判定）：段本身或「设备名 + '.' 后缀」都不得作为路径段。 */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** 本地同步锚点：主进程排除打包 + 恢复保护的双边契约（桌面契约 §6.4） */
export const CLOUD_BAG_ANCHOR_PATH = '.ohmytx/cloud.json'

export interface CloudBagAnchor {
  repoSlug: string
  baselineSeq: number
  baselineTreeDigest: string
  lastSyncedAt: number
}

/** 本地文件读取能力分类：文本走 readFile，图片/音频走 data URL 读器，其余二进制本轮跳过 */
export type LocalFileKind = 'text' | 'image' | 'audio' | 'binary'

export function classifyLocalFile(path: string): LocalFileKind {
  const ext = extensionOf(path)
  if (['.ini', '.template', '.txt', '.tmx', '.tsx', '.json', '.md'].includes(ext)) return 'text'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 'image'
  if (['.ogg', '.wav', '.mp3', '.flac'].includes(ext)) return 'audio'
  return 'binary'
}

/** 取扩展名：与主进程 electron/cloudbagTree.ts 及后端 validateCloudBagPath 同口径——
 * 以最后一个 '.' 为界，允许点号位于首位（`.ini`/`sub/.ini` 是后端合法条目，旧 `dot > 0`
 * 守卫会误拒，导致含此类条目的版本树在桌面端不可拉取）。 */
function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

/** 与主进程/后端 Go strings.ToLower 同源：逐码点 simple lower，不作 NFC 或 fullfold。 */
export function cloudBagPathKey(path: string): string {
  return Array.from(path, (rune) => rune === '\u0130' ? 'i' : rune.toLowerCase()).join('')
}

/** 树内路径校验（与后端 §1.5 同规则：posix 相对路径，拒 ..、反斜杠、NUL、盘符、超 200 rune）。
 * 另加「路径段级非法字符」`< > : " | ? *` 与尾点/尾空格：与 electron/fsIpc.ts 的
 * assertValidName 及主进程 `electron/cloudbagTree.ts` 同口径——`units/tank.ini:evil`
 * 在 NTFS 上会落成备用数据流（ADS），既不进文件树也会让备份/差集判定失真。 */
export function isValidTreePath(path: string): boolean {
  // 长度按码点计（与后端 utf8.RuneCountInString / 主进程 isCloudBagTreePath 同口径）：
  // UTF-16 length 会把 astral 字符按 2 计，误拒后端合法的 ≤200 rune 路径。
  if (!path || [...path].length > 200) return false
  if (path.includes('\\') || path.includes('\0')) return false
  if (/^[A-Za-z]:/.test(path) || path.startsWith('/')) return false
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
    if (DEVICE_NAME_RE.test(segment)) return false
    // eslint-disable-next-line no-control-regex -- 控制字符在路径里不可见且易被滥用
    if (/[<>:"|?*\x00-\x1f\x7f]/.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
  }
  return CLOUDBAG_ALLOWED_EXTENSIONS.includes(extensionOf(path) as (typeof CLOUDBAG_ALLOWED_EXTENSIONS)[number])
}

/** 白名单 + 路径 + 50MiB 三重检查：把本地文件清单分为可上传 / 超限 / 不支持三组 */
export interface LocalFilePlanInput {
  path: string
  size: number
}

export interface LocalFilePlan {
  uploadable: LocalFilePlanInput[]
  oversized: LocalFilePlanInput[]
  unsupported: LocalFilePlanInput[]
}

export function buildLocalFilePlan(files: LocalFilePlanInput[]): LocalFilePlan {
  const plan: LocalFilePlan = { uploadable: [], oversized: [], unsupported: [] }
  const paths = new Map<string, string>()
  for (const file of files) {
    if (!isValidTreePath(file.path)) {
      plan.unsupported.push(file)
      continue
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) plan.oversized.push(file)
    else {
      const key = cloudBagPathKey(file.path)
      if (paths.has(key)) throw new Error(`云书包路径键冲突：${paths.get(key)} / ${file.path}，请先重命名后发布`)
      paths.set(key, file.path)
      plan.uploadable.push(file)
    }
  }
  return plan
}

/** 文件树构建：扁平清单 → 目录层级（纯函数，UI 只渲染结果） */
export interface CloudBagTreeNode {
  name: string
  path: string
  size: number
  sha256: string
  isDirectory: boolean
  children: CloudBagTreeNode[]
}

export function buildCloudBagTree(entries: CloudBagTreeEntry[]): CloudBagTreeNode[] {
  const roots: CloudBagTreeNode[] = []
  const dirIndex = new Map<string, CloudBagTreeNode>()
  const ensureDir = (segments: string[]): CloudBagTreeNode => {
    const path = segments.join('/')
    const existing = dirIndex.get(path)
    if (existing) return existing
    const node: CloudBagTreeNode = { name: segments[segments.length - 1] ?? '', path, size: 0, sha256: '', isDirectory: true, children: [] }
    dirIndex.set(path, node)
    if (segments.length === 1) roots.push(node)
    else ensureDir(segments.slice(0, -1)).children.push(node)
    return node
  }
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
  for (const entry of sorted) {
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const parent = segments.length === 1 ? null : ensureDir(segments.slice(0, -1))
    const node: CloudBagTreeNode = { name: segments[segments.length - 1], path: entry.path, size: entry.size, sha256: entry.sha256, isDirectory: false, children: [] }
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const byName = (a: CloudBagTreeNode, b: CloudBagTreeNode) => a.name.localeCompare(b.name, 'zh-CN')
  const sortRec = (nodes: CloudBagTreeNode[]): CloudBagTreeNode[] =>
    nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || byName(a, b)).map((n) => ({ ...n, children: sortRec(n.children) }))
  return sortRec(roots)
}

/** 服务端文件级 diff 摘要（×N 修改 +N 新增 −N 删除） */
export function summarizeDiff(entries: CloudBagDiffEntry[]): string {
  const added = entries.filter((entry) => entry.change === 'added').length
  const removed = entries.filter((entry) => entry.change === 'removed').length
  const modified = entries.filter((entry) => entry.change === 'modified').length
  const parts: string[] = []
  if (added) parts.push(`新增 ${added}`)
  if (modified) parts.push(`修改 ${modified}`)
  if (removed) parts.push(`删除 ${removed}`)
  return parts.length > 0 ? parts.join(' · ') : '无差异'
}

/** 渲染层安全的 mod-info.txt [mod] 节解析（服务端 manifest 同形；不导入 electron/modIni 的 Node 目标） */
export function parseModInfoManifest(content: string): {
  title: string
  description: string
  thumbnail: string
  version: string
  author: string
  update: string
  minVersion: string
} | null {
  let inMod = false
  const values = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      inMod = section[1].trim().toLowerCase() === 'mod' || section[1].trim() === '模组'
      continue
    }
    if (!inMod) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!values.has(key)) values.set(key, value)
  }
  const title = values.get('title') ?? values.get('名称') ?? ''
  if (!title) return null
  return {
    title,
    description: values.get('description') ?? '',
    thumbnail: values.get('thumbnail') ?? '',
    version: values.get('version') ?? '',
    author: values.get('author') ?? '',
    update: values.get('update') ?? '',
    minVersion: values.get('minversion') ?? '',
  }
}

/** 锚点解析：损坏/异构锚一律回 null（视为未绑定，不误导同步判定） */
export function parseCloudBagAnchor(text: string): CloudBagAnchor | null {
  try {
    const raw = JSON.parse(text) as Partial<CloudBagAnchor>
    if (typeof raw.repoSlug !== 'string' || !raw.repoSlug.trim()) return null
    if (!Number.isInteger(raw.baselineSeq) || (raw.baselineSeq ?? 0) < 0) return null
    if (typeof raw.baselineTreeDigest !== 'string') return null
    if (!Number.isFinite(raw.lastSyncedAt)) return null
    return {
      repoSlug: raw.repoSlug,
      baselineSeq: raw.baselineSeq ?? 0,
      baselineTreeDigest: raw.baselineTreeDigest,
      lastSyncedAt: raw.lastSyncedAt ?? 0,
    }
  } catch {
    return null
  }
}

export function serializeCloudBagAnchor(anchor: CloudBagAnchor): string {
  return JSON.stringify(anchor, null, 2)
}

export type SyncState = 'clean' | 'local-ahead' | 'remote-ahead' | 'conflict' | 'unbound'

export interface SyncJudgeInput {
  /** 本地锚点（null = 未绑定过云书包仓库） */
  anchor: CloudBagAnchor | null
  /** 当前打开仓库的标识。锚点属于**别的**仓库时四分态无意义（基线是另一棵版本树的
   * 序号，与当前仓库 head 比较会得到 clean/remote-ahead 这类假状态），一律判 unbound。 */
  repoSlug: string
  /** 远端 head 版本号（仓库无版本时为 0） */
  remoteHeadVersionNo: number
  /** 本地相对锚点基线是否有变更（git status 非空；git 不可用时为 null=未知） */
  localChanged: boolean | null
}

/** 手动同步四分态判定（桌面契约 §6.4）：clean / 仅本地变 / 仅远端新 / 双向变（冲突）。
 * 锚点存在但绑定的是另一个仓库 → unbound（UI 必须显式提示「已绑定仓库 X，继续会重设基线」，
 * 绝不静默改绑）。 */
export function judgeSyncState(input: SyncJudgeInput): SyncState {
  if (!input.anchor) return 'unbound'
  if (input.anchor.repoSlug !== input.repoSlug) return 'unbound'
  const remoteNewer = input.remoteHeadVersionNo > input.anchor.baselineSeq
  if (input.localChanged === null) return remoteNewer ? 'conflict' : 'local-ahead'
  if (input.localChanged && remoteNewer) return 'conflict'
  if (input.localChanged) return 'local-ahead'
  if (remoteNewer) return 'remote-ahead'
  return 'clean'
}

/** 锚点是否绑定了别的仓库（UI 据此给「改绑」显式文案与确认，而不是当成普通未绑定）。 */
export function isForeignAnchor(anchor: CloudBagAnchor | null, repoSlug: string): boolean {
  return anchor !== null && anchor.repoSlug !== repoSlug
}

/** 社区网页端仓库深链（纯逻辑，放这里以避免 CloudBagPanel ↔ CloudBagRepoView 循环 import） */
export function repoDeepLink(endpoint: string, slug: string): string {
  try {
    return `${new URL(endpoint).origin}/community/repos/${encodeURIComponent(slug)}`
  } catch {
    return `/community/repos/${encodeURIComponent(slug)}`
  }
}

/** 离线/未登录/未验证的门控：写动作与状态不可互相误导（桌面契约 §5） */
export interface CloudBagGate {
  canBrowse: boolean
  canWrite: boolean
  /** 需要展示的状态说明（null = 正常在线已验证） */
  notice: string | null
}

export type CommunityGateStatus = 'checking' | 'signed_out' | 'signed_in' | 'loading' | 'error' | 'offline'

export interface GateUser {
  email?: string
  email_verified?: boolean
  status?: number
}

export function cloudBagGate(status: CommunityGateStatus, user: GateUser | null): CloudBagGate {
  if (status === 'offline') {
    return { canBrowse: false, canWrite: false, notice: '当前处于离线模式，云书包需要连接社区服务器后使用。' }
  }
  // 非 signed_in 状态必须各自如实回文案（桌面契约 §8:245：网络层失败单独文案），
  // 不得把认证失败/检查中/加载中都折叠成「登录社区账号后…」——那会把网络故障
  // 误导成「只是没登录」，用户反复登录也解决不了。
  if (status === 'error') {
    return { canBrowse: false, canWrite: false, notice: '连接社区服务器失败，请检查网络或社区服务器地址后重试。' }
  }
  if (status === 'checking' || status === 'loading') {
    return { canBrowse: false, canWrite: false, notice: '正在检查社区登录状态，请稍候…' }
  }
  if (status !== 'signed_in') {
    return { canBrowse: false, canWrite: false, notice: '登录社区账号后可使用云书包管理你的模组仓库。' }
  }
  const verified = user?.status === 1 && Boolean(user.email?.trim()) && user.email_verified === true
  if (!verified) {
    return { canBrowse: true, canWrite: false, notice: '请先完成邮箱认证后再使用云书包上传或同步。' }
  }
  return { canBrowse: true, canWrite: true, notice: null }
}

/** 上传用安全文件名：multipart 名不含路径分隔符（IPC 侧还有同名二次校验） */
export function safeUploadFileName(path: string): string {
  const name = path.split('/').pop() ?? 'file'
  const cleaned = name.replace(/[\\/\0\r\n]/g, '_').slice(0, 180)
  return cleaned || 'file'
}

/** 幂等 client_op_id（推送/回滚共用，重放不产生第二次 versions 调用） */
export function newClientOpId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID().replace(/-/g, '')
  return `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/** 字节数人性化显示 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
