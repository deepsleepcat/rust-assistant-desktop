/**
 * 打包 Worker：JSZip 压缩在独立线程执行（P3 要求：打包 1 万文件不阻塞界面）。
 * 主线程只负责 walk + 读文件（异步 fs，事件循环让出），压缩重活在此线程。
 * 压缩本身在 packArchive.ts（纯逻辑，可被测试直接调用）。
 */
import { buildModArchive, type PackRequest } from './packArchive'

const workerSelf = self as unknown as Worker

workerSelf.onmessage = async (ev: MessageEvent<PackRequest>) => {
  const resp = await buildModArchive(ev.data.items, ev.data.skipped)
  if (resp.ok) workerSelf.postMessage(resp, { transfer: [resp.buffer] })
  else workerSelf.postMessage(resp)
}
