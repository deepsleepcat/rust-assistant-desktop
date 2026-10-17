import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isExcluded } from './modScan'
import { assertNoLinkEscape } from './paths'

export interface LocalSnapshot { digest: string; files: Record<string, string> }
export async function fileFingerprint(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('同步路径不是普通文件')
    const handle = await fs.open(file, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('扫描期间文件已变化')
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(256 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await handle.stat()
      const current = await fs.lstat(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new Error('扫描期间文件已变化')
      return hash.digest('hex')
    } finally { await handle.close() }
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err }
}

export async function snapshotLocalTree(root: string): Promise<LocalSnapshot> {
  const files: Record<string, string> = {}
  let count = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    await assertNoLinkEscape(root, dir)
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isExcluded(rel)) continue
      if (++count > 50000) throw new Error('自动同步目录条目过多')
      if (entry.isSymbolicLink()) throw new Error(`自动同步目录包含链接：${rel}`)
      const abs = path.join(dir, entry.name)
      await assertNoLinkEscape(root, abs)
      if (entry.isDirectory()) await walk(abs, rel)
      else if (entry.isFile()) {
        const hash = await fileFingerprint(abs)
        if (hash === null) throw new Error(`扫描期间文件已变化：${rel}`)
        files[rel] = hash
      }
    }
  }
  await walk(root, '')
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
  return { digest, files }
}
