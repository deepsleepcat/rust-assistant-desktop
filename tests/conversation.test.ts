import { describe, expect, it } from 'vitest'
import { formatRelativeTime, nextConversationTitle, sortConversations } from '../src/utils/conversation'
import type { Conversation } from '../src/types/domain'

const now = 1_800_000_000_000

function makeConv(overrides: Partial<Conversation>): Conversation {
  return {
    id: Math.random().toString(36),
    projectId: 'p1',
    title: '对话',
    createdAt: now,
    updatedAt: now,
    archived: false,
    messages: [],
    ...overrides,
  }
}

describe('对话工具', () => {
  it('自动命名递增：对话 1、对话 2…', () => {
    expect(nextConversationTitle([])).toBe('对话 1')
    expect(nextConversationTitle([makeConv({ title: '对话 1' })])).toBe('对话 2')
    expect(nextConversationTitle([makeConv({ title: '对话 1' }), makeConv({ title: '对话 2' })])).toBe('对话 3')
  })

  it('自动命名跳过手动命名的对话', () => {
    const list = [makeConv({ title: '修复炮塔' }), makeConv({ title: '对话 2' })]
    expect(nextConversationTitle(list)).toBe('对话 3')
  })

  it('排序：未归档在前（新的优先），归档的最后', () => {
    const a = makeConv({ title: 'a', updatedAt: now - 1000 })
    const b = makeConv({ title: 'b', updatedAt: now })
    const c = makeConv({ title: 'c', updatedAt: now - 500, archived: true })
    const sorted = sortConversations([c, a, b])
    expect(sorted.map((x) => x.title)).toEqual(['b', 'a', 'c'])
  })

  it('相对时间展示', () => {
    expect(formatRelativeTime(now, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
  })
})
