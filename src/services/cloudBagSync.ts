/**
 * 云书包手动同步编排（渲染层；不新增任何网络通道——HTTP 一律走 cloudBagApi，
 * 本地文件一律走既有项目桥，写盘恢复走 cloudbag:restore 主进程受限通道）。
 * 设计：bridge/api 全部注入，Vitest 用假桥验证完整业务流（上传请求形状、
 * 冲突分支、取消、跳过二进制、锚点写入）。
 */
import type { BridgeApi } from '../types/bridge'
import type { CloudBagApi, CloudBagApiError, CloudBagHeadSummary, CloudBagRepo, CreateCloudBagRepoInput } from './cloudBagApi'
import {
  CLOUD_BAG_ANCHOR_PATH,
  newClientOpId,
  parseCloudBagAnchor,
  serializeCloudBagAnchor,
  safeUploadFileName,
  type CloudBagAnchor,
} from '../features/community/cloudBagData'
import { joinProjectPath } from '../utils/projectPath'
import {
  readLocalFileBytes,
  scanLocalTree,
  sha256Hex,
  treeDigestOf,
  type LocalTreeEntry,
} from './cloudBagTreeState'

export interface SyncProgress {
  phase: 'reading' | 'hashing' | 'uploading' | 'committing' | 'downloading' | 'restoring' | 'verifying' | 'done'
  /** 文件粒度进度（桌面契约 §6.1） */
  done: number
  total: number
  currentPath?: string
}

export interface PushOutcome {
  status: 'pushed' | 'conflict' | 'aborted' | 'failed'
  versionNo?: number
  conflict?: CloudBagHeadSummary | null
  error?: string
  /** 上传清单摘要（供 UI 展示差异/跳过原因） */
  uploaded: string[]
  skippedBinary: string[]
  oversized: string[]
  unsupported: string[]
  /** 本次**实际提交**的服务端树摘要（uploadedRefs 规范摘要，与锚点 baselineTreeDigest 同口径）。
   *  第二趟跳过/失败的文件不在其中——它们仍是未同步的本地变更，重开弹窗会如实报差异。 */
  treeDigest?: string
  /** 第一趟本地候选清单快照（冲突 A 栏「本地 vs 锚点基线」直接用这一趟，不重复哈希） */
  localTree?: LocalTreeEntry[]
}

export interface PullOutcome {
  status: 'pulled' | 'failed' | 'aborted'
  versionNo?: number
  written?: number
  backedUp?: number
  /** zip 外的本地多余文件数（已移入备份，等效删除；仅统计云书包可表示的文件） */
  removed?: number
  /** 被移入备份的多余文件清单（逐条回显，避免用户只看到一个数字而不知道哪些文件离开了工作树） */
  movedList?: string[]
  /** 服务端包内被本地策略跳过（未写盘）的条目：噪声目录（dist/out/*.tmp 等）与 .ohmytx 锚点 */
  skipped?: string[]
  /** 本次备份落地目录（相对项目根）；同一版本号重复拉取时不会覆盖旧备份，UI 需回显真实位置 */
  backupDir?: string
  /** 恢复后本地可上传候选树的规范摘要（与实际恢复树一致，写入锚点 baselineTreeDigest）。
   *  恢复后扫描/计算失败或取消时缺省——锚点留空，下次打开按旧锚点从服务端补齐。 */
  treeDigest?: string
  error?: string
}

export interface SyncHost {
  api: CloudBagApi
  bridge: BridgeApi
  rootPath: string
  repoSlug: string
  onProgress: (progress: SyncProgress) => void
  /** 取消标记：文件粒度协作式取消（IPC 发出后不可中断，发完当前文件即停） */
  isAborted: () => boolean
}

// sha256/读取/扫描统一在 cloudBagTreeState（push 与同步弹窗共用同一口径，见该模块注释）

/** 提交允许重试的 HTTP 状态白名单：仅网关/上游瞬态（502/503/504）。
 * 401/403/404/409 等确定性失败重发只会白耗请求（响应必然相同），绝不重试。 */
const RETRYABLE_COMMIT_HTTP_STATUS = new Set([502, 503, 504])

/** 可重试的版本提交：仅对网络失败（响应丢失，幂等键重放生效）与白名单内的
 * 网关瞬态 HTTP 状态重试，且复用同一 client_op_id（幂等重放）。
 * 业务错误（version_conflict / quota_exceeded / forbidden / 401/404 …）立即上抛，绝不重试。 */
async function commitVersionWithRetry(
  api: CloudBagApi,
  repoSlug: string,
  input: { baseVersionNo: number; message: string; clientOpId: string; files: Array<{ path: string; sha256: string }> },
): Promise<{ versionNo: number }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await api.pushVersion(repoSlug, input)
    } catch (err) {
      lastError = err
      const kind = (err as CloudBagApiError).kind
      // 只有「可能已到达服务端但响应丢失」的网络类失败，或网关瞬态（502/503/504）
      // 才值得重试：幂等键命中时服务端回放首次结果，不会产生第二个版本。
      // timeout 不重试：整包重发在慢上行链路上只是白耗带宽（重试前必须换新的时限判断）。
      if (kind !== 'network') {
        if (kind !== 'http' || !RETRYABLE_COMMIT_HTTP_STATUS.has((err as CloudBagApiError).status)) throw err
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 解析用：仅剥掉开头的 BOM（JSON.parse 不接受 U+FEFF），raw 本身保持原样。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 读取锚点快照：解析值 + 文件原始文本。原始文本用于条件写（CAS）的期望值——
 * 旧锚点迁移必须在「锚点内容仍是当时读到的这份」时才允许写回，否则会覆盖同期
 * push 已推进的基线（例如把 #3 覆盖回 #2）。
 * 必须走**原始字节**并用 ignoreBOM 解码：fs:readFile 会剥掉 BOM，而主进程 CAS
 * 用 fs.readFile(utf8) 比较的是保留 BOM 的字符串，两者口径不一致会让带 BOM 的
 * 锚点永远 CAS 失败；raw 保留 BOM，只有 parse 前才剥。
 */
export async function readCloudBagAnchorSnapshot(
  bridge: BridgeApi,
  rootPath: string,
): Promise<{ anchor: CloudBagAnchor | null; raw: string | null }> {
  try {
    const { bytes } = await bridge.project.readFileBytes(rootPath, joinProjectPath(rootPath, CLOUD_BAG_ANCHOR_PATH))
    // 非 fatal 解码 + ignoreBOM：与主进程 buf.toString('utf8') 同口径（保留 BOM/替换字符）
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    return { anchor: parseCloudBagAnchor(stripBom(raw)), raw }
  } catch {
    return { anchor: null, raw: null }
  }
}

/** 读取本地同步锚点（不存在/损坏返回 null） */
export async function readCloudBagAnchor(bridge: BridgeApi, rootPath: string): Promise<CloudBagAnchor | null> {
  return (await readCloudBagAnchorSnapshot(bridge, rootPath)).anchor
}

/** 成功提交/拉取后写回锚点（主进程已把 .ohmytx 排除出打包）。
 * 锚点父目录首次发布时可能不存在，而锚点通道的临时文件 rename 不建父目录 →
 * 必须先确保 .ohmytx 存在（已存在时 createFolder 报错属正常，忽略）。
 * 走 fs:writeAnchor 串行通道：与迁移的条件写共用队列，写之间不会互相插入。 */
export async function writeCloudBagAnchor(bridge: BridgeApi, rootPath: string, anchor: CloudBagAnchor): Promise<void> {
  await bridge.project.createFolder(rootPath, rootPath, '.ohmytx').catch(() => undefined)
  await bridge.project.writeAnchor(rootPath, joinProjectPath(rootPath, CLOUD_BAG_ANCHOR_PATH), serializeCloudBagAnchor(anchor), null)
}

/**
 * 旧锚点迁移的条件写：仅当锚点内容仍等于 expectedRaw 时才写入，返回是否真正写入。
 * CAS 在主进程串行队列内完成（读-比-写不可被并发锚点写打断）：同期 push 已把锚点
 * 推进到新版本时返回 false，调用方丢弃本次迁移，绝不用旧基线覆盖新基线。
 */
export async function migrateCloudBagAnchor(
  bridge: BridgeApi,
  rootPath: string,
  anchor: CloudBagAnchor,
  expectedRaw: string,
): Promise<boolean> {
  const result = await bridge.project.writeAnchor(rootPath, joinProjectPath(rootPath, CLOUD_BAG_ANCHOR_PATH), serializeCloudBagAnchor(anchor), expectedRaw)
  return result?.written === true
}

/** 本地相对锚点基线的改动清单（git status 口径，.ohmytx/** 自身产物已过滤）。
 * 返回 null = 无法检测（git 不可用，或不是 git 仓库）。主进程的 statusFiles 会把
 * git 失败吞成空数组，所以「status 为空」时必须再探测 .git 是否存在：非 git 项目
 * 一律按「无法检测」上报，由 judgeSyncState 落 local-ahead/conflict（保守不丢数据，
 * 绝不谎报 clean——否则非 git 项目永远无法发布第二个版本）。 */
export async function listLocalChanges(
  bridge: BridgeApi,
  rootPath: string,
): Promise<Array<{ status: string; path: string }> | null> {
  try {
    const status = await bridge.git.status(rootPath)
    if (status.length === 0) {
      // git status 空输出 ≠ 干净：非 git 仓库时主进程 runGit 失败被吞掉（.catch(()=>'')）。
      // .git 可能是目录（普通仓库）或文件（worktree/submodule），stat 两者都成立。
      const hasGit = await bridge.project
        .stat(rootPath, joinProjectPath(rootPath, '.git'))
        .then(() => true, () => false)
      if (!hasGit) return null
      // .git 存在但 status 为空：干净（git 二进制缺失的极端场景仍可能漏报，属已知 V1 降级）。
    }
    return status.filter((item) => !isCloudBagInternalPath(item.path))
  } catch {
    return null
  }
}

/** 本地相对锚点基线是否有变更：检测不了返回 null（未知 → UI 引导走冲突核对） */
export async function judgeLocalChanged(bridge: BridgeApi, rootPath: string): Promise<boolean | null> {
  const changes = await listLocalChanges(bridge, rootPath)
  return changes === null ? null : changes.length > 0
}

/** .ohmytx 目录（锚点 + 备份）内的路径：git status 与恢复语义都视为同步机制自身产物。
 * 大小写不敏感（与 modScan.isExcluded / cloudbagRestore.isAnchorPath 同一口径）：
 * 目标平台 NTFS 不区分大小写，`.OHMYTX/cloud.json` 写到的是同一位置，
 * 按大小写敏感比较会把它误算成「本地未发布修改」。 */
export function isCloudBagInternalPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  return normalized === CLOUD_BAG_ANCHOR_PATH.toLowerCase() || normalized === '.ohmytx' || normalized.startsWith('.ohmytx/')
}

/** 推送：本地树 → 白名单过滤 → 逐文件 blob（进度/取消/重试）→ 原子建版本 */
export async function pushLocalTree(
  host: SyncHost,
  options: { message: string; baseVersionNo: number; clientOpId?: string },
): Promise<PushOutcome> {
  const { api, bridge, rootPath, repoSlug, onProgress, isAborted } = host
  const uploaded: string[] = []
  let skippedBinary: string[] = []
  let oversized: string[] = []
  let unsupported: string[] = []
  /** 第一趟候选清单快照：冲突时给 A 栏「本地 vs 锚点基线」复用，不重复哈希 */
  let prepared: LocalTreeEntry[] = []
  try {
    // 第一趟（扫描+分流+哈希）与同步弹窗打开时的基线核对是同一函数，口径不会漂移。
    // 只保留元数据（path/sha256）：字节在每次迭代后即出作用域，不随 prepared 常驻。
    // 会话需要全量清单，故上传阶段（第二趟）按文件重读；整个推送峰值 = 单文件 ≤50MiB。
    const scan = await scanLocalTree(bridge, rootPath, { onProgress, isCancelled: isAborted })
    if (!scan) return { status: 'aborted', uploaded, skippedBinary, oversized, unsupported }
    prepared = scan.entries
    skippedBinary = scan.skippedBinary
    oversized = scan.oversized
    unsupported = scan.unsupported

    if (prepared.length === 0) {
      return { status: 'failed', error: '没有可上传的文件（全部被跳过或超限）', uploaded, skippedBinary, oversized, unsupported, localTree: prepared }
    }

    const session = await api.openSession(repoSlug, {
      opType: 'push',
      baseVersionNo: options.baseVersionNo,
      files: prepared.map((file) => ({ path: file.path, sha256: file.sha256 })),
    })

    onProgress({ phase: 'uploading', done: 0, total: prepared.length })
    // 成功上传的 {path,sha256}：提交只纳入真正上传成功的文件。第二趟读取失败/超限
    // 与第一趟同一口径——「计入 skipped 并继续」，而不是整次发布失败：两趟策略必须对称，
    // 否则发布期间一个文件被并发改动/删除就会让整推中止，且留下已开的会话与已传 blob。
    const uploadedRefs: Array<{ path: string; sha256: string }> = []
    for (let index = 0; index < prepared.length; index++) {
      if (isAborted()) return { status: 'aborted', uploaded, skippedBinary, oversized, unsupported }
      const file = prepared[index]
      // 第二趟读取本文件字节：上传完成后随本轮迭代结束而被回收，整批不常驻。
      let bytes = await readLocalFileBytes(bridge, rootPath, file.path)
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
      if (bytes instanceof Error) {
        skippedBinary.push(`${file.path}（${bytes.message}）`)
        onProgress({ phase: 'uploading', done: index + 1, total: prepared.length, currentPath: file.path })
        continue
      }
      if (bytes.byteLength > 50 * 1024 * 1024) {
        oversized.push(file.path)
        onProgress({ phase: 'uploading', done: index + 1, total: prepared.length, currentPath: file.path })
        continue
      }
      let sha = file.sha256
      let lastError: unknown = null
      let hashReread = false
      let readFailed = false
      // 失败重试：网络类错误最多重试 2 次。object_hash_mismatch 是**确定性失败**
      // （同一份字节重传必然再失败），不再盲重试：重读文件并重算 sha 后重试一次
      // （文件在 pass 1 哈希后被并发改动时 sha 会变）；仍不一致则计入 skipped 继续，
      // 与第二趟读取失败同口径——不因单个文件变动整推中止。
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          await api.uploadBlob(repoSlug, {
            sessionId: session.id,
            path: file.path,
            sha256: sha,
            bytes,
            fileName: safeUploadFileName(file.path),
            contentType: 'application/octet-stream',
          })
          lastError = null
          break
        } catch (err) {
          lastError = err
          const kind = (err as CloudBagApiError).kind
          // timeout 不重试：渲染层的超时不会取消主进程的传输，重发只会让同一份大文件
          // 在慢上行链路上再传一遍（用户白耗带宽），如实上报让用户改走网页端。
          if (kind === 'quota_exceeded' || kind === 'forbidden' || kind === 'file_too_large' || kind === 'timeout') throw err
          if (kind === 'object_hash_mismatch') {
            if (hashReread) break // 只重读重算一次；仍不一致则交给下面的 skipped 分支
            hashReread = true
            const reread = await readLocalFileBytes(bridge, rootPath, file.path)
              .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
            if (reread instanceof Error) {
              skippedBinary.push(`${file.path}（${reread.message}）`)
              readFailed = true
              break
            }
            // 重读后必须重做 >50MiB 判定：文件在 pass1 哈希后被并发改写并跨过上限时，
            // 若直接交给 uploadBlob，api 层会抛 file_too_large（cloudBagApi.ts:580），
            // 而 :309 对 file_too_large 立即 throw → 整推中止，与第二趟读取失败/超限
            // 走 skipped 的口径相悖。这里补上，与首读同口径计入 oversized 并跳过。
            if (reread.byteLength > 50 * 1024 * 1024) {
              oversized.push(file.path)
              readFailed = true
              break
            }
            bytes = reread
            sha = await sha256Hex(bytes)
            continue
          }
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      if (readFailed) {
        onProgress({ phase: 'uploading', done: index + 1, total: prepared.length, currentPath: file.path })
        continue
      }
      if (lastError) {
        if ((lastError as CloudBagApiError)?.kind === 'object_hash_mismatch') {
          skippedBinary.push(`${file.path}（内容校验不一致，已跳过）`)
          onProgress({ phase: 'uploading', done: index + 1, total: prepared.length, currentPath: file.path })
          continue
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
      }
      uploadedRefs.push({ path: file.path, sha256: sha })
      uploaded.push(file.path)
      onProgress({ phase: 'uploading', done: index + 1, total: prepared.length, currentPath: file.path })
    }

    // 最后一个上传 await 返回后仍须观察取消，不能越过文件循环直接建版本。
    if (isAborted()) return { status: 'aborted', uploaded, skippedBinary, oversized, unsupported }

    // 第二趟全部跳过（发布期间所有文件都不可读/超限）：与第一趟空清单同口径直接失败
    if (uploadedRefs.length === 0) {
      return { status: 'failed', error: '没有可上传的文件（全部被跳过或超限）', uploaded, skippedBinary, oversized, unsupported }
    }

    onProgress({ phase: 'committing', done: prepared.length, total: prepared.length })
    // 幂等键在「一次逻辑推送」内固定：同一次提交的失败重试复用同一 client_op_id，
    // 服务端的 uniqueIndex(repo_id,user_id,client_op_id) 幂等重放才真正生效
    // （响应丢失但版本已落库时，重试返回首次结果而不是再建一个重复版本）。
    const clientOpId = options.clientOpId ?? newClientOpId()
    if (isAborted()) return { status: 'aborted', uploaded, skippedBinary, oversized, unsupported }
    // 提交边界：从此处首次 pushVersion 发出起可能已落库，继续用同一幂等键
    // 等待/重试并报告真实提交结果；提交中取消不能把已创建的版本谎报为 aborted。
    const result = await commitVersionWithRetry(api, repoSlug, {
      baseVersionNo: options.baseVersionNo,
      message: options.message,
      clientOpId,
      files: uploadedRefs,
    })
    onProgress({ phase: 'done', done: prepared.length, total: prepared.length })
    // 锚点基线摘要只取**实际提交**的 uploadedRefs：第二趟跳过/失败的文件不在版本树里，
    // 若用本地候选清单算摘要就会把它们谎报为已同步（重开后永远 clean，发布按钮禁用）。
    const treeDigest = await treeDigestOf(uploadedRefs)
    return { status: 'pushed', versionNo: result.versionNo, uploaded, skippedBinary, oversized, unsupported, treeDigest, localTree: prepared }
  } catch (error) {
    const cloudError = error as CloudBagApiError
    if (cloudError?.kind === 'version_conflict') {
      // localTree：冲突 A 栏「本地 vs 锚点基线」直接用这一趟已算好的本地清单，不再重扫
      return { status: 'conflict', conflict: cloudError.conflict, uploaded, skippedBinary, oversized, unsupported, localTree: prepared }
    }
    return { status: 'failed', error: cloudError?.message ?? (error instanceof Error ? error.message : String(error)), uploaded, skippedBinary, oversized, unsupported }
  }
}

export interface ImportOutcome {
  status: 'imported' | 'failed' | 'aborted'
  repo?: CloudBagRepo
  versionNo?: number
  error?: string
  /** 首版本实际提交树摘要（首版本的锚点基线；调用方写入本地锚点后即可离线比对） */
  treeDigest?: string
  uploaded: string[]
  skippedBinary: string[]
  oversized: string[]
  unsupported: string[]
}

/**
 * 空态导入编排（桌面契约 §1.1/§6.1）：建仓库 → 把源目录（当前项目根，或经
 * `bridge.mod.import` / `importModBuffer` 解包出的目录）作为初始文件树提交首版本。
 * 全链路复用 pushLocalTree（同一白名单/限额/幂等/冲突语义），不新增第二条上传路径。
 */
export async function importTreeToNewRepo(
  host: SyncHost,
  input: { repo: CreateCloudBagRepoInput; message: string },
): Promise<ImportOutcome> {
  const empty = { uploaded: [] as string[], skippedBinary: [] as string[], oversized: [] as string[], unsupported: [] as string[] }
  let repo: CloudBagRepo
  try {
    repo = await host.api.createRepo(input.repo)
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error), ...empty }
  }
  const outcome = await pushLocalTree({ ...host, repoSlug: repo.slug }, { message: input.message, baseVersionNo: 0 })
  const lists = { uploaded: outcome.uploaded, skippedBinary: outcome.skippedBinary, oversized: outcome.oversized, unsupported: outcome.unsupported }
  if (outcome.status === 'pushed') return { status: 'imported', repo, versionNo: outcome.versionNo, treeDigest: outcome.treeDigest, ...lists }
  if (outcome.status === 'aborted') return { status: 'aborted', repo, ...lists }
  return {
    status: 'failed',
    repo,
    error: outcome.error ?? (outcome.status === 'conflict' ? '新仓库不应出现版本冲突，请重试' : '导入失败'),
    ...lists,
  }
}

/** 拉取：下载服务端打包的 head .rwmod → 主进程两段式恢复（先备份后覆盖，失败回滚） */
export async function pullRemoteVersion(
  host: SyncHost,
  options: { versionNo: number },
): Promise<PullOutcome> {
  const { api, bridge, rootPath, repoSlug, onProgress, isAborted } = host
  try {
    onProgress({ phase: 'downloading', done: 0, total: 1 })
    const download = await api.exportRwmod(repoSlug, options.versionNo)
    if (isAborted()) return { status: 'aborted' }
    if (!bridge.cloudbag) return { status: 'failed', error: '需要更新桌面版才能拉取覆盖（缺少恢复通道）' }
    onProgress({ phase: 'restoring', done: 1, total: 1 })
    const result = await bridge.cloudbag.restore(rootPath, download.bytes, options.versionNo)
    // 恢复成功后按**实际落盘的本地树**重新扫描并算摘要（同一候选过滤口径）：锚点基线摘要
    // 必须与真实恢复树一致，下一次打开/发布后的判定才能直接比较。验证失败不能把已成功的
    // 恢复谎报为失败：摘要缺省，锚点留空，下次打开走旧锚点从服务端补齐的迁移路径。
    let treeDigest: string | undefined
    try {
      onProgress({ phase: 'verifying', done: 0, total: 0 })
      const scan = await scanLocalTree(bridge, rootPath, {
        onProgress: (progress) => onProgress({ phase: 'verifying', done: progress.done, total: progress.total, currentPath: progress.currentPath }),
        isCancelled: isAborted,
      })
      if (scan) treeDigest = scan.digest
    } catch {
      treeDigest = undefined
    }
    onProgress({ phase: 'done', done: 1, total: 1 })
    return {
      status: 'pulled',
      versionNo: options.versionNo,
      written: result.written,
      backedUp: result.backedUp,
      removed: result.removed,
      movedList: result.movedList,
      skipped: result.skipped,
      backupDir: result.backupDir,
      treeDigest,
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
