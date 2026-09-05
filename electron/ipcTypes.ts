/**
 * IPC 类型层（M40 巨型文件拆分批次 B1）：
 * 只放跨域共享的注册函数类型；域文件从这里导入，绝不从聚合入口 ./ipc 导入
 * （防止域文件 → ipc.ts → 域文件的隐性循环）。
 */

/** IPC 注册函数：main.ts 传 ipcMain.handle 的真实绑定；测试传记录用假实现 */
export type RegisterHandler = (channel: string, handler: (...args: never[]) => unknown) => void
