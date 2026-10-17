import fs from 'node:fs'
import { isExcluded } from './modScan'
import { normalizePath } from './paths'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

export function registerCloudbagWatch(ctx: IpcContext, ipc: RegisterHandler): void {
  const watches = new Map<string, { close: () => void; sender: number }>()
  ipc('cloudbag:watch', async (event: Electron.IpcMainInvokeEvent, root: unknown, enabled: unknown) => {
    if (typeof root !== 'string' || typeof enabled !== 'boolean') throw new Error('无效的监听参数')
    if (enabled && !ctx.roots.has(normalizePath(root))) throw new Error('未登记的同步目录')
    const key = `${event.sender.id}:${normalizePath(root)}`
    watches.get(key)?.close(); watches.delete(key)
    if (!enabled) return
    if (watches.size >= 32) throw new Error('监听目录数量已达上限')
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = fs.watch(root, { recursive: true }, (_kind, name) => {
      if (!ctx.roots.has(normalizePath(root))) { close(); watches.delete(key); return }
      if (name && isExcluded(name.toString().replace(/\\/g, '/'))) return
      clearTimeout(timer)
      timer = setTimeout(() => { if (!event.sender.isDestroyed()) event.sender.send('cloudbag:changed', { rootPath: root }) }, 1200)
    })
    const destroyed = () => { close(); watches.delete(key) }
    const close = () => { clearTimeout(timer); watcher.close(); event.sender.removeListener('destroyed', destroyed) }
    watcher.on('error', () => { close(); watches.delete(key); if (!event.sender.isDestroyed()) event.sender.send('cloudbag:changed', { rootPath: root, error: '文件监听失败，改用定期检查' }) })
    watches.set(key, { close, sender: event.sender.id })
    event.sender.once('destroyed', destroyed)
  })
}
