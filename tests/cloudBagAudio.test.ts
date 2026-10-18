import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { registerCloudbagAudioIpc } from '../electron/cloudbagAudio'
import { findFfmpeg } from '../electron/modCreate'
import { normalizePath } from '../electron/paths'
import { CLOUD_BAG_MAX_UPLOAD_BYTES } from '../electron/cloudbagTree'
import type { IpcContext } from '../electron/ipcContext'
import type { BridgeApi } from '../src/types/bridge'
import type { CloudBagApi } from '../src/services/cloudBagApi'
import { pushLocalTree } from '../src/services/cloudBagSync'
import { readLocalFileBytes, scanLocalTree } from '../src/services/cloudBagTreeState'

vi.mock('../electron/modCreate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/modCreate')>()
  return { ...actual, findFfmpeg: vi.fn(actual.findFfmpeg) }
})

const run = promisify(execFile)
let ffmpeg: string
let m4a: Buffer
let wave: Buffer
let tmp: string
let root: string
let file: string
let ctx: IpcContext
let read: (rootPath: unknown, filePath: unknown) => Promise<{ bytes: ArrayBuffer; size: number }>

beforeAll(async () => {
  const executable = await findFfmpeg()
  if (!executable) throw new Error('本测试需要项目依赖 ffmpeg-static')
  ffmpeg = executable
  const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-audio-fixtures-'))
  try {
    const audio = path.join(fixtures, 'tone.m4a')
    const wav = path.join(fixtures, 'tone.wav')
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.05', '-c:a', 'aac', audio])
    await run(ffmpeg, ['-y', '-i', audio, '-c:a', 'pcm_s16le', wav])
    m4a = await fs.readFile(audio)
    wave = await fs.readFile(wav)
  } finally {
    await fs.rm(fixtures, { recursive: true, force: true })
  }
}, 20_000)

beforeEach(async () => {
  vi.mocked(findFfmpeg).mockReset().mockResolvedValue(ffmpeg)
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-cloudbag-audio-'))
  root = path.join(tmp, 'project')
  await fs.mkdir(root)
  file = path.join(root, 'tone.WAV')
  ctx = { roots: new Set([normalizePath(root)]) } as IpcContext
  registerCloudbagAudioIpc(ctx, (channel, handler) => {
    expect(channel).toBe('cloudbag:readWavForUpload')
    read = (rootPath, filePath) => handler(undefined as never, rootPath as never, filePath as never) as ReturnType<typeof read>
  })
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

function bridgeForFile() {
  return {
    cloudbag: { readWavForUpload: vi.fn(read) },
    project: {
      stat: async (_root: string, target: string) => fs.stat(target),
      readAudioAsDataUrl: vi.fn(async () => { throw new Error('WAV 不得回退预览原字节') }),
    },
    mod: { scanResources: async () => ({ files: ['tone.WAV'], unitNames: [] }) },
  } as unknown as BridgeApi
}

function apiForUpload() {
  return {
    openSession: vi.fn(async () => ({ id: 'session-1' })),
    uploadBlob: vi.fn(async (_slug: string, _input: { bytes: ArrayBuffer; sha256: string }) => undefined),
    pushVersion: vi.fn(async () => ({ versionNo: 2 })),
  }
}

function push(bridge: BridgeApi, api: ReturnType<typeof apiForUpload>) {
  return pushLocalTree({ bridge, api: api as unknown as CloudBagApi, rootPath: root, repoSlug: 'repo',
    onProgress: () => undefined, isAborted: () => false }, { baseVersionNo: 1, message: 'audio' })
}

const hash = (bytes: ArrayBuffer) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

describe('云书包受限 WAV 上传准备（真实 FFmpeg）', () => {
  it('真实 RIFF/WAVE 原样返回精确 ArrayBuffer，不查找 ffmpeg、不改源文件', async () => {
    await fs.writeFile(file, wave)
    const result = await read(root, file)
    expect(result.bytes).toBeInstanceOf(ArrayBuffer)
    expect(Buffer.isBuffer(result.bytes)).toBe(false)
    expect(result.size).toBe(wave.length)
    expect(result.bytes.byteLength).toBe(wave.length)
    expect(Buffer.from(result.bytes)).toEqual(wave)
    expect(findFfmpeg).not.toHaveBeenCalled()
    expect(await fs.readFile(file)).toEqual(wave)
  })

  it('ftyp/mp42 伪 WAV 转出可解码 RIFF，重复读取 hash 稳定，源文件和目录不变', async () => {
    const mp42 = Buffer.from(m4a)
    mp42.write('mp42', 8, 'ascii')
    await fs.writeFile(file, mp42)
    const before = await fs.stat(file)
    const first = await read(root, file)
    const second = await read(root, file)
    expect(Buffer.from(first.bytes).toString('ascii', 0, 4)).toBe('RIFF')
    expect(Buffer.from(first.bytes).toString('ascii', 8, 12)).toBe('WAVE')
    expect(hash(first.bytes)).toBe(hash(second.bytes))
    expect(Buffer.from(first.bytes)).not.toEqual(mp42)
    const decoded = path.join(tmp, 'decoded.wav')
    await fs.writeFile(decoded, Buffer.from(first.bytes))
    await expect(run(ffmpeg, ['-v', 'error', '-i', decoded, '-f', 'null', '-'])).resolves.toBeDefined()
    expect(await fs.readFile(file)).toEqual(mp42)
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
    expect(await fs.readdir(root)).toEqual(['tone.WAV'])
  })

  it('扫描、上传两趟和哈希重读都提交转码字节，重开树摘要一致', async () => {
    await fs.writeFile(file, m4a)
    const bridge = bridgeForFile()
    const api = apiForUpload()
    api.uploadBlob.mockImplementationOnce(async () => { throw Object.assign(new Error('rehash'), { kind: 'object_hash_mismatch' }) })
    const outcome = await push(bridge, api)
    expect(outcome.status).toBe('pushed')
    expect(bridge.cloudbag!.readWavForUpload).toHaveBeenCalledTimes(3)
    expect(bridge.project.readAudioAsDataUrl).not.toHaveBeenCalled()
    for (const [, input] of api.uploadBlob.mock.calls) {
      expect(Buffer.from(input.bytes).toString('ascii', 0, 4)).toBe('RIFF')
      expect(input.sha256).toBe(hash(input.bytes))
      expect(outcome.localTree).toEqual([{ path: 'tone.WAV', sha256: input.sha256 }])
    }
    const reopened = await scanLocalTree(bridge, root)
    expect(reopened?.digest).toBe(outcome.treeDigest)
    expect(await fs.readFile(file)).toEqual(m4a)
  })

  it.each(['missing', 'broken'] as const)('ffmpeg %s 时不上传伪 WAV、不创建版本', async (failure) => {
    await fs.writeFile(file, m4a)
    vi.mocked(findFfmpeg).mockResolvedValue(failure === 'missing' ? null : path.join(tmp, 'missing-ffmpeg.exe'))
    const bridge = bridgeForFile()
    const api = apiForUpload()
    const outcome = await push(bridge, api)
    expect(outcome.status).toBe('failed')
    expect(outcome.skippedBinary[0]).toMatch(/ffmpeg|转码失败/)
    expect(api.openSession).not.toHaveBeenCalled()
    expect(api.uploadBlob).not.toHaveBeenCalled()
    expect(api.pushVersion).not.toHaveBeenCalled()
    expect(bridge.project.readAudioAsDataUrl).not.toHaveBeenCalled()
    expect(await fs.readFile(file)).toEqual(m4a)
  })

  it('第二趟转码失败也不上传或提交，缺少新桥时不能退回伪 WAV', async () => {
    await fs.writeFile(file, m4a)
    const bridge = bridgeForFile()
    const api = apiForUpload()
    api.openSession.mockImplementationOnce(async () => {
      vi.mocked(findFfmpeg).mockResolvedValue(null)
      return { id: 'session-1' }
    })
    const outcome = await push(bridge, api)
    expect(outcome.status).toBe('failed')
    expect(outcome.skippedBinary[0]).toContain('ffmpeg')
    expect(api.uploadBlob).not.toHaveBeenCalled()
    expect(api.pushVersion).not.toHaveBeenCalled()
    delete bridge.cloudbag
    await expect(readLocalFileBytes(bridge, root, 'tone.WAV')).rejects.toThrow('缺少 WAV 上传准备通道')
  })

  it('损坏 ftyp 输入失败后删除临时快照', async () => {
    await fs.writeFile(file, Buffer.from('0000ftypmp42broken'))
    // 临时目录由主进程独占；用 mkdtemp 的返回值定位并验证 finally 清理。
    const mkdtemp = vi.spyOn(fs, 'mkdtemp')
    try {
      await expect(read(root, file)).rejects.toThrow('转码失败')
      const dir = await mkdtemp.mock.results[0].value as string
      await expect(fs.stat(dir)).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe('0000ftypmp42broken')
    } finally {
      mkdtemp.mockRestore()
    }
  })

  it('转码输出膨胀超过 50MiB 时拒绝并清理临时文件', async () => {
    // AAC 静音体积很小，展开为单声道 44.1kHz PCM 后超过 50MiB。
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '600', '-c:a', 'aac', '-f', 'mp4', file])
    const original = await fs.readFile(file)
    await expect(read(root, file)).rejects.toThrow('超过 50MiB')
    expect(await fs.readFile(file)).toEqual(original)
  }, 30_000)
})

describe('cloudbag:readWavForUpload IPC 边界', () => {
  it('拒绝非字符串、未登记根、词法越界、非 WAV 和目录', async () => {
    await fs.writeFile(file, wave)
    await expect(read(null, file)).rejects.toThrow('路径无效')
    await expect(read(root, new ArrayBuffer(8))).rejects.toThrow('路径无效')
    await expect(read(tmp, file)).rejects.toThrow('未登记')
    await expect(read(root, path.join(root, '..', 'outside.wav'))).rejects.toThrow('超出项目')
    await expect(read(root, path.join(root, 'tone.mp3'))).rejects.toThrow('只允许读取 .wav')
    const dir = path.join(root, 'folder.wav')
    await fs.mkdir(dir)
    await expect(read(root, dir)).rejects.toThrow('普通文件')
    expect(findFfmpeg).not.toHaveBeenCalled()
  })

  it('拒绝项目内指向根外目录的 junction', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.wav'), wave)
    const link = path.join(root, 'escape')
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(read(root, path.join(link, 'secret.wav'))).rejects.toThrow(/链接|越界|外/)
    expect(findFfmpeg).not.toHaveBeenCalled()
  })

  it('输入 stat 超限直接拒绝', async () => {
    await fs.writeFile(file, wave)
    await fs.truncate(file, CLOUD_BAG_MAX_UPLOAD_BYTES + 1)
    await expect(read(root, file)).rejects.toThrow('超过 50MiB')
    expect(findFfmpeg).not.toHaveBeenCalled()
  })
})
