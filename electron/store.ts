/**
 * 极简本地 JSON 存储：整个应用只有一个 JSON 文件（位于 Electron userData 目录），
 * 负责保存设置、工作区（项目列表/对话列表）等。
 * 写入采用「临时文件 + 重命名」的原子替换方式，避免写一半损坏数据。
 */
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export interface JsonStore {
  get(key: string): unknown
  set(key: string, value: unknown): Promise<void>
  /** 首次加载完成（供启动时序：等磁盘数据就绪后再读取） */
  ready(): Promise<void>
  /** 立即把内存数据落盘（应用退出前调用，防止防抖窗口内的写入丢失） */
  flush(): Promise<void>
}

export function createStore(filePath: string): JsonStore {
  let data: Record<string, unknown> = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let loading: Promise<void> | null = null
  let loaded = false
  // L5：串行化写盘——防抖写与 flush 并发时，后发起的写必须等前一次完成，
  // 避免旧快照的 rename 后完成而覆盖新数据
  let writeChain: Promise<void> = Promise.resolve()

  async function load(): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>
      }
    } catch {
      // 文件不存在或损坏：从空数据开始
      data = {}
    }
    loaded = true
  }

  function persist(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void writeNow()
    }, 250)
  }

  async function writeNow(): Promise<void> {
    if (!loaded) return // 加载未完成不落盘（避免把半初始化状态写掉）
    // 排队执行：同一时刻只有一个写盘在途（防抖写与 flush 之间不互相覆盖）
    writeChain = writeChain.then(async () => {
      // L-2：序列化也可能抛错（循环引用/BigInt 等不可序列化值）——必须捕获，
      // 否则写链永久 reject，后续所有持久化静默失效
      let snapshot: string
      try {
        snapshot = JSON.stringify(data, null, 2)
      } catch (err) {
        console.error('[store] 序列化失败:', err)
        return
      }
      const tmp = `${filePath}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, snapshot, 'utf8')
        await fs.rename(tmp, filePath)
      } catch (err) {
        console.error('[store] 保存失败:', err)
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    })
    await writeChain
  }

  loading = load()

  return {
    get(key: string): unknown {
      void loading
      return data[key]
    },
    async set(key: string, value: unknown): Promise<void> {
      // 等待首次加载完成再写入：否则加载完成时的整体替换会把这条新写入丢弃
      if (!loaded && loading) await loading
      // 序列化预检：不可序列化的值（循环引用/BigInt 等）拒绝写入，
      // 避免单个坏值让整个 JSON 落盘失败、拖垮所有持久化
      try {
        JSON.stringify(value)
      } catch (err) {
        console.error('[store] 拒绝写入不可序列化的值:', err)
        return
      }
      data[key] = value
      persist()
    },
    async ready(): Promise<void> {
      if (!loaded && loading) await loading
    },
    async flush(): Promise<void> {
      // 取消防抖，立即落盘（退出前调用；写失败不阻塞退出）
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await writeNow().catch(() => undefined)
    },
  }
}
