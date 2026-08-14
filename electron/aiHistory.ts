/**
 * AI 修改历史：writeFile 写盘前的快照存储（任务 2「一键撤销 + 修改历史」）。
 *
 * 设计：
 * - 独立 JSON 文件（userData/ai-history.json），不混入主 store——快照是体积大户，
 *   与设置/工作区数据共用文件会让每次设置变更都重写数 MB；
 * - 上限：每文件 20 份、全局 500 条、全局 16MB、单条 2MB（超限跳过快照）；
 *   淘汰策略为按时间驱逐最旧条目，保证「不无限膨胀」；
 * - content 为 null 表示快照时文件不存在（AI 新建），恢复即删除该文件；
 * - 写入沿用 store 的「临时文件 + rename」原子替换，防抖 250ms + flush 兜底。
 */
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { normalizePath } from './paths'
import type { AiHistoryMeta } from '../src/types/ai'

export interface AiHistoryEntry {
  id: string
  at: number
  relPath: string
  /** 快照内容；null = 快照时文件不存在（AI 新建），恢复时删除文件 */
  content: string | null
  size: number
}

export interface AiHistoryLimits {
  /** 每文件保留版本数上限 */
  perFile: number
  /** 全局条目数上限 */
  maxEntries: number
  /** 全局内容总字节上限 */
  maxTotalBytes: number
  /** 单条内容字节上限（超出则跳过快照——超大文件存 20 份会爆盘） */
  maxEntryBytes: number
}

export const DEFAULT_HISTORY_LIMITS: AiHistoryLimits = {
  perFile: 20,
  maxEntries: 500,
  maxTotalBytes: 16 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
}

export interface AiHistory {
  /** 记录一次写盘前快照；超限跳过快照时返回 null（调用方不提供撤销入口） */
  addSnapshot(rootPath: string, relPath: string, content: string | null): Promise<string | null>
  /** 某文件的历史版本（新 → 旧；仅元数据，内容在恢复时由主进程读取） */
  listHistory(rootPath: string, relPath: string): Promise<AiHistoryMeta[]>
  getEntry(rootPath: string, relPath: string, id: string): Promise<AiHistoryEntry | undefined>
  flush(): Promise<void>
}

type RootMap = Record<string, Record<string, AiHistoryEntry[]>>

/**
 * 键归一化：rootPath 走 normalizePath（与全部安全边界同款：小写 + 分隔符统一）；
 * relPath 统一正斜杠并剥掉前导斜杠与 ./ 前缀——AI 可能用 units/a.txt / units\a.txt /
 * ./units/a.txt / /units/a.txt 多种写法（resolveInside 同样剥前导斜杠），不归一化会
 * 导致同一文件的历史链分裂（撤销「版本不存在」）。
 */
function normalizeRootKey(rootPath: string): string {
  return normalizePath(rootPath)
}

function normalizeRelKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '')
}

export function createAiHistory(filePath: string, limits?: Partial<AiHistoryLimits>): AiHistory {
  const lim: AiHistoryLimits = { ...DEFAULT_HISTORY_LIMITS, ...limits }
  let entries: RootMap = {}
  let loaded = false
  let loading: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writeChain: Promise<void> = Promise.resolve()

  async function load(): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as { entries?: RootMap }
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        entries = parsed.entries
      }
    } catch {
      entries = {}
    }
    loaded = true
  }
  loading = load()

  function persist(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void writeNow()
    }, 250)
  }

  async function writeNow(): Promise<void> {
    if (!loaded) return
    writeChain = writeChain.then(async () => {
      let snapshot: string
      try {
        snapshot = JSON.stringify({ v: 1, entries }, null, 2)
      } catch (err) {
        console.error('[aiHistory] 序列化失败:', err)
        return
      }
      const tmp = `${filePath}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, snapshot, 'utf8')
        await fs.rename(tmp, filePath)
      } catch (err) {
        console.error('[aiHistory] 保存失败:', err)
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    })
    await writeChain
  }

  /** 全局最旧条目（各文件列表按 at 递增存放，最旧 = 各列表头部中的 at 最小者） */
  function oldestEntry(): { root: string; rel: string; index: number; entry: AiHistoryEntry } | null {
    let oldest: { root: string; rel: string; index: number; entry: AiHistoryEntry } | null = null
    for (const root of Object.keys(entries)) {
      for (const rel of Object.keys(entries[root])) {
        const list = entries[root][rel]
        if (list.length === 0) continue
        const head = list[0]
        if (!oldest || head.at < oldest.entry.at) oldest = { root, rel, index: 0, entry: head }
      }
    }
    return oldest
  }

  function evictIfNeeded(): void {
    let total = 0
    let bytes = 0
    for (const root of Object.keys(entries)) {
      for (const rel of Object.keys(entries[root])) {
        total += entries[root][rel].length
        for (const e of entries[root][rel]) bytes += e.size
      }
    }
    // 先按条数超限逐条驱逐，再按字节超限逐条驱逐（都从全局最旧开始）
    while (total > lim.maxEntries || bytes > lim.maxTotalBytes) {
      const oldest = oldestEntry()
      if (!oldest) break
      entries[oldest.root][oldest.rel].splice(oldest.index, 1)
      if (entries[oldest.root][oldest.rel].length === 0) {
        delete entries[oldest.root][oldest.rel]
        if (Object.keys(entries[oldest.root]).length === 0) delete entries[oldest.root]
      }
      total--
      bytes -= oldest.entry.size
    }
  }

  return {
    async addSnapshot(rootPath, relPath, content) {
      if (content !== null && Buffer.byteLength(content, 'utf8') > lim.maxEntryBytes) {
        return null // 单条超限：跳过快照（撤销入口不出现，避免误导）
      }
      // 首次加载完成前不记录：快照必须落库（否则撤销入口出现却恢复不到），等加载完成再写
      if (!loaded && loading) await loading
      const entry: AiHistoryEntry = {
        id: randomUUID(),
        at: Date.now(),
        relPath,
        content,
        size: content === null ? 0 : Buffer.byteLength(content, 'utf8'),
      }
      const rootMap = (entries[normalizeRootKey(rootPath)] ??= {})
      const list = (rootMap[normalizeRelKey(relPath)] ??= [])
      list.push(entry)
      if (list.length > lim.perFile) list.splice(0, list.length - lim.perFile)
      evictIfNeeded()
      persist()
      return entry.id
    },
    async listHistory(rootPath, relPath) {
      if (!loaded && loading) await loading
      const list = entries[normalizeRootKey(rootPath)]?.[normalizeRelKey(relPath)] ?? []
      return [...list].reverse().map(({ id, at, relPath: rel, size }) => ({ id, at, relPath: rel, size }))
    },
    async getEntry(rootPath, relPath, id) {
      if (!loaded && loading) await loading
      return entries[normalizeRootKey(rootPath)]?.[normalizeRelKey(relPath)]?.find((e) => e.id === id)
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await writeNow().catch(() => undefined)
    },
  }
}

/** 应用级单例：主进程启动时 initAiHistory 初始化，工具/审批流程通过 getHistory 使用 */
let singleton: AiHistory | null = null

export function initAiHistory(filePath: string, limits?: Partial<AiHistoryLimits>): AiHistory {
  singleton = createAiHistory(filePath, limits)
  return singleton
}

export function getHistory(): AiHistory {
  if (!singleton) throw new Error('aiHistory 未初始化（主进程需先调用 initAiHistory）')
  return singleton
}
