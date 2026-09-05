/**
 * 模组工具共享基础设施（M40 巨型文件拆分批次 A1）：
 * 路径安全解析与受限文本读取，所有模组域文件共用，避免域间互相导入。
 * 设计原则：所有路径都经过 resolveInside() 校验，绝不越出项目根目录。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isPathInside } from './paths'

/** 把相对路径解析为项目内绝对路径（越界抛错） */
export function resolveInside(projectRoot: string, rel: string): string {
  const normalized = String(rel).replace(/^\/+/, '').replace(/\//g, path.sep)
  const abs = path.resolve(projectRoot, normalized)
  if (!isPathInside(projectRoot, abs)) throw new Error('路径超出项目目录范围')
  return abs
}

/** 扫描/检查类文本读取上限（与 fs:readFile 的 64MB 对称）：超过返回空，调用方跳过该文件 */
export const MAX_SCAN_READ_SIZE = 64 * 1024 * 1024

export async function readTextLimited(file: string): Promise<string> {
  const st = await fs.stat(file).catch(() => null)
  if (!st || st.size > MAX_SCAN_READ_SIZE) return ''
  return fs.readFile(file, 'utf8').catch(() => '')
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
