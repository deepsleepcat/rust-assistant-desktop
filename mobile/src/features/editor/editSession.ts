/**
 * 编辑会话（纯逻辑，不依赖 Tauri / React / store）。
 *
 * 手机版一次只编辑一个文件，但「显示层」与「磁盘内容」必须分开记账：
 * - 中文显示层开启时，编辑器里是中文，磁盘上是英文；保存要精确回译；
 * - 保存期间用户可能继续输入，保存回调不能把后续输入误标成已保存；
 * - 保存回调返回时用户可能已切到别的文件，旧回调不能污染新会话。
 *
 * 因此会话里保存两个基准：
 * - `savedDisplay`：最后一次与磁盘一致的**显示内容**（脏判定基准）；
 * - `original`：最后一次读/写的**磁盘英文内容**（外部修改比对与诊断）。
 * 是否脏由 `isDirty()` 派生，不额外存字段——撤销回保存状态即自动变干净。
 */
import { enToZh, zhToEn, type TranslationDict, type TranslationTracker } from '../../services/translation'

/** 显示语言：plain = 原文；zh = 中文显示层（保存回译英文） */
export type DisplayMode = 'plain' | 'zh'

export interface EditSession {
  /** 所属项目 id（切换项目时用于判定会话是否过期） */
  projectId: string
  /** 项目根路径（bridge 的文件通道要求） */
  rootPath: string
  /** 文件绝对路径 */
  path: string
  /** 文件名（标题栏显示） */
  name: string
  /** 当前编辑器里的显示内容 */
  content: string
  /** 最后一次与磁盘一致的显示内容（脏判定基准） */
  savedDisplay: string
  /** 最后一次读/写的磁盘英文内容 */
  original: string
  hasBom: boolean
  displayMode: DisplayMode
  /** 中文显示层追踪表（中文串 → 原始英文串）；plain 模式为 null，不序列化 */
  translationTrack: TranslationTracker | null
  /** 打开/保存时的磁盘修改时间（外部修改检测基准；0 表示未知） */
  mtimeMs: number
}

export interface OpenSessionInput {
  projectId: string
  rootPath: string
  path: string
  name: string
  /** 磁盘原文 */
  raw: string
  hasBom: boolean
  mtimeMs: number
  /** 是否启用中文显示层 */
  chineseMode: boolean
  /** 中英词典（调用方注入，便于测试） */
  dict: TranslationDict
}

/** 打开文件 → 建立编辑会话（中文模式同时生成追踪表，供保存精确回译） */
export function createSession(input: OpenSessionInput): EditSession {
  const base = {
    projectId: input.projectId,
    rootPath: input.rootPath,
    path: input.path,
    name: input.name,
    original: input.raw,
    hasBom: input.hasBom,
    mtimeMs: input.mtimeMs,
  }
  if (!input.chineseMode) {
    return { ...base, content: input.raw, savedDisplay: input.raw, displayMode: 'plain', translationTrack: null }
  }
  const track: TranslationTracker = new Map()
  const display = enToZh(input.raw, input.dict, track)
  return { ...base, content: display, savedDisplay: display, displayMode: 'zh', translationTrack: track }
}

/** 编辑器内容变化 */
export function applyEdit(session: EditSession, content: string): EditSession {
  return session.content === content ? session : { ...session, content }
}

/** 是否与磁盘一致（脏判定派生，撤销回保存状态即为 false） */
export function isDirty(session: EditSession | null): boolean {
  return session !== null && session.content !== session.savedDisplay
}

/**
 * 本次保存的待写内容：显示内容快照 + 回译后的英文。
 * 中文模式按追踪表精确回译（未被翻译层产生的中文原样保留）。
 */
export function prepareSave(
  session: EditSession,
  dict: TranslationDict,
): { displaySnapshot: string; english: string } {
  const displaySnapshot = session.content
  const english =
    session.displayMode === 'zh'
      ? zhToEn(displaySnapshot, dict, session.translationTrack ?? undefined)
      : displaySnapshot
  return { displaySnapshot, english }
}

export interface PendingSave {
  /** 保存发起时的文件路径（用于丢弃过期回调） */
  path: string
  /** 保存发起时的显示内容 */
  displaySnapshot: string
  /** 实际写入磁盘的英文内容 */
  english: string
  /** 写盘后的磁盘修改时间（推进基准，否则下次保存会把自己的写入误判成外部修改） */
  mtimeMs?: number
}

/**
 * 写盘成功后收敛会话。
 * - 路径不匹配（用户已切换文件）：原样返回，旧回调不得改动新会话；
 * - 保存期间继续输入：保存基准推进到快照，`content` 保持用户的最新输入，
 *   于是会话仍然是脏的，用户不会以为后续输入已落盘；
 * - 带 mtimeMs 时同时推进修改时间基准。
 */
export function applySaveResult(session: EditSession, pending: PendingSave): EditSession {
  if (session.path !== pending.path) return session
  return {
    ...session,
    savedDisplay: pending.displaySnapshot,
    original: pending.english,
    ...(pending.mtimeMs ? { mtimeMs: pending.mtimeMs } : {}),
  }
}

/** 重新读盘（外部修改后用户选择「重新载入」或放弃了本地修改） */
export function applyReload(session: EditSession, input: Omit<OpenSessionInput, 'projectId' | 'rootPath' | 'path' | 'name'>): EditSession {
  const next = createSession({
    ...input,
    projectId: session.projectId,
    rootPath: session.rootPath,
    path: session.path,
    name: session.name,
  })
  return next
}

/**
 * 会话失效哨兵：应用内部已知有其它写入改动了这个文件（例如 AI 工具写入），
 * 但此刻未必方便再取一次准确的磁盘 mtime，于是用哨兵直接标记为有冲突。
 */
export const EXTERNAL_CHANGED = -1

/** 标记会话已被外部写入改动（AI 工具写盘后调用） */
export function markExternallyChanged(session: EditSession): EditSession {
  return { ...session, mtimeMs: EXTERNAL_CHANGED }
}

/**
 * 保存前的外部修改检查。
 * 磁盘修改时间与打开/上次保存时不同 → 文件被外部（其它 App / AI 工具）改过，
 * 直接覆盖会丢别人的改动，必须让用户先选「重新载入」还是「仍然覆盖」。
 */
export function checkExternalChange(session: EditSession, diskMtimeMs: number): 'ok' | 'external-changed' {
  if (session.mtimeMs === EXTERNAL_CHANGED) return 'external-changed'
  if (!diskMtimeMs || !session.mtimeMs) return 'ok'
  return diskMtimeMs === session.mtimeMs ? 'ok' : 'external-changed'
}

/** 用户选择「仍然覆盖」后，把修改时间基准推进到磁盘当前值 */
export function acceptOverwrite(session: EditSession, diskMtimeMs: number): EditSession {
  return { ...session, mtimeMs: diskMtimeMs }
}
