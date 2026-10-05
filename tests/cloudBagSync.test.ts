/**
 * 云书包手动同步编排回归（桌面契约 §6.4/§10）：
 * - 推送全链路（假桥 + 假 API）：会话 → 逐文件 blob → 原子建版本，请求形状符合契约
 * - 冲突分支：version_conflict 返回 conflict 结果（head 摘要）而非抛错
 * - 取消：文件粒度协作式中止
 * - 拉取：走 cloudbag:restore 桥（备份/回滚在主进程测试中覆盖）
 * - 幂等：client_op_id 每次推送生成唯一键
 */
import { describe, expect, it, vi } from 'vitest'
import { pushLocalTree, pullRemoteVersion, readCloudBagAnchor, readCloudBagAnchorSnapshot, migrateCloudBagAnchor, judgeLocalChanged, listLocalChanges, writeCloudBagAnchor, importTreeToNewRepo, isCloudBagInternalPath, type SyncHost } from '../src/services/cloudBagSync'
import type { CloudBagApi, CloudBagApiError, CloudBagHeadSummary, CloudBagRepo } from '../src/services/cloudBagApi'
import type { BridgeApi } from '../src/types/bridge'

function textBridge(files: Record<string, string>): BridgeApi {
  return {
    project: {
      readFile: async (_root: string, abs: string) => {
        const rel = abs.split(/[\\/]/).slice(-2).join('/')
        const hit = Object.entries(files).find(([key]) => abs.replace(/\\/g, '/').endsWith(key))
        if (!hit) throw new Error('ENOENT')
        void rel
        return { content: hit[1], hasBom: false, mtimeMs: 0, size: hit[1].length }
      },
      // 与 fs:readFileBytes 同形：文本候选一律走原始字节
      readFileBytes: async (_root: string, abs: string) => {
        const hit = Object.entries(files).find(([key]) => abs.replace(/\\/g, '/').endsWith(key))
        if (!hit) throw new Error('ENOENT')
        const bytes = new TextEncoder().encode(hit[1])
        return { bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }
      },
      writeFile: vi.fn(async () => undefined),
      writeAnchor: vi.fn(async (_root: string, _abs: string, _content: string, expectedContent: string | null) => ({ written: expectedContent === null })),
      createFolder: vi.fn(async () => undefined),
      stat: async () => ({ mtimeMs: 0, size: 10 }),
    },
    mod: {
      scanResources: async () => ({ files: Object.keys(files), unitNames: [] }),
    },
    git: {
      status: async () => [],
    },
  } as unknown as BridgeApi
}

function fakeApi(overrides: Partial<CloudBagApi> = {}, calls: Array<{ path: string; body: unknown }> = []): CloudBagApi {
  return {
    openSession: async (slug, input) => {
      calls.push({ path: `/repos/${slug}/sessions`, body: input })
      return { id: 'sess-1', status: 'open', files: [] }
    },
    uploadBlob: async (slug, input) => {
      calls.push({ path: `/repos/${slug}/blobs`, body: { sessionId: input.sessionId, sha256: input.sha256, path: input.path } })
    },
    pushVersion: async (slug, input) => {
      calls.push({ path: `/repos/${slug}/versions`, body: input })
      return { versionNo: 4 }
    },
    exportRwmod: async () => ({ bytes: new Uint8Array([1]).buffer, filename: 'a.rwmod', contentType: 'application/octet-stream' }),
    ...overrides,
  } as CloudBagApi
}

function host(bridge: BridgeApi, api: CloudBagApi, isAborted = () => false): SyncHost {
  return { api, bridge, rootPath: 'C:\\proj', repoSlug: 'iron-curtain', onProgress: () => undefined, isAborted }
}

describe('pushLocalTree（推送全链路）', () => {
  it('本地 simple-lower 路径键冲突：开会话和上传前拒绝，要求重命名', async () => {
    const openSession = vi.fn()
    const uploadBlob = vi.fn()
    const outcome = await pushLocalTree(host(textBridge({ 'İ.ini': 'one', 'i.ini': 'two' }), fakeApi({ openSession, uploadBlob })), { message: '更新', baseVersionNo: 3 })
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringContaining('路径键冲突') })
    expect(openSession).not.toHaveBeenCalled()
    expect(uploadBlob).not.toHaveBeenCalled()
  })

  it('最后一次上传在途取消：返回 aborted 且不提交版本', async () => {
    let aborted = false
    const pushVersion = vi.fn(async () => ({ versionNo: 4 }))
    const api = fakeApi({ uploadBlob: async () => { aborted = true }, pushVersion })
    const outcome = await pushLocalTree(host(textBridge({ 'tank.ini': '[core]' }), api, () => aborted), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('aborted')
    expect(pushVersion).not.toHaveBeenCalled()
  })

  it('committing 通知触发取消：请求发出前仍可中止', async () => {
    let aborted = false
    const pushVersion = vi.fn(async () => ({ versionNo: 4 }))
    const syncHost = host(textBridge({ 'tank.ini': '[core]' }), fakeApi({ pushVersion }), () => aborted)
    syncHost.onProgress = (progress) => { if (progress.phase === 'committing') aborted = true }
    expect((await pushLocalTree(syncHost, { message: '更新', baseVersionNo: 3 })).status).toBe('aborted')
    expect(pushVersion).not.toHaveBeenCalled()
  })

  it('提交发出后取消：返回真实版本结果而非 aborted', async () => {
    let aborted = false
    const api = fakeApi({ pushVersion: async () => { aborted = true; return { versionNo: 4 } } })
    const outcome = await pushLocalTree(host(textBridge({ 'tank.ini': '[core]' }), api, () => aborted), { message: '更新', baseVersionNo: 3 })
    expect(outcome).toMatchObject({ status: 'pushed', versionNo: 4 })
  })

  it('会话 → 逐文件 blob（sha256 去重形状）→ 原子建版本，白名单外二进制跳过', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const bridge = textBridge({ 'mod-info.txt': '[mod]\ntitle: t\n', 'units/tank.ini': '[core]\n', 'data.bin': 'x' })
    const outcome = await pushLocalTree(host(bridge, api), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.versionNo).toBe(4)
    expect(outcome.uploaded.sort()).toEqual(['mod-info.txt', 'units/tank.ini'])
    expect(outcome.skippedBinary.some((item) => item.startsWith('data.bin'))).toBe(true)
    expect(calls.map((call) => call.path)).toEqual([
      '/repos/iron-curtain/sessions',
      '/repos/iron-curtain/blobs',
      '/repos/iron-curtain/blobs',
      '/repos/iron-curtain/versions',
    ])
    const session = calls[0].body as { opType: string; baseVersionNo: number }
    expect(session).toMatchObject({ opType: 'push', baseVersionNo: 3 })
    const version = calls[3].body as { message: string; clientOpId: string; files: unknown[] }
    expect(version.message).toBe('更新')
    expect(version.clientOpId).toBeTruthy()
    expect(version.files).toHaveLength(2)
  })

  it('冲突分支：api 抛 version_conflict（含 head 摘要）→ 返回 conflict 结果而非抛错', async () => {
    const head: CloudBagHeadSummary = {
      headVersionNo: 5,
      headSummary: {
        versionNo: 5, message: '远端版本', fileCount: 1, totalSize: 12,
        files: [{ path: 'units/tank.ini', sha256: 'a'.repeat(64) }],
      },
    }
    const conflictError = Object.assign(new Error('远端已有新版本，请先查看差异再选择合并方式'), {
      kind: 'version_conflict', conflict: head,
    }) as unknown as CloudBagApiError
    const api = fakeApi({ pushVersion: async () => { throw conflictError } })
    const bridge = textBridge({ 'units/tank.ini': '[core]\n' })
    const outcome = await pushLocalTree(host(bridge, api), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('conflict')
    expect(outcome.conflict).toEqual(head)
    expect(outcome.uploaded).toEqual(['units/tank.ini'])
  })

  it('内存：逐文件两趟读取（哈希 + 上传各一次），整批字节不随 prepared 常驻', async () => {
    const files: Record<string, string> = { 'units/a.ini': 'AA', 'units/b.ini': 'BB' }
    let reads = 0
    const bridge = {
      project: {
        readFileBytes: async (_root: string, abs: string) => {
          reads += 1
          const hit = Object.entries(files).find(([key]) => abs.replace(/\\/g, '/').endsWith(key))
          if (!hit) throw new Error('ENOENT')
          const bytes = new TextEncoder().encode(hit[1])
          return { bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }
        },
        writeFile: vi.fn(async () => undefined),
        writeAnchor: vi.fn(async () => ({ written: true })),
        createFolder: vi.fn(async () => undefined),
        stat: async () => ({ mtimeMs: 0, size: 10 }),
      },
      mod: { scanResources: async () => ({ files: Object.keys(files), unitNames: [] }) },
      git: { status: async () => [] },
    } as unknown as BridgeApi
    const uploaded: string[] = []
    const api = fakeApi({ uploadBlob: async (_slug, input) => { uploaded.push(input.path) } })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect([...uploaded].sort()).toEqual(['units/a.ini', 'units/b.ini'])
    // 每个文件被读两次：哈希一趟 + 上传一趟——上传阶段重读而非依赖整批常驻字节。
    expect(reads).toBe(4)
  })

  it('第二趟读取失败与第一趟同口径：计入 skipped、整推仍成功且提交清单不含该文件', async () => {
    const files: Record<string, string> = { 'units/a.ini': 'AA', 'units/b.ini': 'BB' }
    const reads: Record<string, number> = {}
    const bridge = {
      project: {
        readFileBytes: async (_root: string, abs: string) => {
          const key = Object.keys(files).find((candidate) => abs.replace(/\\/g, '/').endsWith(candidate))!
          reads[key] = (reads[key] ?? 0) + 1
          // b.ini 第一趟可读，第二趟（发布期间）不可读
          if (key === 'units/b.ini' && reads[key] >= 2) throw new Error('deleted mid-push')
          const bytes = new TextEncoder().encode(files[key])
          return { bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }
        },
        writeFile: vi.fn(async () => undefined),
        writeAnchor: vi.fn(async () => ({ written: true })),
        createFolder: vi.fn(async () => undefined),
        stat: async () => ({ mtimeMs: 0, size: 10 }),
      },
      mod: { scanResources: async () => ({ files: Object.keys(files), unitNames: [] }) },
      git: { status: async () => [] },
    } as unknown as BridgeApi
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded).toEqual(['units/a.ini'])
    expect(outcome.skippedBinary.some((item) => item.startsWith('units/b.ini'))).toBe(true)
    const versionCall = calls.find((call) => call.path.endsWith('/versions'))
    expect((versionCall?.body as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['units/a.ini'])
  })

  it('object_hash_mismatch（文件在哈希后被改动）：重读重算 sha 后重试成功，不整推中止', async () => {
    const contents: Record<string, string[]> = { 'units/a.ini': ['AA'], 'units/b.ini': ['BB', 'B2'] }
    const reads: Record<string, number> = {}
    const bridge = {
      project: {
        readFileBytes: async (_root: string, abs: string) => {
          const key = Object.keys(contents).find((candidate) => abs.replace(/\\/g, '/').endsWith(candidate))!
          reads[key] = (reads[key] ?? 0) + 1
          const list = contents[key]
          const content = list[Math.min(reads[key] - 1, list.length - 1)]
          const bytes = new TextEncoder().encode(content)
          return { bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }
        },
        writeFile: vi.fn(async () => undefined),
        writeAnchor: vi.fn(async () => ({ written: true })),
        createFolder: vi.fn(async () => undefined),
        stat: async () => ({ mtimeMs: 0, size: 10 }),
      },
      mod: { scanResources: async () => ({ files: Object.keys(contents), unitNames: [] }) },
      git: { status: async () => [] },
    } as unknown as BridgeApi
    const blobs: Array<{ path: string; sha256: string }> = []
    let bAttempts = 0
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({
      uploadBlob: async (_slug, input) => {
        blobs.push({ path: input.path, sha256: input.sha256 })
        // 第一次用旧 sha 上传改动后的内容 → 服务端 object_hash_mismatch；重算 sha 后应成功
        if (input.path === 'units/b.ini' && ++bAttempts === 1) {
          throw Object.assign(new Error('hash mismatch'), { kind: 'object_hash_mismatch' })
        }
      },
    }, calls)
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    const bBlobs = blobs.filter((item) => item.path === 'units/b.ini')
    expect(bBlobs).toHaveLength(2)
    expect(bBlobs[1].sha256).not.toBe(bBlobs[0].sha256)
    const versionCall = calls.find((call) => call.path.endsWith('/versions'))
    const files = (versionCall?.body as { files: Array<{ path: string; sha256: string }> }).files
    expect(files.find((file) => file.path === 'units/b.ini')?.sha256).toBe(bBlobs[1].sha256)
  })

  it('object_hash_mismatch 持续不一致：计入 skipped 并继续，整推仍成功（不盲目 3 次重传）', async () => {
    const files: Record<string, string> = { 'units/a.ini': 'AA', 'units/b.ini': 'BB' }
    const calls: Array<{ path: string; body: unknown }> = []
    let bAttempts = 0
    const api = fakeApi({
      uploadBlob: async (_slug, input) => {
        if (input.path === 'units/b.ini') {
          bAttempts += 1
          throw Object.assign(new Error('hash mismatch'), { kind: 'object_hash_mismatch' })
        }
      },
    }, calls)
    const outcome = await pushLocalTree(host(textBridge(files), api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded).toEqual(['units/a.ini'])
    expect(outcome.skippedBinary.some((item) => item.startsWith('units/b.ini'))).toBe(true)
    // 确定性失败不再盲重试满 3 次：首次 + 重读重算后一次后即放弃
    expect(bAttempts).toBe(2)
    const versionCall = calls.find((call) => call.path.endsWith('/versions'))
    expect((versionCall?.body as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['units/a.ini'])
  })

  it('object_hash_mismatch 重读后文件跨过 50MiB：计入 oversized 并继续，不整推中止', async () => {
    // pass2 读到的小内容触发 mismatch；重读（并发改写后）才跨过 50MiB → 必须走 oversized
    const big = 'x'.repeat(50 * 1024 * 1024 + 1)
    const contents: Record<string, string[]> = { 'units/a.ini': ['AA'], 'units/b.ini': ['BB', 'B2', big] }
    const reads: Record<string, number> = {}
    const bridge = {
      project: {
        readFileBytes: async (_root: string, abs: string) => {
          const key = Object.keys(contents).find((candidate) => abs.replace(/\\/g, '/').endsWith(candidate))!
          reads[key] = (reads[key] ?? 0) + 1
          const list = contents[key]
          const content = list[Math.min(reads[key] - 1, list.length - 1)]
          const bytes = new TextEncoder().encode(content)
          return { bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }
        },
        writeFile: vi.fn(async () => undefined),
        writeAnchor: vi.fn(async () => ({ written: true })),
        createFolder: vi.fn(async () => undefined),
        stat: async () => ({ mtimeMs: 0, size: 10 }),
      },
      mod: { scanResources: async () => ({ files: Object.keys(contents), unitNames: [] }) },
      git: { status: async () => [] },
    } as unknown as BridgeApi
    const calls: Array<{ path: string; body: unknown }> = []
    let bAttempts = 0
    const api = fakeApi({
      uploadBlob: async (_slug, input) => {
        if (input.path === 'units/b.ini') {
          bAttempts += 1
          throw Object.assign(new Error('hash mismatch'), { kind: 'object_hash_mismatch' })
        }
      },
    }, calls)
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded).toEqual(['units/a.ini'])
    expect(outcome.oversized).toContain('units/b.ini')
    expect(bAttempts).toBe(1)
  })

  it('取消：文件粒度中止，不再发出 blobs/versions 请求', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const bridge = textBridge({ 'mod-info.txt': '[mod]\ntitle: t\n', 'units/a.ini': '[core]\n' })
    // 第一个 blob 上传完成后置取消标记：第二个文件不再上传，versions 不发
    const outcome = await pushLocalTree(host(bridge, api, () => calls.some((call) => call.path.endsWith('/blobs'))), { message: '更新', baseVersionNo: 1 })
    expect(outcome.status).toBe('aborted')
    expect(calls.filter((call) => call.path.endsWith('/blobs'))).toHaveLength(1)
    expect(calls.some((call) => call.path.endsWith('/versions'))).toBe(false)
  })

  it('幂等键：同一次推送内仅一次 versions 调用；两次推送 client_op_id 不同', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const bridge = textBridge({ 'units/a.ini': '[core]\n' })
    await pushLocalTree(host(bridge, api), { message: 'a', baseVersionNo: 1 })
    await pushLocalTree(host(bridge, api), { message: 'b', baseVersionNo: 2 })
    const ids = calls.filter((call) => call.path.endsWith('/versions')).map((call) => (call.body as { clientOpId: string }).clientOpId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('提交重试白名单：确定性 HTTP 失败（404）绝不重试，versions 只发一次', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({ pushVersion: async () => { calls.push({ path: '/repos/iron-curtain/versions', body: {} }); throw Object.assign(new Error('HTTP 404'), { kind: 'http', status: 404 }) } }, calls)
    const bridge = textBridge({ 'units/a.ini': '[core]\n' })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 1 })
    expect(outcome.status).toBe('failed')
    expect(calls.filter((call) => call.path.endsWith('/versions'))).toHaveLength(1)
  })

  it('提交重试白名单：网关瞬态（503）与网络类（响应丢失）按上限重试（共 3 次尝试）', async () => {
    const bridge = textBridge({ 'units/a.ini': '[core]\n' })
    const calls: Array<{ path: string; body: unknown }> = []
    const gatewayApi = fakeApi({ pushVersion: async () => { calls.push({ path: '/repos/iron-curtain/versions', body: {} }); throw Object.assign(new Error('HTTP 503'), { kind: 'http', status: 503 }) } }, calls)
    const gatewayOutcome = await pushLocalTree(host(bridge, gatewayApi), { message: 'm', baseVersionNo: 1 })
    expect(gatewayOutcome.status).toBe('failed')
    expect(calls.filter((call) => call.path.endsWith('/versions'))).toHaveLength(3)
    const networkCalls: Array<{ path: string; body: unknown }> = []
    const networkApi = fakeApi({ pushVersion: async () => { networkCalls.push({ path: '/repos/iron-curtain/versions', body: {} }); throw Object.assign(new Error('net down'), { kind: 'network' }) } }, networkCalls)
    const networkOutcome = await pushLocalTree(host(bridge, networkApi), { message: 'm', baseVersionNo: 1 })
    expect(networkOutcome.status).toBe('failed')
    expect(networkCalls.filter((call) => call.path.endsWith('/versions'))).toHaveLength(3)
  })
})

describe('清单完整性 / 编码保真 / 幂等键（round 3 修复）', () => {
  it('非白名单文本（.json/.md）进入「类型不支持」清单，不再被静默丢弃', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const bridge = textBridge({ 'mod-info.txt': '[mod]\ntitle: t\n', 'data/units.json': '{}', 'README.md': '# hi' })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded).toEqual(['mod-info.txt'])
    expect(outcome.unsupported.sort()).toEqual(['README.md', 'data/units.json'])
  })

  it('非法 UTF-8 原始字节（GBK/截断序列）跳过并报告，且不发出任何上传请求', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const bridge = {
      project: {
        // 磁盘原始字节是 GBK（非 UTF-8）：fatal 解码必须失败，绝不按替换字符改写上传
        readFileBytes: async () => ({ bytes: Uint8Array.from([0xb2, 0xe2, 0xca, 0xd4]).buffer as ArrayBuffer, size: 4, mtimeMs: 0 }),
        stat: async () => ({ mtimeMs: 0, size: 4 }),
        writeFile: vi.fn(async () => undefined),
        writeAnchor: vi.fn(async () => ({ written: true })),
        createFolder: vi.fn(async () => undefined),
      },
      mod: { scanResources: async () => ({ files: ['gbk.txt'], unitNames: [] }) },
      git: { status: async () => [] },
    } as unknown as BridgeApi
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('没有可上传的文件')
    expect(outcome.skippedBinary[0]).toContain('gbk.txt')
    expect(outcome.skippedBinary[0]).toContain('UTF-8')
    expect(calls).toEqual([])
  })

  it('BOM 文本按原始字节上传（EF BB BF 保留），不做有损字符串往返', async () => {
    const uploaded: ArrayBuffer[] = []
    const api = fakeApi({ uploadBlob: async (_slug, input) => { uploaded.push(input.bytes) } })
    const bridge = {
      project: {
        readFileBytes: async () => ({ bytes: Uint8Array.from([0xef, 0xbb, 0xbf, 0x78]).buffer as ArrayBuffer, size: 4, mtimeMs: 0 }),
        stat: async () => ({ mtimeMs: 0, size: 4 }),
        writeFile: vi.fn(async () => undefined),
        writeAnchor: vi.fn(async () => ({ written: true })),
        createFolder: vi.fn(async () => undefined),
      },
      mod: { scanResources: async () => ({ files: ['units/a.txt'], unitNames: [] }) },
      git: { status: async () => [] },
    } as unknown as BridgeApi
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect([...new Uint8Array(uploaded[0])]).toEqual([0xef, 0xbb, 0xbf, 0x78])
  })

  it('提交遇网络类失败会重试并复用同一 client_op_id（服务端幂等重放才生效）', async () => {
    const ids: string[] = []
    let attempts = 0
    const api = fakeApi({
      pushVersion: async (_slug, input) => {
        ids.push(input.clientOpId)
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('net'), { kind: 'network' })
        return { versionNo: 9 }
      },
    })
    const bridge = textBridge({ 'units/a.ini': '[core]\n' })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 2 })
    expect(outcome).toMatchObject({ status: 'pushed', versionNo: 9 })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it('业务错误（version_conflict）不重试：只发一次 versions 请求', async () => {
    let calls = 0
    const conflictError = Object.assign(new Error('conflict'), { kind: 'version_conflict', conflict: null }) as unknown as CloudBagApiError
    const api = fakeApi({ pushVersion: async () => { calls += 1; throw conflictError } })
    const bridge = textBridge({ 'units/a.ini': '[core]\n' })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 2 })
    expect(outcome.status).toBe('conflict')
    expect(calls).toBe(1)
  })

  it('isCloudBagInternalPath 大小写不敏感（.OHMYTX 变体不算本地未发布修改）', () => {
    expect(isCloudBagInternalPath('.OHMYTX/cloud.json')).toBe(true)
    expect(isCloudBagInternalPath('.OhMyTx\\backup\\3\\units\\tank.ini')).toBe(true)
    expect(isCloudBagInternalPath('units/.OHMYTX')).toBe(false)
    expect(isCloudBagInternalPath('units/tank.ini')).toBe(false)
  })
})

describe('importTreeToNewRepo（空态导入入口）', () => {
  it('建仓库 → 复用推送链路提交首版本（base_version_no=0）', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const repo = { id: 7, slug: 'imported-repo', title: '导入的仓库', headVersionNo: 0 } as unknown as CloudBagRepo
    const api = fakeApi({
      createRepo: async (input) => { calls.push({ path: '/repos', body: input }); return repo },
    }, calls)
    const bridge = textBridge({ 'mod-info.txt': '[mod]\ntitle: t\n', 'units/tank.ini': '[core]\n' })
    const outcome = await importTreeToNewRepo(host(bridge, api), {
      repo: { title: '导入的仓库', visibility: 'private' },
      message: '从当前项目导入的初始版本',
    })
    expect(outcome.status).toBe('imported')
    expect(outcome.versionNo).toBe(4)
    expect(calls[0].path).toBe('/repos')
    expect(calls.map((call) => call.path)).toEqual([
      '/repos',
      '/repos/imported-repo/sessions',
      '/repos/imported-repo/blobs',
      '/repos/imported-repo/blobs',
      '/repos/imported-repo/versions',
    ])
    expect((calls[4].body as { baseVersionNo: number }).baseVersionNo).toBe(0)
  })

  it('建仓库失败时不发任何推送请求', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({ createRepo: async () => { throw new Error('forbidden') } }, calls)
    const outcome = await importTreeToNewRepo(host(textBridge({ 'a.ini': 'x' }), api), { repo: { title: 't' }, message: 'm' })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('forbidden')
    expect(calls).toEqual([])
  })
})

describe('pullRemoteVersion（拉取覆盖）', () => {
  it('下载 export.rwmod 后走 cloudbag:restore 桥（备份/回滚在主进程侧），透出 removed', async () => {
    const restore = vi.fn(async () => ({ written: 3, backedUp: 1, removed: 2, skipped: [] }))
    const bridge = { cloudbag: { restore } } as unknown as BridgeApi
    const outcome = await pullRemoteVersion(host(bridge, fakeApi()), { versionNo: 5 })
    expect(outcome).toMatchObject({ status: 'pulled', versionNo: 5, written: 3, backedUp: 1, removed: 2 })
    expect(restore).toHaveBeenCalledWith('C:\\proj', expect.any(ArrayBuffer), 5)
  })
  it('缺少 cloudbag 桥（旧桌面版）显式失败，不伪造成功', async () => {
    const bridge = {} as BridgeApi
    const outcome = await pullRemoteVersion(host(bridge, fakeApi()), { versionNo: 5 })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('需要更新桌面版')
  })
})

describe('锚点读写与本地变更判定', () => {
  it('readCloudBagAnchor：损坏锚回 null', async () => {
    const bytes = new TextEncoder().encode('not-json')
    const bridge = {
      project: {
        readFileBytes: async () => ({ bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }),
      },
    } as unknown as BridgeApi
    expect(await readCloudBagAnchor(bridge, 'C:\\proj')).toBeNull()
  })

  it('readCloudBagAnchorSnapshot：raw 保留 BOM（与主进程 CAS 字符串同口径），parse 仅剥 BOM', async () => {
    // 主进程 fs:writeAnchor 用 fs.readFile(utf8) 比较，Node 不剥 BOM；快照若用 fs:readFile
    //（会剥 BOM）当期望值，带 BOM 的锚点 CAS 将永远失败。
    const anchorJson = JSON.stringify({ repoSlug: 'iron-curtain', baselineSeq: 4, baselineTreeDigest: 'd', lastSyncedAt: 1 })
    const rawWithBom = `\uFEFF${anchorJson}`
    const bytes = new TextEncoder().encode(rawWithBom)
    const bridge = {
      project: {
        readFileBytes: async () => ({ bytes: bytes.buffer as ArrayBuffer, size: bytes.byteLength, mtimeMs: 0 }),
        writeAnchor: vi.fn(async (_root: string, _path: string, _content: string, expectedContent: string | null) => ({ written: expectedContent === rawWithBom })),
      },
    } as unknown as BridgeApi
    const snapshot = await readCloudBagAnchorSnapshot(bridge, 'C:\\proj')
    expect(snapshot.raw).toBe(rawWithBom) // CAS 期望值逐字符等于主进程读到的字符串（BOM 保留）
    expect(snapshot.anchor?.baselineSeq).toBe(4) // 解析前才剥 BOM
    const written = await migrateCloudBagAnchor(bridge, 'C:\\proj', { ...snapshot.anchor!, baselineTreeDigest: 'migrated' }, snapshot.raw!)
    expect(written).toBe(true)
  })
  it('judgeLocalChanged：git 不可用回 null；锚点与备份目录均不计入变更', async () => {
    const unavailable = { git: { status: async () => { throw new Error('no git') } } } as unknown as BridgeApi
    expect(await judgeLocalChanged(unavailable, 'C:\\proj')).toBeNull()
    const onlyAnchor = { git: { status: async () => [{ status: 'M', path: '.ohmytx/cloud.json' }] } } as unknown as BridgeApi
    expect(await judgeLocalChanged(onlyAnchor, 'C:\\proj')).toBe(false)
    // 拉取覆盖会把被覆盖文件备份到 .ohmytx/backup/<no>/：git status 的未跟踪条目不得判为「本地未发布修改」
    const withBackup = {
      git: {
        status: async () => [
          { status: '??', path: '.ohmytx/backup/5/units/tank.ini' },
          { status: 'M', path: '.ohmytx/cloud.json' },
        ],
      },
    } as unknown as BridgeApi
    expect(await judgeLocalChanged(withBackup, 'C:\\proj')).toBe(false)
    const realChange = {
      git: {
        status: async () => [
          { status: '??', path: '.ohmytx/backup/5/units/tank.ini' },
          { status: 'M', path: 'units/tank.ini' },
        ],
      },
    } as unknown as BridgeApi
    expect(await judgeLocalChanged(realChange, 'C:\\proj')).toBe(true)
  })

  it('listLocalChanges：非 git 项目（status 空 + 无 .git）按「无法检测」回 null，不谎报干净', async () => {
    // 复现第 1 轮缺陷：主进程 statusFiles 把 git 失败吞成空数组，渲染层据此判 clean，
    // 非 git 项目被漏报「本地与远端一致」且无法发布第二个版本。
    const notARepo = {
      git: { status: async () => [] },
      project: { stat: async () => { throw new Error('ENOENT') } },
    } as unknown as BridgeApi
    expect(await listLocalChanges(notARepo, 'C:\\proj')).toBeNull()
    expect(await judgeLocalChanged(notARepo, 'C:\\proj')).toBeNull()
    // judgeSyncState 对 null 的收敛（四分态保守方向）由 cloudBagData.test 覆盖
  })

  it('listLocalChanges：git 项目空 status（.git 存在）→ 干净空清单；非空 → 逐条清单', async () => {
    const cleanRepo = {
      git: { status: async () => [] },
      project: { stat: async () => ({ mtimeMs: 0, size: 0 }) },
    } as unknown as BridgeApi
    expect(await listLocalChanges(cleanRepo, 'C:\\proj')).toEqual([])
    expect(await judgeLocalChanged(cleanRepo, 'C:\\proj')).toBe(false)
    const dirtyRepo = {
      git: { status: async () => [{ status: 'M', path: 'units/tank.ini' }] },
      project: { stat: async () => { throw new Error('不应被探测：status 非空') } },
    } as unknown as BridgeApi
    expect(await listLocalChanges(dirtyRepo, 'C:\\proj')).toEqual([{ status: 'M', path: 'units/tank.ini' }])
  })

  it('writeCloudBagAnchor：先确保 .ohmytx 目录存在，再走串行锚点通道（无条件写）', async () => {
    const order: string[] = []
    let calledPath = ''
    let expected: string | null | undefined
    const bridge = {
      project: {
        createFolder: vi.fn(async () => { order.push('createFolder') }),
        writeAnchor: vi.fn(async (_root: string, filePath: string, _content: string, expectedContent: string | null) => {
          if (!order.includes('createFolder')) throw new Error('ENOENT: .ohmytx 不存在')
          order.push('writeAnchor')
          calledPath = filePath
          expected = expectedContent
          return { written: true }
        }),
      },
    } as unknown as BridgeApi
    await writeCloudBagAnchor(bridge, 'C:\\proj', { repoSlug: 'iron-curtain', baselineSeq: 4, baselineTreeDigest: '', lastSyncedAt: 1 })
    expect(order).toEqual(['createFolder', 'writeAnchor'])
    expect(calledPath.replace(/\\/g, '/')).toContain('.ohmytx/cloud.json')
    expect(expected).toBeNull()
  })
})
