/**
 * M6 自动更新：基于 electron-updater，更新包托管在 GitHub Releases（免费）。
 *
 * - 只在生产环境（打包后的安装版）运行；dev 模式下跳过检查
 * - 事件通过 webContents.send 推给界面（设置 → 关于 里展示状态）
 * - nsis 安装版支持自动更新；portable 版不支持（打包配置里 nsis 优先）
 */
import { autoUpdater } from 'electron-updater'
import type { WebContents } from 'electron'
import type { UpdateEvent } from '../src/types/ai'

export type { UpdateEvent }

const CHANNEL = 'app:update'

/** 把 updater 事件转成 UpdateEvent 并推送给窗口 */
export function setupUpdater(webContents: () => WebContents | null): void {
  autoUpdater.autoDownload = false // 先只提示，用户点按钮再下载
  autoUpdater.autoInstallOnAppQuit = true

  const emit = (event: UpdateEvent) => {
    const wc = webContents()
    if (wc && !wc.isDestroyed()) wc.send(CHANNEL, event)
  }

  autoUpdater.on('update-available', (info) => {
    emit({ type: 'update_available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    emit({ type: 'update_not_available', currentVersion: appVersion() })
  })
  autoUpdater.on('download-progress', (progress) => {
    emit({ type: 'download_progress', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    emit({ type: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    emit({ type: 'update_error', message: err?.message ?? String(err) })
  })
}

function appVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron').app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** 是否处于打包后的生产环境（自动更新只在这里生效） */
export function isPackaged(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron').app.isPackaged
  } catch {
    return false
  }
}

/** 检查更新（仅生产环境；dev 模式由调用方提示跳过） */
export async function checkForUpdates(): Promise<void> {
  if (!isPackaged()) return
  await autoUpdater.checkForUpdates()
}

/** 开始下载（调用前须先确认有新版本） */
export async function downloadUpdate(): Promise<void> {
  if (!isPackaged()) return
  autoUpdater.autoDownload = true
  await autoUpdater.downloadUpdate()
}

/** 下载完成后安装并重启 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
