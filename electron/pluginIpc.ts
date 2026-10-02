/**
 * 插件导入与资源读取 IPC（M41 插件加载逻辑）：
 * - importLocal：只允许用户通过系统对话框选择本地 manifest.json 或目录；
 *   校验通过后把「插件 id → 根目录」登记进主进程独占的信任锚（pluginTrust）。
 * - forgetLocal：插件卸载时注销信任锚，避免锚值无限增长。
 * - readResource：按 插件 id + 相对路径 读取插件自带的资源（图片/文本），
 *   只读已登记目录内的文件，且做词法 + 真实路径双重逃逸校验。
 *
 * 目录收集拒绝符号链接与脚本/可执行文件；manifest 校验交给 validatePluginImport。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoLinkEscape } from './paths'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { normalizePluginRelativePath, PLUGIN_LIMITS, validatePluginImport } from '../src/features/plugins'
import { IMAGE_MIME } from './mediaPolicy'
import { pluginDirOf, registerPluginDir, unregisterPluginDir } from './pluginTrust'
import type { PluginImportSelection, PluginResourcePayload } from '../src/types/bridge'

const PLUGIN_MANIFEST_FILE = 'manifest.json'

/** 可读为文本的资源扩展名（图片之外的 SAFE_RESOURCE_EXTENSIONS 子集） */
const TEXT_EXTENSIONS = new Set(['.json', '.txt', '.md', '.csv', '.xml', '.tmx', '.ini', '.template'])

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
      // 清单文件的同级目录即插件根：登记信任锚，后续 readResource 才有基准
      registerPluginDir(ctx, checked.value.manifest.id, path.dirname(selected))
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
    registerPluginDir(ctx, checked.value.manifest.id, selected)
    return checked.value
  })

  /** 卸载插件时注销信任锚（未登记视为幂等）。 */
  ipc('plugin:forgetLocal', async (_event, pluginId: string): Promise<void> => {
    if (typeof pluginId !== 'string' || !pluginId) throw new Error('插件标识无效')
    unregisterPluginDir(ctx, pluginId)
  })

  /**
   * 读取插件自带资源。安全边界：只读「导入流程登记过」的插件目录内的文件——
   * 插件 id 不能凭空指定目录，相对路径不能穿越，链接不能逃逸。
   */
  ipc('plugin:readResource', async (_event, pluginId: string, relPath: string): Promise<PluginResourcePayload> => {
    if (typeof pluginId !== 'string' || !pluginId) throw new Error('插件标识无效')
    const dir = pluginDirOf(ctx, pluginId)
    if (!dir) throw new Error('该插件未登记来源目录，请重新导入后再使用其资源')
    if (typeof relPath !== 'string') throw new Error('资源路径无效')
    const normalized = normalizePluginRelativePath(relPath)
    if (!normalized) throw new Error('资源路径必须是插件目录内的安全相对路径')
    const absolute = path.join(dir, ...normalized.split('/'))
    // 词法包含 + 真实路径逃逸双重校验（插件目录内若存在指向外部的链接，必须拒绝）
    await assertNoLinkEscape(dir, absolute)
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error('插件资源不存在')
    if (stat.size > PLUGIN_LIMITS.maxFileBytes) throw new Error('插件资源超过 8MB 上限')

    const ext = path.extname(absolute).toLowerCase()
    const imageMime = IMAGE_MIME[ext]
    if (imageMime) {
      const buf = await fs.readFile(absolute)
      return { kind: 'image', dataUrl: `data:${imageMime};base64,${buf.toString('base64')}` }
    }
    if (TEXT_EXTENSIONS.has(ext)) {
      return { kind: 'text', text: await fs.readFile(absolute, 'utf8') }
    }
    throw new Error('不支持读取该类型的插件资源')
  })
}
