/**
 * 云书包版本恢复（拉取覆盖 / 冲突「放弃本地改动」出口的唯一主进程写路径）：
 * 把服务端按版本树打包的 .rwmod 安全恢复进**已登记**的项目根。
 * 防护复用 importModBuffer 两段式纪律（桌面契约 §6.4）：
 * 1. 全量校验（zip-slip / 条目数 / 单文件与总量上限 / 设备名 / .ohmytx 锚点保护）后才写盘；
 * 2. 覆盖前把将被替换的本地文件先备份到 .ohmytx/backup/<versionNo>/（同版本重复拉取
 *    时改用 <versionNo>-<时间戳> 唯一目录，绝不覆盖上一次备份的用户原始内容）；
 * 3. 写盘完成后把 zip 外的本地「可表示」多余文件**移入**备份（覆盖语义 = 本地树等价
 *    远端树，远端已删的文件不能残留在本地——锚点目录 .ohmytx 与噪声排除清单一律除外）；
 *    云书包本来就无法表示的文件（白名单外扩展名/超 50MiB/非 UTF-8 文本）留在本地，
 *    与上传侧的处置同口径（见 listLocalFiles 注释）。
 * 4. 任一步失败按备份回滚（恢复被覆盖/被移走的文件、删除新建文件），不留半套树。
 * 本模块不发起任何网络请求——.rwmod 字节由渲染层经社区代理下载后传入。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { assertNoLinkEscape, isPathInside, normalizePath, realRootOf } from './paths'
import { isDangerousExcluded, isExcluded } from './modScan'
import { CLOUD_BAG_MAX_UPLOAD_BYTES, isCloudBagTextPath, isCloudBagTreePath } from './cloudbagTree'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

const MAX_ENTRIES = 20000
const MAX_TOTAL = 512 * 1024 * 1024
const MAX_SINGLE = 128 * 1024 * 1024
const MAX_RWMOD_BYTES = 50 * 1024 * 1024
/** 锚点目录：同步状态与备份都在这里，恢复操作绝不覆盖（打锚点纪律见 modScan.ts） */
const ANCHOR_DIR = '.ohmytx'
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export interface RestoreResult {
  written: number
  backedUp: number
  /** 本地存在但 zip 外的多余文件数（已移入备份，等效删除） */
  removed: number
  /** 被移入备份的多余文件清单（相对项目根的 posix 路径，与 removed 同长）——
   * UI 逐条回显真实文件名，而不是只给一个数字让用户自己去备份目录翻 */
  movedList: string[]
  /** 被保护跳过的条目（.ohmytx 锚点目录内，或 dist/out/*.tmp 等噪声排除清单命中） */
  skipped: string[]
  /** 本次备份落地目录（相对项目根的 posix 路径）——重复拉取同一版本号时不会覆盖旧备份 */
  backupDir: string
}

interface ZipEntry {
  rel: string
  content: Buffer
}

/** 目标路径是否位于受限根内（含根本身）。所有动态路径进入 fs 前都必须先过这一关。 */
function withinRoot(base: string, target: string): boolean {
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  return target === base || target.startsWith(prefix)
}

/**
 * 把 posix 相对路径解析到受限根内的绝对路径（所有写盘路径的唯一入口）。
 * 解析后强制边界断言：越出 base 或等于 base 本身一律拒绝（zip-slip 兜底防线）。
 */
function resolveInside(base: string, rel: string): string {
  const resolvedBase = path.resolve(base)
  const target = path.resolve(resolvedBase, rel)
  // 显式边界断言（zip-slip 兜底防线）：relative 为空 = 落在根自身，以 .. 开头或为绝对路径 = 越出根，
  // 两者一律拒绝。写成 path.relative 惯用式而非前缀比较，是为了让边界校验对静态扫描显式可见。
  const relative = path.relative(resolvedBase, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`导入包内包含非法路径：${rel}（已中止恢复）`)
  }
  return target
}

/** 解压前的中央目录预检：JSZip 私有字段，缺失时回退到流式计数（纵深防御，不是唯一防线） */
function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const raw = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

/**
 * 条目是否落在锚点目录（.ohmytx）内。目标平台 NTFS 大小写不敏感，
 * 判定必须同样不区分大小写，否则 `.OHMYTX/cloud.json` 会绕过保护写穿真实锚点。
 */
export function isAnchorPath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').toLowerCase()
  const first = normalized.split('/')[0] ?? normalized
  return first === ANCHOR_DIR
}

/**
 * 锚点目录的真实路径守卫：zip 条目不得经项目内的链接/junction 落进 .ohmytx。
 * 词法前缀在大小写不敏感文件系统上不足以保护锚点，这里用「最近存在祖先的 realpath」
 * 与 realRoot/.ohmytx 比对（isPathInside 在 win32 下大小写不敏感）。
 */
async function assertOutsideAnchor(root: string, abs: string): Promise<void> {
  const realAnchor = path.join(await realRootOf(root), ANCHOR_DIR)
  let cursor = abs
  for (;;) {
    try {
      const real = await fs.realpath(cursor)
      if (isPathInside(realAnchor, real)) {
        throw new Error(`导入包内含锚点目录条目：${path.relative(root, abs)}（已中止恢复）`)
      }
      return
    } catch (err) {
      if (err instanceof Error && err.message.includes('锚点目录条目')) throw err
      const parent = path.dirname(cursor)
      if (parent === cursor) return
      cursor = parent
    }
  }
}

/**
 * 流式解压单个条目：边解压边计数，超过单文件/剩余总量上限立即 destroy 中止，
 * 避免高压缩比条目在「解压完再判大小」之前撑爆主进程内存（zip bomb）。
 */
async function readEntryLimited(entry: JSZip.JSZipObject, rel: string, remainingTotal: number): Promise<Buffer> {
  const declared = declaredUncompressedSize(entry)
  if (declared !== null && declared > MAX_SINGLE) throw new Error(`导入包内文件过大：${rel}（超过 128MB，已中止恢复）`)
  if (declared !== null && declared > remainingTotal) throw new Error('导入包解压后总大小超过 512MB，已中止恢复')
  const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy: () => void }
  const chunks: Buffer[] = []
  let total = 0
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(error)
    }
    stream.on('data', (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array)
      total += buf.byteLength
      if (total > MAX_SINGLE) {
        fail(new Error(`导入包内文件过大：${rel}（超过 128MB，已中止恢复）`))
        return
      }
      if (total > remainingTotal) {
        fail(new Error('导入包解压后总大小超过 512MB，已中止恢复'))
        return
      }
      chunks.push(buf)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve()
    })
    stream.on('error', (error: Error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
  return Buffer.concat(chunks)
}

/** 解包校验：只校验与过滤，不写盘（两段式第一段）。返回按 posix 相对路径排序的条目。 */
export async function validateZipEntries(rwmodBuffer: Buffer): Promise<{ entries: ZipEntry[]; skipped: string[] }> {
  const zip = await JSZip.loadAsync(rwmodBuffer)
  const raw = Object.values(zip.files).filter((entry) => !entry.dir)
  if (raw.length > MAX_ENTRIES) throw new Error('导入包内文件过多（超过 20000 个），已中止恢复')
  const entries: ZipEntry[] = []
  const skipped: string[] = []
  let total = 0
  for (const entry of raw) {
    const rel = entry.name.replace(/\\/g, '/').trim()
    if (!rel || rel === '.') continue
    const fileName = rel.split('/').pop() ?? rel
    if (DEVICE_NAME_RE.test(fileName)) throw new Error(`导入包内包含系统保留文件名：${rel}（已中止恢复）`)
    if (rel.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error(`导入包内包含非法路径：${rel}（已中止恢复）`)
    }
    if (/^[A-Za-z]:/.test(rel)) {
      throw new Error(`导入包内包含盘符路径：${rel}（已中止恢复）`)
    }
    // 锚点目录保护（大小写不敏感）：服务端导出按打包排除规则不会含 .ohmytx，
    // 防御性双保险；`.OHMYTX/cloud.json` 一类大小写变体同样按「跳过」处理。
    if (isAnchorPath(rel)) {
      skipped.push(rel)
      continue
    }
    // 确定性危险目录（.git/.svn/.hg/node_modules）：包内出现即中止整次恢复，绝不写进项目根。
    // 用整条相对路径判定（任意深度命中即拒）且大小写不敏感——`.GIT/hooks/pre-commit`、
    // `assets/node_modules/x.js` 都不得写盘。
    if (isDangerousExcluded(rel)) {
      throw new Error(`导入包内包含危险目录条目：${rel}（已中止恢复）`)
    }
    // 其余噪声条目（dist/out/.vite/*.tmp/Thumbs.db 等）：服务端只跳过 .ohmytx，其他客户端
    // 完全可能合法提交含这些段的版本。此处改为「跳过该条目并上报」，而不是整次中止——
    // 否则这类版本在桌面端永久无法拉取（无任何绕过出口）。跳过的条目也不写盘，
    // listLocalFiles 同样不统计它们，因此本地同名文件不会被当成「多余文件」移走。
    if (isExcluded(rel)) {
      skipped.push(rel)
      continue
    }
    // 会真正写盘的条目才做「路径段级非法字符」检查（与 electron/fsIpc.ts 的 assertValidName
    // 同口径）：`units/tank.ini:evil` 这类条目 resolveInside 仍在根内、设备名/危险目录判定
    // 也都放行，但在 NTFS 上会落成 `tank.ini` 的备用数据流（ADS）——写出的内容不可见、
    // readdir 看不到，直接击穿「本地树等价远端树」的不变式与备份计数。
    // `< > " | ? *` 与尾点/尾空格同理是 Win32 的别名/裁剪面，一并拒绝。
    // 放在跳过分支之后：被跳过的噪声/锚点条目本来就不写盘，不该因此中止整次恢复。
    for (const segment of rel.split('/')) {
      // eslint-disable-next-line no-control-regex -- 控制字符在路径里不可见且易被滥用
      if (/[<>:"|?*\x00-\x1f]/.test(segment)) {
        throw new Error(`导入包内路径段包含非法字符：${rel}（已中止恢复）`)
      }
      if (/[. ]$/.test(segment)) {
        throw new Error(`导入包内路径段以点或空格结尾：${rel}（已中止恢复）`)
      }
    }
    const content = await readEntryLimited(entry, rel, MAX_TOTAL - total)
    total += content.byteLength
    if (total > MAX_TOTAL) throw new Error('导入包解压后总大小超过 512MB，已中止恢复')
    entries.push({ rel, content })
  }
  return { entries, skipped }
}

/** 文本类文件的 UTF-8 校验：与渲染层 readLocalFileBytes 的「重编码字节数必须等于原文件
 * 大小」同效——非法字节在 fatal 解码下直接抛错（GBK/ANSI 文本属此类）。 */
function isValidUtf8Text(bytes: Buffer): boolean {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes)
    return true
  } catch {
    return false
  }
}

/** 读一个已通过根边界断言的路径（唯一入口是 resolveInside）；失败按「不可表示」处理 */
async function statInsideRoot(root: string, rel: string): Promise<{ size: number } | null> {
  const target = resolveInside(root, rel)
  return fs.stat(target).then((stat) => (stat.isFile() ? { size: stat.size } : null)).catch(() => null)
}

/** 读一个已通过根边界断言的文本文件；读取失败返回 null（同样按「不可表示」处理） */
async function readTextInsideRoot(root: string, rel: string): Promise<Buffer | null> {
  const target = resolveInside(root, rel)
  return fs.readFile(target).catch(() => null)
}

/** 单个本地文件是否属于「云书包可表示集合」：白名单扩展名 + 合法路径 + ≤50MiB +
 * 文本类必须是合法 UTF-8。与上传侧 buildLocalFilePlan / readLocalFileBytes 的口径一致。 */
async function isRepresentableLocalFile(root: string, rel: string): Promise<boolean> {
  if (!isCloudBagTreePath(rel)) return false
  const stat = await statInsideRoot(root, rel)
  if (!stat || stat.size > CLOUD_BAG_MAX_UPLOAD_BYTES) return false
  if (!isCloudBagTextPath(rel)) return true
  const bytes = await readTextInsideRoot(root, rel)
  return bytes !== null && isValidUtf8Text(bytes)
}

/**
 * 递归列出项目根下「本次覆盖语义会移走」的本地文件（排除打包排除清单与符号链接；
 * posix 相对路径）。
 *
 * 只纳入云书包**可表示**的文件（见 isRepresentableLocalFile）：云书包根本无法表示的
 * 本地文件（.gitignore/README.md/*.json/*.zip/*.rwmod 产物/超 50MiB 素材/GBK 文本）
 * 不会出现在远端树里，也绝不能被当成「远端已删」而从工作树移走——上传侧对这些文件的
 * 处置是「留在本地并如实上报」，拉取侧必须同口径，否则用户会看到项目文件凭空消失。
 */
async function listLocalFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (!withinRoot(root, dir)) return
    const children = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of children) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isExcluded(rel)) continue
      if (entry.isSymbolicLink()) continue
      const abs = path.resolve(dir, entry.name)
      if (!withinRoot(root, abs)) continue
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (entry.isFile() && await isRepresentableLocalFile(root, rel)) out.push(rel)
    }
  }
  await walk(root, '')
  return out
}

/** 建目录并记录本次新建的层级（回滚时自底向上清理空目录） */
async function ensureDirTracked(root: string, dir: string, createdDirs: string[]): Promise<void> {
  if (!withinRoot(root, dir)) throw new Error('目标目录越出项目根，已中止恢复')
  const missing: string[] = []
  let cursor = dir
  while (cursor !== root && withinRoot(root, cursor)) {
    if (await exists(cursor)) break
    missing.push(cursor)
    cursor = path.dirname(cursor)
  }
  await fs.mkdir(dir, { recursive: true })
  createdDirs.push(...missing)
}

/**
 * 本次恢复的备份目录：`backup/<versionNo>/`，若已存在（同一版本重复拉取）则改用
 * `backup/<versionNo>-<时间戳>[-n]/` 唯一目录。备份绝不覆盖既有备份——第一次拉取
 * 后该位置已变成「远端内容」，再写会把用户的本地原始改动永久覆盖掉。
 * 返回 { dir, name }（name 为相对 backupRoot 的目录名）。
 */
async function resolveBackupDir(backupRoot: string, versionNo: number): Promise<{ dir: string; name: string }> {
  const primary = resolveInside(backupRoot, String(versionNo))
  if (!(await exists(primary))) return { dir: primary, name: String(versionNo) }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = `${versionNo}-${stamp}${attempt ? `-${attempt}` : ''}`
    const candidate = resolveInside(backupRoot, name)
    if (!(await exists(candidate))) return { dir: candidate, name }
  }
  throw new Error('备份目录无法创建（同名备份过多），已中止恢复')
}

/** 恢复 .rwmod 到项目根（覆盖语义：备份被覆盖文件，失败回滚） */
export async function restoreRwmod(rwmodBuffer: Buffer, projectRoot: string, versionNo: number): Promise<RestoreResult> {
  if (!Number.isInteger(versionNo) || versionNo <= 0) throw new Error('版本号无效')
  if (!(rwmodBuffer instanceof Buffer) || rwmodBuffer.byteLength === 0 || rwmodBuffer.byteLength > MAX_RWMOD_BYTES) {
    throw new Error('模组包无效或超过 50 MiB 限制')
  }
  const root = path.resolve(projectRoot)
  if (normalizePath(root) !== normalizePath(projectRoot)) throw new Error('项目目录无效')

  const { entries, skipped } = await validateZipEntries(rwmodBuffer)
  // 空 zip（合法但无文件条目）会把整个工作树「等效删除」进备份：直接拒绝，防御落在主进程。
  if (entries.length === 0) throw new Error('模组包内没有文件条目，已中止恢复')
  const backupRoot = path.join(root, ANCHOR_DIR, 'backup')
  // 备份目录自身不得经链接逃逸（项目根的 .ohmytx 是指向根外的 junction 时，
  // 备份会写到项目之外且 listLocalFiles 发现不了）——写任何备份前先校验。
  await assertNoLinkEscape(root, backupRoot)
  const { dir: backupDir, name: backupName } = await resolveBackupDir(backupRoot, versionNo)
  // 第一步：链接逃逸/锚点守卫 + 备份将被覆盖的既有文件（copy 语义，原文件暂不删除）
  const backups: Array<{ rel: string; abs: string }> = []
  for (const entry of entries) {
    const abs = resolveInside(root, entry.rel)
    // 根内链接指向根外时写盘会写穿：逐条目校验（与打包的 assertNoLinkEscape 纪律一致）
    await assertNoLinkEscape(root, abs)
    // 项目内链接/junction 落进锚点目录：词法校验看不出来，用 realpath 拦下（大小写变体兜底）
    await assertOutsideAnchor(root, abs)
    if (await exists(abs)) {
      const backupAbs = resolveInside(backupDir, entry.rel)
      await fs.mkdir(path.dirname(backupAbs), { recursive: true })
      await fs.copyFile(abs, backupAbs)
      backups.push({ rel: entry.rel, abs: backupAbs })
    }
  }

  // 第二步：写盘；第三步：把 zip 外的本地多余文件移入备份（覆盖语义 = 本地树等价远端树）
  const written: string[] = []
  const attempts: string[] = []
  const moved: Array<{ rel: string; abs: string }> = []
  const createdDirs: string[] = []
  try {
    for (const entry of entries) {
      const abs = resolveInside(root, entry.rel)
      await ensureDirTracked(root, path.dirname(abs), createdDirs)
      // 失败的文件也纳入回滚（writeFile 可能已截断/建出半成品）
      attempts.push(abs)
      await fs.writeFile(abs, entry.content)
      written.push(abs)
    }
    const entrySet = new Set(entries.map((entry) => entry.rel))
    for (const rel of await listLocalFiles(root)) {
      if (entrySet.has(rel)) continue
      const abs = resolveInside(root, rel)
      const backupAbs = resolveInside(backupDir, rel)
      await fs.mkdir(path.dirname(backupAbs), { recursive: true })
      await fs.rename(abs, backupAbs)
      moved.push({ rel, abs: backupAbs })
    }
  } catch (err) {
    // 回滚：先移回被移走的文件，再删除本次写入（含失败中的那个），最后还原被覆盖文件
    for (const item of [...moved].reverse()) {
      const original = resolveInside(root, item.rel)
      await fs.mkdir(path.dirname(original), { recursive: true }).catch(() => undefined)
      await fs.rename(item.abs, original).catch(() => undefined)
    }
    for (const abs of attempts) await fs.rm(abs, { force: true }).catch(() => undefined)
    for (const backup of backups) {
      const original = resolveInside(root, backup.rel)
      await fs.mkdir(path.dirname(original), { recursive: true }).catch(() => undefined)
      await fs.copyFile(backup.abs, original).catch(() => undefined)
    }
    // 自底向上清理本次新建的空目录（rmdir 对非空目录失败，天然安全）
    for (const dir of [...new Set(createdDirs)].sort((a, b) => b.length - a.length)) {
      if (!withinRoot(root, dir) || dir === root) continue
      await fs.rmdir(dir).catch(() => undefined)
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
  return {
    written: written.length,
    backedUp: backups.length,
    removed: moved.length,
    movedList: moved.map((item) => item.rel),
    skipped,
    backupDir: path.posix.join(ANCHOR_DIR, 'backup', backupName),
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** IPC 注册：cloudbag:restore —— 只对已登记项目根生效（写盘边界与 fs 域一致） */
export function registerCloudbagIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('cloudbag:restore', async (_event, rootPath: unknown, rwmodBytes: unknown, versionNo: unknown): Promise<RestoreResult> => {
    if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('项目目录为空')
    const normalized = normalizePath(rootPath)
    if (!ctx.roots.has(normalized)) throw new Error('未登记的项目目录')
    if (!(rwmodBytes instanceof ArrayBuffer)) throw new Error('模组包数据无效')
    if (typeof versionNo !== 'number') throw new Error('版本号无效')
    return restoreRwmod(Buffer.from(rwmodBytes), rootPath, versionNo)
  })
}
