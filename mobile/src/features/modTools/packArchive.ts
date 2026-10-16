/**
 * .rwmod 打包的纯逻辑（Worker 与测试共用）。
 *
 * 与 Worker 胶水分开：packWorker.ts 只在 worker 线程注册 onmessage，
 * 这里不依赖 `self`，因此可以在 node/jsdom 里直接调用，验证「导出的包能原样读回」。
 */
import JSZip from 'jszip'

export interface PackItem {
  /** 相对路径（正斜杠） */
  path: string
  /** 文件内容（ArrayBuffer，transferable 零拷贝） */
  data: ArrayBuffer
}

export type PackResponse =
  | { ok: true; buffer: ArrayBuffer; files: number }
  | { ok: false; error: string }

/** Worker 请求体（主线程发来） */
export interface PackRequest {
  items: PackItem[]
  /** 已跳过文件数（主线程统计） */
  skipped: number
}

/** 把项目文件打成 .rwmod（zip）。文件数 = 实际写入数 + 主线程统计的跳过数。 */
export async function buildModArchive(items: readonly PackItem[], skipped = 0): Promise<PackResponse> {
  try {
    const zip = new JSZip()
    for (const item of items) {
      // 字节级写入：文本编码、BOM、换行风格都由调用方决定，这里不做任何转换
      zip.file(item.path, new Uint8Array(item.data))
    }
    // type: 'blob' 分块生成，避免一次性持有大内存
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    const buffer = await blob.arrayBuffer()
    return { ok: true, buffer, files: items.length + skipped }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
