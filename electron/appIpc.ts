/**
 * 应用信息/更新/退出确认 IPC（M40 巨型文件拆分批次 B2）。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

/** 应用信息 / 更新 / 头像 */
export function registerAppIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('app:info', () => ({ version: ctx.app.getVersion(), platform: process.platform }))

  // 渲染层完成退出前落盘后的确认：
  // - before-quit 路径：resolve 等待（before-quit 流程随后 flush + quit）
  // - 窗口 close 路径：销毁窗口进入正常退出流程
  ipc('app:flush-done', () => {
    if (ctx.lifecycle.flushResolve) {
      if (ctx.lifecycle.flushConfirmTimer) clearTimeout(ctx.lifecycle.flushConfirmTimer)
      const r = ctx.lifecycle.flushResolve
      ctx.lifecycle.flushResolve = null
      r()
      return true
    }
    // 没有待确认的退出流程时，渲染层不能凭空销毁主窗口。
    return false
  })

  // ===== M6 自动更新（更新包托管在 GitHub Releases）=====
  // 事件统一推送到 'app:update' 通道；dev 模式下检查会返回提示
  ipc('app:checkUpdate', async () => {
    if (!ctx.updater.isPackaged()) {
      return { skipped: true, message: '开发模式不检查更新' }
    }
    await ctx.updater.checkForUpdates()
    return { skipped: false }
  })
  ipc('app:downloadUpdate', async () => {
    if (!ctx.updater.isPackaged()) return { skipped: true }
    await ctx.updater.downloadUpdate()
    return { skipped: false }
  })
  ipc('app:installUpdate', async () => {
    // L3：退出流程已在进行（双击「重启并安装」）时忽略，避免截断在途的落盘写入
    if (ctx.lifecycle.quitting) return false
    // 安装=下载并执行新代码：渲染层被 XSS 后可静默触发 IPC，这里由主进程
    // 弹系统确认框（对话框不可被渲染层伪造），用户点「重启并安装」才执行
    const { response } = await ctx.dialog.showMessageBox({
      type: 'question',
      title: '重启并安装更新',
      message: '更新已下载完成，是否立即重启并安装？',
      detail: '安装期间应用会短暂退出，未保存的修改会先自动保存。',
      buttons: ['稍后再说', '重启并安装'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (response !== 1) return false
    ctx.updater.quitAndInstall()
    return true
  })

}
