/**
 * 用户经系统对话框确认后的文本文件写入（质量报告导出等）。
 * 独立成模块：保存目标由 showSaveDialog 返回（用户在系统对话框中亲自选择），
 * 这里只做最后的绝对路径校验与落盘——对话框 IPC 与文件写入职责分离。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 写入用户确认的文本文件（target 必须是 showSaveDialog 返回的绝对路径） */
export async function writeUserConfirmedTextFile(target: string, content: string): Promise<void> {
  if (!path.isAbsolute(target)) throw new Error('保存路径无效')
  await fs.writeFile(target, content, 'utf8')
}
