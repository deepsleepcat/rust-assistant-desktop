/**
 * 弹窗遮罩点击关闭回归守卫（v0.3.7 用户反馈缺陷）：
 * 自定义 modal-overlay 若用裸 onClick={onClose} 关闭，嵌套弹窗（如单位库的
 * 复制单位弹窗）里任何一次点击都会冒泡到外层遮罩，把整个弹窗栈关掉——
 * 表现为「点一下重命名输入框整个单位库直接退出，复制永远完不成」。
 * 统一约定：遮罩必须用 onMouseDown + 只认遮罩自身为点击目标（与 Modal.tsx 一致）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      if (readdirSync(full).length >= 0) collectTsx(full, out)
    } catch {
      if (name.endsWith('.tsx')) out.push(full)
    }
  }
  return out
}

describe('弹窗遮罩点击关闭守卫', () => {
  it('所有自定义 modal-overlay 不允许用裸 onClick 关闭（会击穿嵌套弹窗）', () => {
    const offenders: string[] = []
    for (const file of collectTsx(join(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8')
      if (/className="modal-overlay" onClick=/.test(text)) offenders.push(file)
    }
    expect(offenders, `以下文件仍在用裸 onClick 关闭遮罩（嵌套弹窗点击会冒泡关闭整层）:\n${offenders.join('\n')}`).toEqual([])
  })
})
