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
  // M6 安全加固：不随退出自动安装——安装更新是「下载并运行可执行代码」，
  // 必须由用户在界面上明确点击「重启并安装」后才执行，避免退出时静默安装
  autoUpdater.autoInstallOnAppQuit = false

  const emit = (event: UpdateEvent) => {
    const wc = webContents()
    if (wc && !wc.isDestroyed()) wc.send(CHANNEL, event)
  }

  autoUpdater.on('update-available', (info) => {
    hasUpdate = true
    emit({ type: 'update_available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    emit({ type: 'update_not_available', currentVersion: appVersion() })
  })
  autoUpdater.on('download-progress', (progress) => {
    emit({ type: 'download_progress', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    // 下载完成：复位 autoDownload（防止本会话后续 checkForUpdates 静默自动下载）
    autoUpdater.autoDownload = false
    hasUpdate = false
    emit({ type: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    // 下载失败也要复位：否则本会话后续 checkForUpdates 发现新版本时会静默自动下载
    autoUpdater.autoDownload = false
    hasUpdate = false
    emit({ type: 'update_error', message: err?.message ?? String(err) })
  })
}

/** 是否已确认存在新版本（downloadUpdate 的前置条件，防止无新版本时直接下载） */
let hasUpdate = false

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
  hasUpdate = false // 新一轮检查前清掉旧状态（update-available 会重新置 true）
  await autoUpdater.checkForUpdates()
}

/** 开始下载（必须先确认存在新版本，防止无新版本时直接下载） */
export async function downloadUpdate(): Promise<void> {
  if (!isPackaged()) return
  if (!hasUpdate) throw new Error('没有已确认的新版本，请先检查更新')
  autoUpdater.autoDownload = true
  await autoUpdater.downloadUpdate()
}

/** 下载完成后安装并重启 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
