/**
 * 极简本地 JSON 存储：整个应用只有一个 JSON 文件（位于 Electron userData 目录），
 * 负责保存设置、工作区（项目列表/对话列表）等。
 * 写入采用「临时文件 + 重命名」的原子替换方式，避免写一半损坏数据。
 */
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export interface JsonStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export function createStore(filePath: string): JsonStore {
  let data: Record<string, unknown> = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let loading: Promise<void> | null = null

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
  }

  function persist(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void (async () => {
        const tmp = `${filePath}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
          await fs.rename(tmp, filePath)
        } catch (err) {
          console.error('[store] 保存失败:', err)
          await fs.rm(tmp, { force: true }).catch(() => undefined)
        }
      })()
    }, 250)
  }

  loading = load()

  return {
    get(key: string): unknown {
      void loading
      return data[key]
    },
    set(key: string, value: unknown): void {
      data[key] = value
      persist()
    },
  }
}
