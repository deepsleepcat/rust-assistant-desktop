/**
 * 云书包手动同步编排（渲染层；不新增任何网络通道——HTTP 一律走 cloudBagApi，
 * 本地文件一律走既有项目桥，写盘恢复走 cloudbag:restore 主进程受限通道）。
 * 设计：bridge/api 全部注入，Vitest 用假桥验证完整业务流（上传请求形状、
 * 冲突分支、取消、跳过二进制、锚点写入）。
 */
import type { BridgeApi } from '../types/bridge'
import type { CloudBagApi, CloudBagApiError, CloudBagHeadSummary, CloudBagRepo, CreateCloudBagRepoInput } from './cloudBagApi'
import {
  buildLocalFilePlan,
  classifyLocalFile,
  CLOUD_BAG_ANCHOR_PATH,
  newClientOpId,
  parseCloudBagAnchor,
  serializeCloudBagAnchor,
  safeUploadFileName,
  type CloudBagAnchor,
  type LocalFilePlanInput,
} from '../features/community/cloudBagData'
import { joinProjectPath } from '../utils/projectPath'

export interface SyncProgress {
  phase: 'reading' | 'hashing' | 'uploading' | 'committing' | 'downloading' | 'restoring' | 'done'
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

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
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
async function readLocalFileBytes(bridge: BridgeApi, rootPath: string, relPath: string): Promise<ArrayBuffer> {
  const kind = classifyLocalFile(relPath)
  const abs = joinProjectPath(rootPath, relPath)
  if (kind === 'text') {
    const { content, hasBom, size } = await bridge.project.readFile(rootPath, abs)
    const body = new TextEncoder().encode(content)
    const bytes = new Uint8Array(body.byteLength + (hasBom ? 3 : 0))
    // BOM 保真：fs:readFile 会把 BOM 剥掉，重编码时必须还原，否则上传的是被改写的内容
    if (hasBom) bytes.set([0xef, 0xbb, 0xbf], 0)
    bytes.set(body, hasBom ? 3 : 0)
    // 编码保真校验：读取桥按 UTF-8 解码（非法字节变 U+FFFD，GBK/ANSI 变乱码），
    // 重编码后字节数与磁盘原文件不一致即说明原文件不是合法 UTF-8。
    // 这种文件上传即是静默改写（拉取后还会覆盖回本地），宁可跳过并如实报告。
    if (bytes.byteLength !== size) {
      throw new Error('不是 UTF-8 编码（GBK/ANSI 或含非法字节），按文字上传会改写内容，已跳过')
    }
    return bytes.buffer as ArrayBuffer
  }
  if (kind === 'image') {
    return dataUrlToBytes(await bridge.project.readImageAsDataUrl(rootPath, abs))
  }
  if (kind === 'audio') {
    return dataUrlToBytes(await bridge.project.readAudioAsDataUrl(rootPath, abs))
  }
  throw new Error(`暂不支持读取的二进制文件类型：${relPath}`)
}

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

/** 读取本地同步锚点（不存在/损坏返回 null） */
export async function readCloudBagAnchor(bridge: BridgeApi, rootPath: string): Promise<CloudBagAnchor | null> {
  try {
    const { content } = await bridge.project.readFile(rootPath, joinProjectPath(rootPath, CLOUD_BAG_ANCHOR_PATH))
    return parseCloudBagAnchor(content)
  } catch {
    return null
  }
}

/** 成功提交/拉取后写回锚点（主进程已把 .ohmytx 排除出打包）。
 * 锚点父目录首次发布时可能不存在，而 fs:writeFile 的临时文件 rename 不建父目录 →
 * 必须先确保 .ohmytx 存在（已存在时 createFolder 报错属正常，忽略）。 */
export async function writeCloudBagAnchor(bridge: BridgeApi, rootPath: string, anchor: CloudBagAnchor): Promise<void> {
  await bridge.project.createFolder(rootPath, rootPath, '.ohmytx').catch(() => undefined)
  await bridge.project.writeFile(rootPath, joinProjectPath(rootPath, CLOUD_BAG_ANCHOR_PATH), serializeCloudBagAnchor(anchor), { hasBom: false })
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
  const skippedBinary: string[] = []
  const oversized: string[] = []
  const unsupported: string[] = []
  try {
    const scan = await bridge.mod.scanResources(rootPath)
    const candidates: LocalFilePlanInput[] = []
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
    candidates.push(...withSizes)
    const plan = buildLocalFilePlan(candidates)
    plan.unsupported.forEach((file) => {
      if (classifyLocalFile(file.path) === 'binary') skippedBinary.push(file.path)
    })
    oversized.push(...plan.oversized.map((file) => file.path))
    unsupported.push(...plan.unsupported.filter((file) => classifyLocalFile(file.path) !== 'binary').map((file) => file.path))

    onProgress({ phase: 'hashing', done: 0, total: plan.uploadable.length })
    // 只保留元数据（path/sha256）：第一趟读取的文件字节在每次迭代后即出作用域，
    // 不随 prepared 常驻。旧实现把整批字节都存在 prepared[].bytes 里，客户端又不限总量
    // （单文件 ≤50MiB，但仓库 512MiB / 用户 2GiB），峰值可达数百 MiB 常驻渲染层。
    // 会话需要全量清单，故上传阶段（第二趟）按文件重读；整个推送峰值 = 单文件 ≤50MiB。
    const prepared: Array<{ path: string; sha256: string }> = []
    for (const file of plan.uploadable) {
      if (isAborted()) return { status: 'aborted', uploaded, skippedBinary, oversized, unsupported }
      try {
        const bytes = await readLocalFileBytes(bridge, rootPath, file.path)
        if (bytes.byteLength > 50 * 1024 * 1024) {
          oversized.push(file.path)
          continue
        }
        prepared.push({ path: file.path, sha256: await sha256Hex(bytes) })
      } catch (err) {
        skippedBinary.push(`${file.path}（${err instanceof Error ? err.message : String(err)}）`)
      }
    }

    if (prepared.length === 0) {
      return { status: 'failed', error: '没有可上传的文件（全部被跳过或超限）', uploaded, skippedBinary, oversized, unsupported }
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
    return { status: 'pushed', versionNo: result.versionNo, uploaded, skippedBinary, oversized, unsupported }
  } catch (error) {
    const cloudError = error as CloudBagApiError
    if (cloudError?.kind === 'version_conflict') {
      return { status: 'conflict', conflict: cloudError.conflict, uploaded, skippedBinary, oversized, unsupported }
    }
    return { status: 'failed', error: cloudError?.message ?? (error instanceof Error ? error.message : String(error)), uploaded, skippedBinary, oversized, unsupported }
  }
}

export interface ImportOutcome {
  status: 'imported' | 'failed' | 'aborted'
  repo?: CloudBagRepo
  versionNo?: number
  error?: string
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
  if (outcome.status === 'pushed') return { status: 'imported', repo, versionNo: outcome.versionNo, ...lists }
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
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
