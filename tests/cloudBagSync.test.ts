/**
 * 云书包手动同步编排回归（桌面契约 §6.4/§10）：
 * - 推送全链路（假桥 + 假 API）：会话 → 逐文件 blob → 原子建版本，请求形状符合契约
 * - 冲突分支：version_conflict 返回 conflict 结果（head 摘要）而非抛错
 * - 取消：文件粒度协作式中止
 * - 拉取：走 cloudbag:restore 桥（备份/回滚在主进程测试中覆盖）
 * - 幂等：client_op_id 每次推送生成唯一键
 */
import { describe, expect, it, vi } from 'vitest'
import { pushLocalTree, pullRemoteVersion, readCloudBagAnchor, judgeLocalChanged, writeCloudBagAnchor, importTreeToNewRepo, isCloudBagInternalPath, type SyncHost } from '../src/services/cloudBagSync'
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
      writeFile: vi.fn(async () => undefined),
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

  it('读取桥解码有损（大小不符 / GBK 等）的文本跳过并报告，且不发出任何上传请求', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = fakeApi({}, calls)
    const bridge = {
      project: {
        // 磁盘 4 字节、只解出 2 个替换字符 → 重编码 2 字节 ≠ 原文件字节数
        readFile: async () => ({ content: '??', hasBom: false, mtimeMs: 0, size: 4 }),
        stat: async () => ({ mtimeMs: 0, size: 4 }),
        writeFile: vi.fn(async () => undefined),
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

  it('BOM 文本按原字节上传（EF BB BF 保留），不做有损字符串往返', async () => {
    const uploaded: ArrayBuffer[] = []
    const api = fakeApi({ uploadBlob: async (_slug, input) => { uploaded.push(input.bytes) } })
    const bridge = {
      project: {
        readFile: async () => ({ content: 'x', hasBom: true, mtimeMs: 0, size: 4 }),
        stat: async () => ({ mtimeMs: 0, size: 4 }),
        writeFile: vi.fn(async () => undefined),
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
    const bridge = {
      project: {
        readFile: async () => ({ content: 'not-json', hasBom: false, mtimeMs: 0, size: 8 }),
      },
    } as unknown as BridgeApi
    expect(await readCloudBagAnchor(bridge, 'C:\\proj')).toBeNull()
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

  it('writeCloudBagAnchor：先确保 .ohmytx 目录存在（父目录缺失时 fs:writeFile 会 ENOENT）', async () => {
    const order: string[] = []
    const bridge = {
      project: {
        createFolder: vi.fn(async () => { order.push('createFolder') }),
        writeFile: vi.fn(async () => {
          if (!order.includes('createFolder')) throw new Error('ENOENT: .ohmytx 不存在')
          order.push('writeFile')
        }),
      },
    } as unknown as BridgeApi
    await writeCloudBagAnchor(bridge, 'C:\\proj', { repoSlug: 'iron-curtain', baselineSeq: 4, baselineTreeDigest: '', lastSyncedAt: 1 })
    expect(order).toEqual(['createFolder', 'writeFile'])
  })
})
