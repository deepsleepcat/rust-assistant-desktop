/**
 * 对话框与项目根登记 IPC（M40 巨型文件拆分批次 B4）。
 * 信任写入面：openFolder/openImage 登记项目根与媒体信任；saveText 只写用户确认的文件。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { normalizePath } from './paths'
import { addAllowedMedia } from './mediaPolicy'
import { PROJECT_ROOTS_KEY, registerRoot } from './projectTrust'

/** 对话框与项目根登记 */
export function registerDialogIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('dialog:openFolder', async () => {
    const result = await ctx.dialog.showOpenDialog({ properties: ['openDirectory'], title: '打开项目文件夹' })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    registerRoot(ctx, root)
    return { rootPath: root, name: path.basename(root) }
  })

  ipc('dialog:openImage', async () => {
    const result = await ctx.dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    // 登记为允许读取的媒体（readMediaAsDataUrl 空 rootPath 分支只认这个集合）
    addAllowedMedia(ctx, p)
    return p
  })

  // M13：另存为文本（质量报告导出用）——保存位置由用户在系统对话框中选择，
  // 主进程只写用户确认的文件（defaultName 为建议文件名）
  ipc('dialog:saveText', async (_event, title: unknown, defaultName: unknown, content: unknown) => {
    if (typeof content !== 'string') return { ok: false, message: '内容无效' }
    const name = typeof defaultName === 'string' && defaultName ? path.basename(defaultName) : 'report.txt'
    const result = await ctx.dialog.showSaveDialog({
      title: typeof title === 'string' ? title : '保存文件',
      defaultPath: name,
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      await fs.writeFile(result.filePath, content, 'utf8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipc('project:registerRoots', (_event, roots: string[]) => {
    // A 修复：只接受「主进程自持的持久化信任锚」中的项目根（对话框/导入流程写入）——
    // 渲染层无法通过伪造 workspace 数据凭空登记任意目录为项目根
    const saved = ctx.store.get(PROJECT_ROOTS_KEY)
    const known = new Set(
      (Array.isArray(saved) ? saved : [])
        .map((p) => (typeof p === 'string' ? normalizePath(p) : ''))
        .filter(Boolean),
    )
    for (const root of roots) {
      if (typeof root === 'string' && root.length > 0 && known.has(normalizePath(root))) registerRoot(ctx, root)
    }
  })
}
