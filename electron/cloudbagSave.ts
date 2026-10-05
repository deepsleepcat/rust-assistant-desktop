import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024

function validatePackage(filename: unknown, bytes: unknown): Buffer {
  // 只接受建议文件名，不接受渲染层指定的路径或 URL。
  if (typeof filename !== 'string' || [...filename].length > 200
    // eslint-disable-next-line no-control-regex -- 拒绝文件名中的控制字符
    || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(filename)
    || !/^.+\.rwmod$/i.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(filename)) {
    throw new Error('云书包文件名无效（仅允许 .rwmod 文件名）')
  }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error('云书包数据无效或超过 50MiB 上限')
  }
  const buffer = Buffer.from(bytes)
  if (buffer.readUInt32LE(0) !== 0x04034b50 && buffer.readUInt32LE(0) !== 0x06054b50) {
    throw new Error('云书包数据不是模组包')
  }
  return buffer
}

function assertTrustedSender(ctx: IpcContext, event: unknown): void {
  const incoming = event as { sender?: unknown; senderFrame?: unknown } | null
  const trusted = ctx.windows.getAllWindows().find((win) => !win.isDestroyed()
    && win.webContents && !win.webContents.isDestroyed() && win.webContents === incoming?.sender)?.webContents
  if (!trusted || incoming?.senderFrame !== trusted.mainFrame || !ctx.cloudbagRendererUrl) {
    throw new Error('云书包保存只允许受信应用窗口主页面调用')
  }
  const expected = new URL(ctx.cloudbagRendererUrl)
  const actual = new URL(trusted.getURL())
  const frameUrl = new URL(trusted.mainFrame.url)
  expected.hash = actual.hash = frameUrl.hash = ''
  if (actual.href !== expected.href || frameUrl.href !== expected.href) {
    throw new Error('云书包保存页面来源不受信任')
  }
}

export function registerCloudbagSaveIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('cloudbag:saveRwmod', async (event: unknown, filename: unknown, bytes: unknown) => {
    assertTrustedSender(ctx, event)
    const buffer = validatePackage(filename, bytes)
    const selected = await ctx.dialog.showSaveDialog({
      title: '保存云书包模组包', defaultPath: filename as string,
      filters: [{ name: '铁锈战争模组包', extensions: ['rwmod'] }],
    })
    if (selected.canceled || !selected.filePath) return { canceled: true as const }
    assertTrustedSender(ctx, event)
    if (path.extname(selected.filePath).toLowerCase() !== '.rwmod') throw new Error('保存文件必须使用 .rwmod 扩展名')
    // 同目录临时文件再替换：失败不留下部分下载，也不截断已有文件。
    const temporary = path.join(path.dirname(selected.filePath), `.cloudbag-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, buffer, { flag: 'wx' })
      await fs.rename(temporary, selected.filePath)
      return { canceled: false as const, filePath: selected.filePath, size: buffer.byteLength }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  })
}
