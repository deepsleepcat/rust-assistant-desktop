/**
 * 媒体信任策略（M40 巨型文件拆分批次 B3）：
 * 可预览媒体（图片/音频）的允许集合持久化、恢复与 data URL 读取。
 * dialog 域写入信任（addAllowedMedia），fs 域读取预览，main.ts 启动恢复。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizePath } from './paths'
import type { IpcContext } from './ipcContext'
import { requireRealInsideRoot } from './projectTrust'

/** 媒体允许集合持久化键 */
export const MEDIA_ALLOWLIST_KEY = 'mediaAllowlist'
export const MEDIA_MIGRATED_KEY = 'mediaMigratedV1'

/** 图片 MIME 白名单 */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

/** 音频 MIME 白名单（M6.5 音频预览） */
export const AUDIO_MIME: Record<string, string> = {
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac',
}

/** 登记并持久化媒体允许路径（对话框/自写文件才调用） */
export function addAllowedMedia(ctx: IpcContext, p: string): void {
  ctx.media.add(normalizePath(p))
  void ctx.store.set(MEDIA_ALLOWLIST_KEY, [...ctx.media])
}

/** 从设置中提取外观背景路径：仅当该路径已在允许集合（曾由对话框产生）时才保持信任 */
export function registerMediaFromSettings(ctx: IpcContext, settings: unknown): void {
  if (!settings || typeof settings !== 'object') return
  const s = settings as { background?: { imagePath?: unknown } }
  const p = s.background?.imagePath
  if (typeof p === 'string' && p && ctx.media.has(normalizePath(p))) {
    ctx.media.add(normalizePath(p))
  }
}

/** 启动时恢复持久化的媒体允许集合；仅「首次升级且从未迁移过」时从旧设置迁移一次 */
export function restoreMediaAllowlist(ctx: IpcContext): void {
  const saved = ctx.store.get(MEDIA_ALLOWLIST_KEY)
  if (Array.isArray(saved)) {
    for (const p of saved) {
      if (typeof p === 'string' && p) ctx.media.add(normalizePath(p))
    }
    return
  }
  // LOW-4：锚值被异常改写时按「无锚」处理
  if (saved !== null && saved !== undefined) console.warn('[ipc] mediaAllowlist 锚值异常，按无锚处理:', typeof saved)
  // 已迁移过（或从未有旧数据）：不再迁移，保持空信任集合
  if (ctx.store.get(MEDIA_MIGRATED_KEY) === true) return
  // 旧版本没有 allowlist 记录：设置里已有的背景图路径来自系统对话框，
  // 作为旧版信任一次性迁移登记（之后只认对话框来源，不再扩张）。
  const s = ctx.store.get('settings') as { background?: { imagePath?: unknown } } | undefined
  const p = s?.background?.imagePath
  if (typeof p === 'string' && p) ctx.media.add(normalizePath(p))
  void ctx.store.set(MEDIA_ALLOWLIST_KEY, [...ctx.media])
  void ctx.store.set(MEDIA_MIGRATED_KEY, true)
}

/** 读取图片/音频为 data URL：限项目内 + 扩展名白名单 + 大小上限 */
export async function readMediaAsDataUrl(ctx: IpcContext, rootPath: string, mediaPath: string, mimeByExt: Record<string, string>): Promise<string> {
  if (typeof mediaPath !== 'string' || !path.isAbsolute(mediaPath)) throw new Error('无效的文件路径')
  if (rootPath) {
    // L1：与 fs:readFile 一致做链接逃逸校验（项目内指向外部的链接不能作为预览读取通道）
    await requireRealInsideRoot(ctx, rootPath, mediaPath)
  } else if (!ctx.media.has(normalizePath(mediaPath))) {
    // 空 rootPath = 外观背景：只允许读「用户通过系统选择器选中」的文件
    throw new Error('未登记的文件，拒绝访问')
  }
  const ext = path.extname(mediaPath).toLowerCase()
  const mime = mimeByExt[ext]
  if (!mime) throw new Error('不支持的文件格式')
  const stat = await fs.stat(mediaPath)
  // 媒体预览上限 20MB：100MB 全量读入 + base64 膨胀（约 1.33x）经 IPC 传输，
  // 渲染层可反复触发形成内存压力；20MB 已覆盖正常素材（png/ogg 常见几 MB）
  if (stat.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，暂不支持预览')
  const buf = await fs.readFile(mediaPath)
  return `data:${mime};base64,${buf.toString('base64')}`
}
