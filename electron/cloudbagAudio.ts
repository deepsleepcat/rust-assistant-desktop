/** 云书包上传专用 WAV 读取：只在临时目录转码，项目源文件始终只读。 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { findFfmpeg } from './modCreate'
import { CLOUD_BAG_MAX_UPLOAD_BYTES } from './cloudbagTree'
import { requireRealInsideRoot } from './projectTrust'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'

function assertWithinCap(size: number): void {
  if (size > CLOUD_BAG_MAX_UPLOAD_BYTES) throw new Error('云书包音频超过 50MiB 限制')
}

function isWave(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
}

async function prepareWav(source: Buffer): Promise<Buffer> {
  // 真实 WAV 和其它非 MP4 容器保持原样；只修复扩展名伪装的 ISO BMFF（MP4/M4A）。
  if (isWave(source) || source.length < 12 || source.toString('ascii', 4, 8) !== 'ftyp') return source
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法将伪 WAV 转为 WAV')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmytx-cloudbag-wav-'))
  const input = path.join(dir, 'source.m4a')
  const output = path.join(dir, 'upload.wav')
  try {
    // 给 ffmpeg 私有快照，避免它再次读取项目路径或改写源文件。
    await fs.writeFile(input, source, { flag: 'wx' })
    await new Promise<void>((resolve, reject) => {
      execFile(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-protocol_whitelist', 'file', '-f', 'mov', '-i', input,
        '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact',
        '-f', 'wav', '-fs', String(CLOUD_BAG_MAX_UPLOAD_BYTES + 1), output,
      ], { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error) => {
        if (error) reject(new Error(`伪 WAV 转码失败：${error.message}`))
        else resolve()
      })
    })
    assertWithinCap((await fs.stat(output)).size)
    const converted = await fs.readFile(output)
    assertWithinCap(converted.byteLength)
    if (!isWave(converted)) throw new Error('伪 WAV 转码失败：输出不是 RIFF/WAVE')
    return converted
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

export function registerCloudbagAudioIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('cloudbag:readWavForUpload', async (_event, rootPath: unknown, filePath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath || typeof filePath !== 'string' || !filePath) {
      throw new Error('云书包音频路径无效')
    }
    await requireRealInsideRoot(ctx, rootPath, filePath)
    if (path.extname(filePath).toLowerCase() !== '.wav') throw new Error('此入口只允许读取 .wav 文件')
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error('云书包音频必须是普通文件')
    assertWithinCap(stat.size)
    const source = await fs.readFile(filePath)
    assertWithinCap(source.byteLength)
    const prepared = await prepareWav(source)
    // 按原始读取桥的安全模式只返回精确 ArrayBuffer，绝不经 JSON 发送 Buffer 或池内无关内存。
    const bytes = prepared.buffer.slice(prepared.byteOffset, prepared.byteOffset + prepared.byteLength)
    return { bytes, size: prepared.byteLength }
  })
}
