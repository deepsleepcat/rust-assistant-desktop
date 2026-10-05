/**
 * 云端基线判定回归（生产调用点，非镜像 helper）：
 * - scanLocalTree / treeDigestOf / diffTreeManifests / resolveBaselineTree / loadBaselineEntries
 *   就是 CloudBagSyncModal 打开时与 pushLocalTree 第一趟实际调用的函数；
 * - 覆盖：发布后重开 clean（锚点摘要 = 实际提交树）、真实修改/新增/删除、README 与
 *   非 UTF-8 跳过文件不 false dirty、发布第二趟失败的文件不算已同步、旧锚点空 digest
 *   从服务端基线树迁移、服务端失败时不回退 git 且不谎报 clean、噪声条目归一。
 */
import { describe, expect, it, vi } from 'vitest'
import { judgeSyncState } from '../src/features/community/cloudBagData'
import {
  migrateCloudBagAnchor,
  pushLocalTree,
  readCloudBagAnchor,
  readCloudBagAnchorSnapshot,
  writeCloudBagAnchor,
  type SyncHost,
} from '../src/services/cloudBagSync'
import {
  diffTreeManifests,
  fetchVersionTreeEntries,
  loadBaselineEntries,
  resolveBaselineTree,
  scanLocalTree,
  treeDigestOf,
} from '../src/services/cloudBagTreeState'
import type { CloudBagApi, CloudBagTreeEntry } from '../src/services/cloudBagApi'
import type { BridgeApi } from '../src/types/bridge'

const ROOT = 'C:\\proj'
const SLUG = 'iron-curtain'
const ANCHOR_KEY = '.ohmytx/cloud.json'

interface DiskBridgeHooks {
  /** 这些路径的 stat 大小用 sizes 覆盖值（模拟超限文件） */
  sizes?: Map<string, number>
  /** 原始字节覆盖（模拟磁盘上的真实字节：非法序列/合法 U+FFFD/BOM 等） */
  bytes?: Record<string, Uint8Array>
  /** 第 N 次读取该路径时抛错（模拟发布第二趟并发不可读；1 起算） */
  failReadWhen?: (key: string, attempt: number) => boolean
  /** 主进程扫描不返回这些路径（模拟噪声目录被排除，但文件仍在磁盘上） */
  hiddenFromScan?: Set<string>
}

function diskBridge(initial: Record<string, string>, hooks: DiskBridgeHooks = {}) {
  const store = new Map(Object.entries(initial))
  const readCounts = new Map<string, number>()
  const sizes = hooks.sizes ?? new Map<string, number>()
  const byteOverrides = hooks.bytes ?? {}
  const keyOf = (abs: string): string | null => {
    const normalized = abs.replace(/\\/g, '/')
    const candidates = [...store.keys()].filter((key) => normalized === key || normalized.endsWith(`/${key}`))
    candidates.sort((a, b) => b.length - a.length)
    return candidates[0] ?? null
  }
  const rawOf = (key: string): Uint8Array => byteOverrides[key] ?? new TextEncoder().encode(store.get(key) ?? '')
  const sizeOf = (key: string): number => sizes.get(key) ?? rawOf(key).byteLength
  const bridge = {
    project: {
      readFile: async (_root: string, abs: string) => {
        const key = keyOf(abs)
        if (!key) throw new Error('ENOENT')
        return { content: store.get(key) as string, hasBom: false, mtimeMs: 0, size: sizeOf(key) }
      },
      // 与真桥 fs:readFileBytes 同形：返回磁盘原始字节，绝不重编码
      readFileBytes: async (_root: string, abs: string) => {
        const key = keyOf(abs)
        if (!key) throw new Error('ENOENT')
        const attempt = (readCounts.get(key) ?? 0) + 1
        readCounts.set(key, attempt)
        if (hooks.failReadWhen?.(key, attempt)) throw new Error('模拟读取失败')
        const raw = rawOf(key).slice()
        return { bytes: raw.buffer as ArrayBuffer, size: sizeOf(key), mtimeMs: 0 }
      },
      writeFile: vi.fn(async (_root: string, abs: string, content: string) => {
        store.set(keyOf(abs) ?? ANCHOR_KEY, content)
      }),
      // 与真桥 fs:writeAnchor 同形的 CAS：expectedContent 非 null 时内容不一致则不写
      writeAnchor: vi.fn(async (_root: string, abs: string, content: string, expectedContent: string | null) => {
        const key = keyOf(abs) ?? ANCHOR_KEY
        const current = store.get(key) ?? null
        if (expectedContent !== null && current !== expectedContent) return { written: false }
        store.set(key, content)
        return { written: true }
      }),
      createFolder: vi.fn(async () => undefined),
      stat: async (_root: string, abs: string) => {
        const key = keyOf(abs)
        if (!key) throw new Error('ENOENT')
        return { mtimeMs: 0, size: sizeOf(key) }
      },
    },
    mod: {
      scanResources: async () => ({
        files: [...store.keys()].filter((key) => key !== ANCHOR_KEY && !hooks.hiddenFromScan?.has(key)),
        unitNames: [],
      }),
    },
    // 判定链路已不再使用 git：任何调用都直接失败，防止「悄悄退回 git 口径」
    git: { status: async () => { throw new Error('测试：基线判定不应调用 git') } },
  } as unknown as BridgeApi
  return { bridge, store, sizes, readCounts, byteOverrides }
}

function fakeApi(overrides: Partial<CloudBagApi> = {}) {
  const calls: string[] = []
  let nextVersion = 4
  const api = {
    openSession: async () => { calls.push('sessions'); return { id: 'sess-1', status: 'open', files: [] } },
    uploadBlob: async () => { calls.push('blobs') },
    pushVersion: async () => { calls.push('versions'); return { versionNo: nextVersion } },
    tree: async () => { calls.push('tree'); return { items: [] as CloudBagTreeEntry[], nextCursor: null } },
    ...overrides,
  } as unknown as CloudBagApi
  return { api, calls, setNextVersion: (value: number) => { nextVersion = value } }
}

function host(bridge: BridgeApi, api: CloudBagApi): SyncHost {
  return { api, bridge, rootPath: ROOT, repoSlug: SLUG, onProgress: () => undefined, isAborted: () => false }
}

const anchorOf = (versionNo: number, digest: string) => ({ repoSlug: SLUG, baselineSeq: versionNo, baselineTreeDigest: digest, lastSyncedAt: 1 })

describe('发布 → 重开（生产链路：push 摘要 ↔ 扫描/基线比较）', () => {
  it('发布后重开：锚点摘要=实际提交树 → clean，不再假报「本地有未发布修改」', async () => {
    const { bridge } = diskBridge({
      'mod-info.txt': '[mod]\ntitle: t\n',
      'units/tank.ini': '[core]\nname: tank\n',
    })
    const { api } = fakeApi()
    const outcome = await pushLocalTree(host(bridge, api), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.treeDigest).toBeTruthy()
    expect(outcome.uploaded.sort()).toEqual(['mod-info.txt', 'units/tank.ini'])

    await writeCloudBagAnchor(bridge, ROOT, anchorOf(outcome.versionNo!, outcome.treeDigest!))
    // 重开：完全按 CloudBagSyncModal 打开时的生产函数顺序
    const anchor = await readCloudBagAnchor(bridge, ROOT)
    expect(anchor?.baselineTreeDigest).toBe(outcome.treeDigest)
    const scan = await scanLocalTree(bridge, ROOT)
    expect(scan).not.toBeNull()
    const baseline = await resolveBaselineTree({ anchor: anchor!, api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(baseline).toMatchObject({ source: 'anchor' })
    const state = judgeSyncState({
      anchor: anchor!,
      repoSlug: SLUG,
      remoteHeadVersionNo: outcome.versionNo!,
      localChanged: scan!.digest !== baseline!.digest,
    })
    expect(state).toBe('clean')
  })

  it('发布第二趟失败的文件不算已同步：重开报差异（local-ahead）而不是 clean', async () => {
    const { bridge } = diskBridge(
      { 'mod-info.txt': '[mod]\ntitle: t\n', 'units/tank.ini': '[core]\nname: tank\n' },
      { failReadWhen: (key, attempt) => key === 'units/tank.ini' && attempt === 2 },
    )
    const { api } = fakeApi()
    const outcome = await pushLocalTree(host(bridge, api), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded).toEqual(['mod-info.txt'])
    expect(outcome.skippedBinary.some((item) => item.startsWith('units/tank.ini'))).toBe(true)

    await writeCloudBagAnchor(bridge, ROOT, anchorOf(outcome.versionNo!, outcome.treeDigest!))
    const anchor = await readCloudBagAnchor(bridge, ROOT)
    const scan = await scanLocalTree(bridge, ROOT) // 第三次读取恢复成功：tank.ini 是可上传的有效本地变更
    const baseline = await resolveBaselineTree({ anchor: anchor!, api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(scan!.digest).not.toBe(baseline!.digest)
    expect(judgeSyncState({ anchor: anchor!, repoSlug: SLUG, remoteHeadVersionNo: outcome.versionNo!, localChanged: true })).toBe('local-ahead')
  })

  it('提交摘要只取实际上传清单：第二趟跳过文件不会进入 baselineTreeDigest', async () => {
    const { bridge } = diskBridge(
      { 'mod-info.txt': '[mod]\ntitle: t\n', 'units/tank.ini': '[core]\nname: tank\n' },
      { failReadWhen: (key, attempt) => key === 'units/tank.ini' && attempt === 2 },
    )
    const { api } = fakeApi()
    const outcome = await pushLocalTree(host(bridge, api), { message: '更新', baseVersionNo: 3 })
    const committed = await treeDigestOf(outcome.localTree!.filter((entry) => entry.path === 'mod-info.txt'))
    expect(outcome.treeDigest).toBe(committed)
    const withSkipped = await treeDigestOf(outcome.localTree!)
    expect(outcome.treeDigest).not.toBe(withSkipped)
  })
})

describe('重开后的真实修改 / 新增 / 删除（A 栏基线差异 + 四分态）', () => {
  async function publishAndReopen(files: Record<string, string>) {
    const disk = diskBridge(files)
    const { api } = fakeApi()
    const outcome = await pushLocalTree(host(disk.bridge, api), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('pushed')
    await writeCloudBagAnchor(disk.bridge, ROOT, anchorOf(outcome.versionNo!, outcome.treeDigest!))
    return { ...disk, api, outcome }
  }

  it('修改：本地摘要变化 + 远端新版本 → conflict，A 栏为 M', async () => {
    const { bridge, store, api, outcome } = await publishAndReopen({
      'mod-info.txt': '[mod]\ntitle: t\n',
      'units/tank.ini': '[core]\nname: tank\n',
    })
    const serverTree: CloudBagTreeEntry[] = outcome.localTree!.map((entry) => ({ path: entry.path, size: 1, sha256: entry.sha256 }))
    const treeApi = fakeApi({ tree: async () => ({ items: serverTree, nextCursor: null }) }).api
    store.set('units/tank.ini', '[core]\nname: changed\n')

    const anchor = await readCloudBagAnchor(bridge, ROOT)
    const scan = await scanLocalTree(bridge, ROOT)
    const baseline = await resolveBaselineTree({ anchor: anchor!, api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(scan!.digest).not.toBe(baseline!.digest)
    expect(judgeSyncState({ anchor: anchor!, repoSlug: SLUG, remoteHeadVersionNo: outcome.versionNo! + 1, localChanged: true })).toBe('conflict')

    const entries = await loadBaselineEntries({ api: treeApi, bridge, rootPath: ROOT, repoSlug: SLUG, versionNo: anchor!.baselineSeq, localEntries: scan!.entries })
    expect(diffTreeManifests(scan!.entries, entries!)).toEqual([{ status: 'M', path: 'units/tank.ini' }])
  })

  it('删除 → D；新增可上传文件 → A（同一基线下逐文件差异）', async () => {
    const { bridge, store, outcome } = await publishAndReopen({
      'mod-info.txt': '[mod]\ntitle: t\n',
      'units/tank.ini': '[core]\nname: tank\n',
    })
    const serverTree: CloudBagTreeEntry[] = outcome.localTree!.map((entry) => ({ path: entry.path, size: 1, sha256: entry.sha256 }))
    const treeApi = fakeApi({ tree: async () => ({ items: serverTree, nextCursor: null }) }).api
    store.delete('units/tank.ini')
    store.set('units/new.ini', '[core]\nname: new\n')

    const anchor = await readCloudBagAnchor(bridge, ROOT)
    const scan = await scanLocalTree(bridge, ROOT)
    const entries = await loadBaselineEntries({ api: treeApi, bridge, rootPath: ROOT, repoSlug: SLUG, versionNo: anchor!.baselineSeq, localEntries: scan!.entries })
    expect(diffTreeManifests(scan!.entries, entries!)).toEqual([
      { status: 'A', path: 'units/new.ini' },
      { status: 'D', path: 'units/tank.ini' },
    ])
    expect(judgeSyncState({ anchor: anchor!, repoSlug: SLUG, remoteHeadVersionNo: anchor!.baselineSeq, localChanged: true })).toBe('local-ahead')
  })
})

describe('跳过类文件不参与基线比较（不 false dirty）', () => {
  it('README.md（白名单外）与非法 UTF-8 原始字节改动后仍 clean；超限文件同样不算', async () => {
    const sizes = new Map<string, number>()
    // GBK 字节（非 UTF-8）：必须按原始字节判定为非法而跳过，绝不能解码后改写上传
    const bytes: Record<string, Uint8Array> = { 'units/gbk.txt': Uint8Array.from([0xb2, 0xe2, 0xca, 0xd4]) }
    const { bridge, store } = diskBridge(
      {
        'mod-info.txt': '[mod]\ntitle: t\n',
        'units/tank.ini': '[core]\nname: tank\n',
        'README.md': '说明 v1\n',
        'units/gbk.txt': 'placeholder',
      },
      { sizes, bytes },
    )
    const { api } = fakeApi()
    const outcome = await pushLocalTree(host(bridge, api), { message: '更新', baseVersionNo: 3 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded.sort()).toEqual(['mod-info.txt', 'units/tank.ini'])
    expect(outcome.unsupported).toContain('README.md')
    expect(outcome.skippedBinary.some((item) => item.startsWith('units/gbk.txt'))).toBe(true)

    await writeCloudBagAnchor(bridge, ROOT, anchorOf(outcome.versionNo!, outcome.treeDigest!))
    // 改动全部「跳过类」文件：README 内容变化、坏编码字节变化、再放一个 51MiB 文件
    store.set('README.md', '说明 v2（真正改动）\n')
    bytes['units/gbk.txt'] = Uint8Array.from([0xb8, 0xc4, 0xb6, 0xaf])
    store.set('assets/huge.png', 'x')
    sizes.set('assets/huge.png', 51 * 1024 * 1024)

    const anchor = await readCloudBagAnchor(bridge, ROOT)
    const scan = await scanLocalTree(bridge, ROOT)
    expect(scan!.entries.map((entry) => entry.path).sort()).toEqual(['mod-info.txt', 'units/tank.ini'])
    expect(scan!.oversized).toContain('assets/huge.png')
    expect(scan!.digest).toBe(anchor!.baselineTreeDigest)
    expect(judgeSyncState({ anchor: anchor!, repoSlug: SLUG, remoteHeadVersionNo: anchor!.baselineSeq, localChanged: false })).toBe('clean')
  })
})

describe('旧锚点（空 digest）兼容：从服务端基线树补齐，不退回 git', () => {
  it('空 digest：取服务端基线版本树算摘要 → clean，并回写迁移值；迁移后离线可比', async () => {
    const { bridge } = diskBridge({
      'mod-info.txt': '[mod]\ntitle: t\n',
      'units/tank.ini': '[core]\nname: tank\n',
    })
    const scan = await scanLocalTree(bridge, ROOT)
    const serverTree: CloudBagTreeEntry[] = scan!.entries.map((entry) => ({ path: entry.path, size: 1, sha256: entry.sha256 }))
    let treeCalls = 0
    const { api } = fakeApi({ tree: async () => { treeCalls += 1; return { items: serverTree, nextCursor: null } } })
    const legacy = anchorOf(4, '')

    const resolved = await resolveBaselineTree({ anchor: legacy, api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(resolved).toMatchObject({ source: 'server' })
    expect(resolved!.migratedDigest).toBe(scan!.digest)
    expect(treeCalls).toBe(1)
    expect(judgeSyncState({ anchor: legacy, repoSlug: SLUG, remoteHeadVersionNo: 4, localChanged: scan!.digest !== resolved!.digest })).toBe('clean')

    // 迁移回写后再次打开：命中锚点摘要，不再发 tree 请求（离线可用）
    await writeCloudBagAnchor(bridge, ROOT, { ...legacy, baselineTreeDigest: resolved!.migratedDigest! })
    const migrated = await readCloudBagAnchor(bridge, ROOT)
    const offlineApi = fakeApi({ tree: async () => { throw new Error('离线') } }).api
    const again = await resolveBaselineTree({ anchor: migrated!, api: offlineApi, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(again).toMatchObject({ source: 'anchor', digest: scan!.digest })
  })

  it('服务端基线树取不到：返回 null，四分态按「无法确认」保守处理（不 clean、不调 git）', async () => {
    const { bridge } = diskBridge({ 'mod-info.txt': '[mod]\ntitle: t\n' })
    const scan = await scanLocalTree(bridge, ROOT)
    const { api } = fakeApi({ tree: async () => { throw new Error('网络失败') } })
    const resolved = await resolveBaselineTree({ anchor: anchorOf(4, ''), api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(resolved).toBeNull()
    // localChanged=null（而不是 git 的 true/false）：head==基线时保守落 local-ahead
    expect(judgeSyncState({ anchor: anchorOf(4, ''), repoSlug: SLUG, remoteHeadVersionNo: 4, localChanged: null })).toBe('local-ahead')
  })

  it('服务端树含本地被扫描排除但磁盘存在的噪声条目：归一后不算「本地删除」', async () => {
    const { bridge } = diskBridge(
      { 'mod-info.txt': '[mod]\ntitle: t\n', 'dist/out.ini': 'noise\n' },
      { hiddenFromScan: new Set(['dist/out.ini']) },
    )
    const scan = await scanLocalTree(bridge, ROOT)
    expect(scan!.entries.map((entry) => entry.path)).toEqual(['mod-info.txt'])
    const serverTree: CloudBagTreeEntry[] = [
      { path: 'mod-info.txt', size: 1, sha256: scan!.entries[0].sha256 },
      { path: 'dist/out.ini', size: 1, sha256: 'a'.repeat(64) },
    ]
    const { api } = fakeApi({ tree: async () => ({ items: serverTree, nextCursor: null }) })
    const resolved = await resolveBaselineTree({ anchor: anchorOf(4, ''), api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(resolved!.entries!.map((entry) => entry.path)).toEqual(['mod-info.txt'])
    expect(resolved!.digest).toBe(scan!.digest)
  })
})

describe('摘要与分页的口径', () => {
  it('treeDigestOf：与条目顺序无关、路径大小写按 cloudBagPathKey 归一、sha 统一小写', async () => {
    const a = await treeDigestOf([{ path: 'Units/Tank.ini', sha256: 'AA' }, { path: 'b.ini', sha256: 'bb' }])
    const b = await treeDigestOf([{ path: 'b.ini', sha256: 'BB' }, { path: 'units/tank.ini', sha256: 'aa' }])
    expect(a).toBe(b)
    const c = await treeDigestOf([{ path: 'units/tank.ini', sha256: 'cc' }])
    expect(c).not.toBe(a)
  })

  it('fetchVersionTreeEntries：按 nextCursor 分页取全量', async () => {
    const pages = new Map<string, { items: CloudBagTreeEntry[]; nextCursor: string | null }>()
    pages.set('start', { items: [{ path: 'a.ini', size: 1, sha256: 'aa' }], nextCursor: 'p2' })
    pages.set('p2', { items: [{ path: 'b.ini', size: 1, sha256: 'bb' }], nextCursor: null })
    const { api } = fakeApi({ tree: async (_slug, _versionNo, cursor) => pages.get(cursor ?? 'start')! })
    const entries = await fetchVersionTreeEntries(api, SLUG, 4)
    expect(entries!.map((entry) => entry.path)).toEqual(['a.ini', 'b.ini'])
  })
})

describe('原始字节保真（红绿夹具：非法序列重编码等长 / 合法 U+FFFD）', () => {
  // 41 F0 9F 98 = 'A' + 被截断的 4 字节 UTF-8 序列：非严格解码折叠为 A\uFFFD，
  // 重编码恰为 41 EF BF BD（同样 4 字节）——旧「重编码字节数 == stat.size」检查漏检，
  // 上传的就是被静默改写的字节。修复后按原始字节 fatal 解码 → 必须跳过。
  const invalidTruncated = Uint8Array.from([0x41, 0xf0, 0x9f, 0x98])
  // 41 EF BF BD = 'A' + 合法编码的 U+FFFD（真实 replacement 字符）：必须原样上传
  const validReplacement = Uint8Array.from([0x41, 0xef, 0xbf, 0xbd])

  it('夹具有效性（红侧）：非严格解码再重编码与原字节等长，旧长度守卫必然漏检', () => {
    const lossy = new TextDecoder().decode(invalidTruncated) // 'A\uFFFD'
    const reencoded = new TextEncoder().encode(lossy)
    expect([...reencoded]).toEqual([0x41, 0xef, 0xbf, 0xbd])
    // 等长正是旧「重编码字节数 == stat.size」守卫看不见的情况（修复前上传的就是这 4 字节）
    expect(reencoded.byteLength).toBe(invalidTruncated.byteLength)
  })

  it('等长非法夹具：跳过，且上传字节里绝不出现改写后的 41 EF BF BD', async () => {
    const { bridge } = diskBridge(
      { 'mod-info.txt': 'ok\n', 'units/bad.txt': 'placeholder' },
      { bytes: { 'units/bad.txt': invalidTruncated } },
    )
    const blobs: Array<{ path: string; bytes: number[] }> = []
    const { api } = fakeApi({
      uploadBlob: async (_slug, input) => { blobs.push({ path: input.path, bytes: [...new Uint8Array(input.bytes)] }) },
    })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded).toEqual(['mod-info.txt'])
    expect(outcome.skippedBinary.some((item) => item.startsWith('units/bad.txt'))).toBe(true)
    expect(blobs.map((blob) => blob.path)).toEqual(['mod-info.txt'])
    // 改写后的字节序列不得出现在任何上传/提交里
    expect(blobs.some((blob) => blob.bytes.join(',') === '65,239,191,189')).toBe(false)
  })

  it('合法 U+FFFD 文本不被误杀：原始字节上传，重开摘要一致（clean）', async () => {
    const { bridge } = diskBridge(
      { 'mod-info.txt': 'ok\n', 'units/replacement.txt': 'placeholder' },
      { bytes: { 'units/replacement.txt': validReplacement } },
    )
    const blobs: Array<{ path: string; bytes: number[] }> = []
    const { api } = fakeApi({
      uploadBlob: async (_slug, input) => { blobs.push({ path: input.path, bytes: [...new Uint8Array(input.bytes)] }) },
    })
    const outcome = await pushLocalTree(host(bridge, api), { message: 'm', baseVersionNo: 0 })
    expect(outcome.status).toBe('pushed')
    expect(outcome.uploaded.sort()).toEqual(['mod-info.txt', 'units/replacement.txt'])
    expect(blobs.find((blob) => blob.path === 'units/replacement.txt')?.bytes).toEqual([0x41, 0xef, 0xbf, 0xbd])

    await writeCloudBagAnchor(bridge, ROOT, anchorOf(outcome.versionNo!, outcome.treeDigest!))
    const anchor = await readCloudBagAnchor(bridge, ROOT)
    const scan = await scanLocalTree(bridge, ROOT)
    const baseline = await resolveBaselineTree({ anchor: anchor!, api, bridge, rootPath: ROOT, repoSlug: SLUG, localEntries: scan!.entries })
    expect(scan!.digest).toBe(baseline!.digest)
  })
})

describe('锚点迁移 CAS（生产路径：快照 + 条件写）', () => {
  it('快照后被同期 push 推进到 #3：迁移请求被拒绝，锚点不被覆盖回 #2', async () => {
    const { bridge } = diskBridge({ 'mod-info.txt': 'x' })
    await writeCloudBagAnchor(bridge, ROOT, anchorOf(2, ''))
    const snapshot = await readCloudBagAnchorSnapshot(bridge, ROOT)
    expect(snapshot.raw).not.toBeNull()
    // 同期 push 成功：锚点已推进到 #3（带新摘要）
    await writeCloudBagAnchor(bridge, ROOT, anchorOf(3, 'digest-3'))
    const written = await migrateCloudBagAnchor(bridge, ROOT, anchorOf(2, 'migrated-2'), snapshot.raw!)
    expect(written).toBe(false)
    const current = await readCloudBagAnchor(bridge, ROOT)
    expect(current?.baselineSeq).toBe(3)
    expect(current?.baselineTreeDigest).toBe('digest-3')
  })

  it('内容未变时 CAS 写入成功，回写的迁移摘要可用于后续比较', async () => {
    const { bridge } = diskBridge({ 'mod-info.txt': 'x' })
    await writeCloudBagAnchor(bridge, ROOT, anchorOf(2, ''))
    const snapshot = await readCloudBagAnchorSnapshot(bridge, ROOT)
    const written = await migrateCloudBagAnchor(bridge, ROOT, anchorOf(2, 'migrated-2'), snapshot.raw!)
    expect(written).toBe(true)
    expect((await readCloudBagAnchor(bridge, ROOT))?.baselineTreeDigest).toBe('migrated-2')
  })
})
