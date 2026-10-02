/**
 * 打包 Worker：JSZip 压缩在独立线程执行（P3 要求：打包 1 万文件不阻塞界面）。
 * 主线程只负责 walk + 读文件（异步 fs，事件循环让出），压缩重活在此线程。
 */
import JSZip from 'jszip'

export interface PackItem {
  /** 相对路径（正斜杠） */
  path: string
  /** 文件内容（ArrayBuffer，transferable 零拷贝） */
  data: ArrayBuffer
}

export interface PackRequest {
  items: PackItem[]
  /** 已跳过文件数（主线程统计） */
  skipped: number
}

export type PackResponse =
  | { ok: true; buffer: ArrayBuffer; files: number }
  | { ok: false; error: string }

const workerSelf = self as unknown as Worker

workerSelf.onmessage = async (ev: MessageEvent<PackRequest>) => {
  try {
    const zip = new JSZip()
    const { items, skipped } = ev.data
    for (const item of items) {
      zip.file(item.path, new Uint8Array(item.data))
    }
    // type: 'blob' 流式分块；worker 内不阻塞 UI
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    const buffer = await blob.arrayBuffer()
    const resp: PackResponse = { ok: true, buffer, files: items.length + skipped }
    workerSelf.postMessage(resp, { transfer: [buffer] })
  } catch (err) {
    const resp: PackResponse = { ok: false, error: err instanceof Error ? err.message : String(err) }
    workerSelf.postMessage(resp)
  }
}
