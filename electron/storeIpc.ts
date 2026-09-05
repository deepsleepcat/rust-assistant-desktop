/**
 * 本地状态存储 IPC（M40 巨型文件拆分批次 B2）：
 * store:get / store:set —— 保留键与大小上限由主进程强制执行。
 */
import { COMMUNITY_AUTH_CREDENTIAL_KEY, DEEPSEEK_CREDENTIAL_KEY } from './secureCredentials'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { MEDIA_ALLOWLIST_KEY, MEDIA_MIGRATED_KEY } from './mediaPolicy'
import { ANCHOR_MIGRATED_KEY, PROJECT_ROOTS_KEY } from './projectTrust'

/** 只能由主进程持有的存储键。凭据本身已加密，但也不向渲染层暴露密文。 */
const MAIN_PROCESS_ONLY_STORE_KEYS = new Set([
  MEDIA_ALLOWLIST_KEY,
  PROJECT_ROOTS_KEY,
  ANCHOR_MIGRATED_KEY,
  MEDIA_MIGRATED_KEY,
  COMMUNITY_AUTH_CREDENTIAL_KEY,
  DEEPSEEK_CREDENTIAL_KEY,
])

/** 本地状态存储：store:get / store:set（保留键与大小上限由主进程强制执行） */
export function registerStoreIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('store:get', (_event, key: string) => {
    if (typeof key !== 'string') throw new Error('存储键无效')
    if (MAIN_PROCESS_ONLY_STORE_KEYS.has(key)) throw new Error('不允许读取系统保留键')
    return ctx.store.get(key)
  })

  ipc('store:set', async (_event, key: string, value: unknown) => {
    // A 修复：主进程自有信任锚键（媒体允许集合/项目根集合/迁移标志）不允许渲染层写入，防伪造
    if (typeof key !== 'string' || MAIN_PROCESS_ONLY_STORE_KEYS.has(key)) {
      throw new Error('不允许写入系统保留键')
    }
    // M 修复：store 值大小上限，防止渲染层用超大值填满磁盘/拖垮序列化。
    // workspace 键含全部对话历史（长期使用可达数十 MB），上限放宽到 50MB；
    // 其余键（settings 等）10MB
    let size = 0
    const approx = (v: unknown): void => {
      if (typeof v === 'string') size += v.length
      else if (typeof v === 'number' || typeof v === 'boolean') size += 8
      else if (v === null || v === undefined) size += 0
      else if (Array.isArray(v)) for (const x of v) approx(x)
      else if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) approx(x)
    }
    approx(value)
    const limit = key === 'workspace' ? 50 * 1024 * 1024 : 10 * 1024 * 1024
    if (size > limit) throw new Error(`写入的数据过大（超过 ${Math.round(limit / 1024 / 1024)}MB），已拒绝保存`)
    // L-10：媒体信任只来自对话框/自写文件（见 addAllowedMedia），
    // 设置路径的恢复在启动时由 restoreMediaAllowlist + registerMediaFromSettings 完成
    await ctx.store.set(key, value)
  })
}
