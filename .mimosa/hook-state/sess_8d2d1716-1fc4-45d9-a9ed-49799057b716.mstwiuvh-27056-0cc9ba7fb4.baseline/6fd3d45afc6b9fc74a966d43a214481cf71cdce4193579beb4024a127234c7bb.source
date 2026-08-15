/**
 * 对话相关的纯函数：自动命名、排序、相对时间展示。
 */
import type { Conversation } from '../types/domain'

/** 自动生成下一个对话标题：对话 1、对话 2 … */
export function nextConversationTitle(conversations: Conversation[]): string {
  let max = 0
  for (const c of conversations) {
    const m = /^对话 (\d+)$/.exec(c.title)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `对话 ${max + 1}`
}

/** 按更新时间倒序（新的在前），归档的排最后 */
export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1
    return b.updatedAt - a.updatedAt
  })
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
