/**
 * 插件导入 IPC（M40 巨型文件拆分批次 B2）：
 * 只允许用户通过系统对话框选择本地 manifest.json 或目录。
 * 目录收集拒绝符号链接与脚本/可执行文件；manifest 校验交给 validatePluginImport。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { validatePluginImport } from '../src/features/plugins'
import type { PluginImportSelection } from '../src/types/bridge'

const PLUGIN_MANIFEST_FILE = 'manifest.json'

async function collectPluginFiles(rootPath: string): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = []
  const stack = [{ absolute: rootPath, relative: '' }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await fs.readdir(current.absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('插件目录不能包含符号链接')
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name
      const absolute = path.join(current.absolute, entry.name)
      if (entry.isDirectory()) {
        stack.push({ absolute, relative })
        continue
      }
      if (!entry.isFile()) throw new Error('插件目录含不支持的文件类型')
      const stat = await fs.stat(absolute)
      files.push({ path: relative.replace(/\\/g, '/'), size: stat.size })
      if (files.length > 256) throw new Error('插件文件数量超过限制')
    }
  }
  return files
}

/** 插件导入：只允许用户通过系统对话框选择本地 manifest.json 或目录。 */
export function registerPluginIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('plugin:importLocal', async (): Promise<PluginImportSelection | null> => {
    const result = await ctx.dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory'],
      title: '导入本地插件',
      filters: [{ name: '插件清单', extensions: ['json'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selected = result.filePaths[0]
    const selectedStat = await fs.lstat(selected)
    if (selectedStat.isSymbolicLink()) throw new Error('插件路径不能是符号链接')
    if (selectedStat.isFile()) {
      if (path.basename(selected).toLowerCase() !== PLUGIN_MANIFEST_FILE) throw new Error('只能导入名为 manifest.json 的插件清单')
      if (selectedStat.size > 256 * 1024) throw new Error('manifest 超过大小限制')
      const manifest = JSON.parse(await fs.readFile(selected, 'utf8')) as unknown
      const checked = validatePluginImport({ source: 'json', userInitiated: true, manifest, files: [{ path: PLUGIN_MANIFEST_FILE, size: selectedStat.size }] })
      if (!checked.ok) throw new Error(checked.errors.join('；'))
      return checked.value
    }
    if (!selectedStat.isDirectory()) throw new Error('插件选择必须是文件或目录')
    const files = await collectPluginFiles(selected)
    const manifestPath = path.join(selected, PLUGIN_MANIFEST_FILE)
    const manifestStat = await fs.lstat(manifestPath).catch(() => null)
    if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('插件目录根下必须有 manifest.json')
    if (manifestStat.size > 256 * 1024) throw new Error('manifest 超过大小限制')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown
    const checked = validatePluginImport({ source: 'directory', userInitiated: true, manifest, files })
    if (!checked.ok) throw new Error(checked.errors.join('；'))
    return checked.value
  })
}
