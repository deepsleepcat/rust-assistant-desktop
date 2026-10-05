/**
 * 云书包本地树状态（渲染层；桥/API 注入，可单测）：
 * 1) 本地可上传候选的扫描 + sha256 清单：与 pushLocalTree 第一趟**同一函数**（白名单路径 /
 *    ≤50MiB / 合法 UTF-8，图片音频走专用读器），分流口径也与推送逐条一致；
 * 2) 规范树摘要：本地树与服务端版本树用同一函数计算。旧实现用 git status 冒充
 *    「相对锚点基线的改动」，而发布/拉取根本不改 git——任何有未提交文件的项目在每次
 *    成功同步后都会假报「本地有未发布修改」；摘要比较才是与基线树真正同口径的判据；
 * 3) 基线解析：锚点自带 digest 直接用于比较；旧锚点（digest 为空）从服务端基线版本树
 *    获取，按本地候选宇宙归一后计算 digest 并回写迁移（不回退 git 的长期假报）；
 * 4) 本地树 ↔ 基线树逐文件差异（冲突 A 栏数据源）。
 * 纪律：只有「会被提交的候选」参与比较——发布第二趟跳过/失败的文件不在提交树里，
 * 本地再次扫描仍能看到它，因此会如实显示为未同步差异，绝不当作已同步。
 */
import type { BridgeApi } from '../types/bridge'
import type { CloudBagApi } from './cloudBagApi'
import {
  buildLocalFilePlan,
  classifyLocalFile,
  cloudBagPathKey,
  type CloudBagAnchor,
  type LocalFilePlanInput,
} from '../features/community/cloudBagData'
import { joinProjectPath } from '../utils/projectPath'

/** 树内文件（路径 + sha256）：本地候选 / 服务端版本树 / 锚点基线统一形状 */
export interface LocalTreeEntry {
  path: string
  sha256: string
}

export interface LocalTreeScan {
  entries: LocalTreeEntry[]
  /** entries 的规范摘要（与 treeDigestOf 同口径，可直接与锚点 baselineTreeDigest 比较） */
  digest: string
  skippedBinary: string[]
  oversized: string[]
  unsupported: string[]
}

export interface TreeScanProgress {
  phase: 'hashing'
  done: number
  total: number
  currentPath?: string
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function dataUrlToBytes(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** 读取单个本地文件为字节；二进制类（tsbin 等，本轮无读取通道）抛错由调用方计入跳过 */
export async function readLocalFileBytes(bridge: BridgeApi, rootPath: string, relPath: string): Promise<ArrayBuffer> {
  const kind = classifyLocalFile(relPath)
  const abs = joinProjectPath(rootPath, relPath)
  if (kind === 'text') {
    // 必须从**原始字节**出发：fs:readFile 是非严格 UTF-8 解码，非法序列会折叠成
    // U+FFFD 且重编码后可能与原字节等长（41 F0 9F 98 4 字节 → 41 EF BF BD 4 字节），
    // 旧「重编码字节数 == stat.size」检查会漏掉这种静默改写（上传的就是改写后的字节）。
    if (typeof bridge.project.readFileBytes !== 'function') {
      throw new Error('当前桌面版缺少原始字节读取通道（fs:readFileBytes），请重启应用后再同步')
    }
    const { bytes } = await bridge.project.readFileBytes(rootPath, abs)
    // 严格校验原始字节是否为合法 UTF-8：合法编码的 U+FFFD（EF BF BD，真实的
    // replacement 字符）fatal 解码同样通过，不能误杀；只有非法字节序列才跳过。
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('不是 UTF-8 编码（GBK/ANSI 或含非法字节），按文字上传会改写内容，已跳过')
    }
    // BOM 按磁盘原样保留（原始字节直传，无需再拼回）
    return bytes
  }
  if (kind === 'image') {
    return dataUrlToBytes(await bridge.project.readImageAsDataUrl(rootPath, abs))
  }
  if (kind === 'audio') {
    return dataUrlToBytes(await bridge.project.readAudioAsDataUrl(rootPath, abs))
  }
  throw new Error(`暂不支持读取的二进制文件类型：${relPath}`)
}

/**
 * 扫描本地可上传候选并计算 sha256（与 pushLocalTree 第一趟同一口径）。
 * 返回 null = 已取消（不是失败；失败会抛错，由调用方按自身语义上报）。
 * onProgress 的 total 为候选总数（白名单内且未超限），done 为已处理数。
 */
export async function scanLocalTree(
  bridge: BridgeApi,
  rootPath: string,
  options: { onProgress?: (progress: TreeScanProgress) => void; isCancelled?: () => boolean } = {},
): Promise<LocalTreeScan | null> {
  const { onProgress, isCancelled = () => false } = options
  const scan = await bridge.mod.scanResources(rootPath)
  // 全量进清单：白名单外但被分类为 text/image/audio 的文件（.json/.md 等）此前被
  // 过滤掉，既不上传也不进「跳过」报告——用户看到「已发布 N 个文件」却不知道
  // 这些文件根本没进云端。现在统一由 buildLocalFilePlan 分流（unsupported /
  // oversized / uploadable），再按分类拆成「类型不支持」与「已跳过」两组如实上报。
  const withSizes = await Promise.all(scan.files.map(async (rel) => {
    try {
      const st = await bridge.project.stat(rootPath, joinProjectPath(rootPath, rel))
      return { path: rel, size: st.size }
    } catch {
      return { path: rel, size: 0 }
    }
  }))
  const plan = buildLocalFilePlan(withSizes as LocalFilePlanInput[])
  const skippedBinary: string[] = []
  const oversized: string[] = plan.oversized.map((file) => file.path)
  const unsupported: string[] = []
  plan.unsupported.forEach((file) => {
    if (classifyLocalFile(file.path) === 'binary') skippedBinary.push(file.path)
    else unsupported.push(file.path)
  })

  onProgress?.({ phase: 'hashing', done: 0, total: plan.uploadable.length })
  const entries: LocalTreeEntry[] = []
  for (let index = 0; index < plan.uploadable.length; index++) {
    if (isCancelled()) return null
    const file = plan.uploadable[index]
    try {
      const bytes = await readLocalFileBytes(bridge, rootPath, file.path)
      if (bytes.byteLength > 50 * 1024 * 1024) oversized.push(file.path)
      else entries.push({ path: file.path, sha256: await sha256Hex(bytes) })
    } catch (err) {
      skippedBinary.push(`${file.path}（${err instanceof Error ? err.message : String(err)}）`)
    }
    onProgress?.({ phase: 'hashing', done: index + 1, total: plan.uploadable.length, currentPath: file.path })
  }
  return { entries, digest: await treeDigestOf(entries), skippedBinary, oversized, unsupported }
}

/**
 * 规范树摘要：条目按路径键（cloudBagPathKey，与上传/后端同口径，大小写不敏感）排序，
 * sha256 统一小写，拼接后再 SHA-256。本地树与服务端树必须用本函数，摘要才可比。
 */
export async function treeDigestOf(entries: ReadonlyArray<LocalTreeEntry>): Promise<string> {
  const canonical = entries
    .map((entry) => `${cloudBagPathKey(entry.path)}\u0000${entry.sha256.trim().toLowerCase()}`)
    .sort()
    .join('\u0001')
  return sha256Hex(new TextEncoder().encode(canonical))
}

export type BaselineDiffStatus = 'A' | 'M' | 'D'
export interface BaselineDiffRow {
  status: BaselineDiffStatus
  path: string
}

/** 本地树 ↔ 基线树逐文件差异（纯函数）：本地多=A，内容不同=M，基线多=本地已删=D。 */
export function diffTreeManifests(
  local: ReadonlyArray<LocalTreeEntry>,
  baseline: ReadonlyArray<LocalTreeEntry>,
): BaselineDiffRow[] {
  const localByKey = new Map(local.map((entry) => [cloudBagPathKey(entry.path), entry]))
  const baselineByKey = new Map(baseline.map((entry) => [cloudBagPathKey(entry.path), entry]))
  const rows: BaselineDiffRow[] = []
  for (const [key, entry] of localByKey) {
    const base = baselineByKey.get(key)
    if (!base) rows.push({ status: 'A', path: entry.path })
    else if (base.sha256.trim().toLowerCase() !== entry.sha256.trim().toLowerCase()) rows.push({ status: 'M', path: entry.path })
  }
  for (const [key, entry] of baselineByKey) {
    if (!localByKey.has(key)) rows.push({ status: 'D', path: entry.path })
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const TREE_PAGE_LIMIT = 500
/** 页数上限（500×100 = 5 万条）：服务端 nextCursor 异常重复时不死循环 */
const TREE_MAX_PAGES = 100

/** 服务端版本树清单（游标分页取全量）。返回 null = 取消或请求失败（调用方按不可用处理）。 */
export async function fetchVersionTreeEntries(
  api: CloudBagApi,
  repoSlug: string,
  versionNo: number,
  options: { isCancelled?: () => boolean } = {},
): Promise<LocalTreeEntry[] | null> {
  const { isCancelled = () => false } = options
  const entries: LocalTreeEntry[] = []
  let cursor: string | null = null
  try {
    for (let page = 0; page < TREE_MAX_PAGES; page++) {
      if (isCancelled()) return null
      const result = await api.tree(repoSlug, versionNo, cursor ?? undefined, TREE_PAGE_LIMIT)
      if (isCancelled()) return null
      for (const item of result.items ?? []) {
        if (item && typeof item.path === 'string' && item.path && typeof item.sha256 === 'string' && item.sha256) {
          entries.push({ path: item.path, sha256: item.sha256 })
        }
      }
      cursor = result.nextCursor ?? null
      if (!cursor) break
    }
  } catch {
    return null
  }
  return entries
}

/**
 * 服务端基线树归一：服务端树里「本地存在但不在本地候选清单」的条目（噪声目录等被主进程
 * 扫描排除，拉取恢复同样不写盘）不属于同步宇宙，不能当成「本地删除」；本地不存在的
 * 服务端条目才是真实删除。返回的条目可直接与本地候选清单做 per-file diff / 摘要比较。
 */
export async function normalizeServerEntries(input: {
  bridge: BridgeApi
  rootPath: string
  serverEntries: ReadonlyArray<LocalTreeEntry>
  localEntries: ReadonlyArray<LocalTreeEntry>
  isCancelled?: () => boolean
}): Promise<LocalTreeEntry[]> {
  const { bridge, rootPath, serverEntries, localEntries, isCancelled = () => false } = input
  const localKeys = new Set(localEntries.map((entry) => cloudBagPathKey(entry.path)))
  const out: LocalTreeEntry[] = []
  for (const entry of serverEntries) {
    if (localKeys.has(cloudBagPathKey(entry.path))) {
      out.push(entry)
      continue
    }
    if (isCancelled()) return out
    const exists = await bridge.project.stat(rootPath, joinProjectPath(rootPath, entry.path)).then(() => true, () => false)
    if (!exists) out.push(entry)
  }
  return out
}

export interface BaselineResolution {
  /** 可直接与本地树摘要比较的基线摘要 */
  digest: string
  /** 逐文件差异需要的服务端基线清单（锚点自带摘要时为 null，按需再取） */
  entries: LocalTreeEntry[] | null
  source: 'anchor' | 'server'
  /** 旧锚点（digest 为空）从服务端版本树补齐得到的摘要：调用方应尽力写回锚点 */
  migratedDigest?: string
}

/**
 * 解析锚点基线：自带 digest → 直接比较（离线可用）；旧锚点空 digest → 取服务端基线版本树，
 * 按本地候选宇宙归一后计算 digest（同时作为迁移值回写）。返回 null = 取消或基线不可得
 * （网络失败），调用方按「无法确认」保守处理，绝不退回 git 的长期假报。
 */
export async function resolveBaselineTree(input: {
  anchor: CloudBagAnchor
  api: CloudBagApi
  bridge: BridgeApi
  rootPath: string
  repoSlug: string
  localEntries: ReadonlyArray<LocalTreeEntry>
  isCancelled?: () => boolean
}): Promise<BaselineResolution | null> {
  const { anchor, api, bridge, rootPath, repoSlug, localEntries, isCancelled } = input
  if (anchor.repoSlug !== repoSlug) return null
  const stored = anchor.baselineTreeDigest.trim()
  if (stored) return { digest: stored, entries: null, source: 'anchor' }
  const serverEntries = await fetchVersionTreeEntries(api, repoSlug, anchor.baselineSeq, { isCancelled })
  if (!serverEntries || isCancelled?.()) return null
  const entries = await normalizeServerEntries({ bridge, rootPath, serverEntries, localEntries, isCancelled })
  if (isCancelled?.()) return null
  const digest = await treeDigestOf(entries)
  return { digest, entries, source: 'server', migratedDigest: digest }
}

/** 按需取服务端基线清单（冲突 A 栏逐文件差异；digest 可直接比较时不取，省一次网络）。 */
export async function loadBaselineEntries(input: {
  api: CloudBagApi
  bridge: BridgeApi
  rootPath: string
  repoSlug: string
  versionNo: number
  localEntries: ReadonlyArray<LocalTreeEntry>
  isCancelled?: () => boolean
}): Promise<LocalTreeEntry[] | null> {
  const { api, bridge, rootPath, repoSlug, versionNo, localEntries, isCancelled } = input
  const serverEntries = await fetchVersionTreeEntries(api, repoSlug, versionNo, { isCancelled })
  if (!serverEntries || isCancelled?.()) return null
  const entries = await normalizeServerEntries({ bridge, rootPath, serverEntries, localEntries, isCancelled })
  return isCancelled?.() ? null : entries
}
