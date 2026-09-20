/**
 * 云书包纯逻辑回归（桌面契约 §6/§7.1/§10）：
 * - 树内路径校验与扩展名白名单（与后端 §1.5 同规则）
 * - 本地文件计划（50MiB 超限 / 不支持类型 / 可上传）
 * - 文件树构建、diff 摘要、mod-info [mod] 节解析（渲染层安全，不导入 Node 目标）
 * - 锚点解析/序列化、手动同步四分态判定、离线/未验证门控
 */
import { describe, expect, it } from 'vitest'
import {
  buildCloudBagTree,
  buildLocalFilePlan,
  cloudBagGate,
  isForeignAnchor,
  isValidTreePath,
  judgeSyncState,
  newClientOpId,
  parseCloudBagAnchor,
  parseModInfoManifest,
  repoDeepLink,
  safeUploadFileName,
  serializeCloudBagAnchor,
  summarizeDiff,
  CLOUDBAG_ALLOWED_EXTENSIONS,
  CLOUD_BAG_ANCHOR_PATH,
  MAX_UPLOAD_FILE_BYTES,
} from '../src/features/community/cloudBagData'
import { CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC, CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS, cloudBagUploadTimeoutMs } from '../src/services/cloudBagApi'
import * as mainTree from '../electron/cloudbagTree'

describe('isValidTreePath（后端 §1.5 同规则）', () => {
  it('白名单扩展名放行', () => {
    expect(isValidTreePath('mod-info.txt')).toBe(true)
    expect(isValidTreePath('units/tank.ini')).toBe(true)
    expect(isValidTreePath('assets/graphics/tank.png')).toBe(true)
    expect(isValidTreePath('maps/field.tmx')).toBe(true)
  })
  it('拒 ../ 穿越、绝对路径、盘符、反斜杠、NUL、超 200 rune', () => {
    expect(isValidTreePath('../evil.ini')).toBe(false)
    expect(isValidTreePath('units/../../evil.ini')).toBe(false)
    expect(isValidTreePath('/abs/path.ini')).toBe(false)
    expect(isValidTreePath('C:\\abs\\path.ini')).toBe(false)
    expect(isValidTreePath('units\\tank.ini')).toBe(false)
    expect(isValidTreePath('bad\0.ini')).toBe(false)
    expect(isValidTreePath(`${'a'.repeat(201)}.ini`)).toBe(false)
  })
  it('拒白名单外扩展名（.rwmod 不是树成员）', () => {
    expect(isValidTreePath('mod.rwmod')).toBe(false)
    expect(isValidTreePath('data.db')).toBe(false)
    expect(isValidTreePath('noext')).toBe(false)
  })
})

describe('buildLocalFilePlan（50MiB + 白名单）', () => {
  it('超大文件进 oversized 并带 file_too_large 语义（J5：V1 无两阶段）', () => {
    const plan = buildLocalFilePlan([
      { path: 'units/a.ini', size: 10 },
      { path: 'assets/huge.png', size: MAX_UPLOAD_FILE_BYTES + 1 },
      { path: 'data.bin', size: 10 },
    ])
    expect(plan.uploadable.map((f) => f.path)).toEqual(['units/a.ini'])
    expect(plan.oversized.map((f) => f.path)).toEqual(['assets/huge.png'])
    expect(plan.unsupported.map((f) => f.path)).toEqual(['data.bin'])
  })
})

describe('buildCloudBagTree（扁平清单 → 目录层级）', () => {
  it('目录在前、文件按名排序；目录路径正确聚合', () => {
    const tree = buildCloudBagTree([
      { path: 'b.ini', size: 2, sha256: 'bb' },
      { path: 'units/tank.ini', size: 3, sha256: 'cc' },
      { path: 'a.ini', size: 1, sha256: 'aa' },
      { path: 'units/graphics/tank.png', size: 4, sha256: 'dd' },
    ])
    expect(tree.map((n) => n.name)).toEqual(['units', 'a.ini', 'b.ini'])
    const units = tree[0]
    expect(units.isDirectory).toBe(true)
    expect(units.children.map((n) => n.name)).toEqual(['graphics', 'tank.ini'])
    expect(units.children[0].children[0].path).toBe('units/graphics/tank.png')
  })
  it('空清单返回空树', () => {
    expect(buildCloudBagTree([])).toEqual([])
  })
})

describe('summarizeDiff（文件级三态摘要）', () => {
  it('新增/修改/删除计数', () => {
    expect(summarizeDiff([
      { path: 'a', change: 'added' },
      { path: 'b', change: 'modified' },
      { path: 'c', change: 'modified' },
      { path: 'd', change: 'removed' },
    ])).toBe('新增 1 · 修改 2 · 删除 1')
    expect(summarizeDiff([])).toBe('无差异')
  })
})

describe('parseModInfoManifest（[mod] 节）', () => {
  it('解析 title/description/author/version/minVersion', () => {
    const manifest = parseModInfoManifest('[mod]\ntitle: 铁幕重坦\ndescription: 重型主力 # 注释\nversion: 1.4.0\nauthor: 战场工坊\nminVersion: 1.15p9\n\n[music]\nsourceFolder: music/\n')
    expect(manifest).toEqual({
      title: '铁幕重坦',
      description: '重型主力',
      thumbnail: '',
      version: '1.4.0',
      author: '战场工坊',
      update: '',
      minVersion: '1.15p9',
    })
  })
  it('缺 title 返回 null（manifest_parse_failed 语义）', () => {
    expect(parseModInfoManifest('[mod]\nauthor: x\n')).toBeNull()
    expect(parseModInfoManifest('')).toBeNull()
  })
})

describe('锚点（.ohmytx/cloud.json）', () => {
  it('路径常量为 .ohmytx/cloud.json；序列化→解析往返', () => {
    expect(CLOUD_BAG_ANCHOR_PATH).toBe('.ohmytx/cloud.json')
    const anchor = { repoSlug: 'iron-curtain', baselineSeq: 3, baselineTreeDigest: 'digest', lastSyncedAt: 1700000000 }
    expect(parseCloudBagAnchor(serializeCloudBagAnchor(anchor))).toEqual(anchor)
  })
  it('损坏/异构锚回 null', () => {
    expect(parseCloudBagAnchor('not-json')).toBeNull()
    expect(parseCloudBagAnchor('{"repoSlug":""}')).toBeNull()
    expect(parseCloudBagAnchor('{"repoSlug":"a","baselineSeq":-1,"baselineTreeDigest":"","lastSyncedAt":0}')).toBeNull()
  })
})

describe('judgeSyncState（手动同步四分态，桌面契约 §6.4）', () => {
  const anchor = { repoSlug: 'a', baselineSeq: 3, baselineTreeDigest: '', lastSyncedAt: 0 }
  const at = (input: { anchor: typeof anchor | null; remoteHeadVersionNo: number; localChanged: boolean | null }, repoSlug = 'a') =>
    judgeSyncState({ ...input, repoSlug })
  it('未绑定 → unbound', () => {
    expect(at({ anchor: null, remoteHeadVersionNo: 0, localChanged: false })).toBe('unbound')
  })
  it('clean：无本地变更且远端无新版本', () => {
    expect(at({ anchor, remoteHeadVersionNo: 3, localChanged: false })).toBe('clean')
  })
  it('仅本地变 → local-ahead（引导走发布）', () => {
    expect(at({ anchor, remoteHeadVersionNo: 3, localChanged: true })).toBe('local-ahead')
  })
  it('仅远端新 → remote-ahead', () => {
    expect(at({ anchor, remoteHeadVersionNo: 4, localChanged: false })).toBe('remote-ahead')
  })
  it('双向变 → conflict（V1 无合并，UI 强制二选一）', () => {
    expect(at({ anchor, remoteHeadVersionNo: 4, localChanged: true })).toBe('conflict')
  })
  it('git 不可用（localChanged=null）时按保守冲突/仅本地处理，不误报 clean', () => {
    expect(at({ anchor, remoteHeadVersionNo: 4, localChanged: null })).toBe('conflict')
    expect(at({ anchor, remoteHeadVersionNo: 3, localChanged: null })).toBe('local-ahead')
  })
  it('锚点绑定的是别的仓库 → 一律 unbound（不得用本仓库 head 误判 clean/remote-ahead）', () => {
    // 打开仓库 B（head=1）时，绑定仓库 A（基线 10）的锚点曾判成 clean（两个按钮都被隐藏）
    expect(at({ anchor, remoteHeadVersionNo: 1, localChanged: false }, 'other-repo')).toBe('unbound')
    // head=20 时曾判成 remote-ahead 并允许直接拉取（无确认）把 B 的树覆盖进绑定 A 的项目
    expect(at({ anchor, remoteHeadVersionNo: 20, localChanged: false }, 'other-repo')).toBe('unbound')
    expect(at({ anchor, remoteHeadVersionNo: 20, localChanged: true }, 'other-repo')).toBe('unbound')
    expect(isForeignAnchor(anchor, 'other-repo')).toBe(true)
    expect(isForeignAnchor(anchor, 'a')).toBe(false)
    expect(isForeignAnchor(null, 'a')).toBe(false)
  })
})

describe('repoDeepLink（纯逻辑层，避免 CloudBagPanel ↔ CloudBagRepoView 循环 import）', () => {
  it('取 endpoint 的 origin 拼社区仓库路径并转义 slug', () => {
    expect(repoDeepLink('https://community.example.com/api', 'iron-curtain')).toBe('https://community.example.com/community/repos/iron-curtain')
    expect(repoDeepLink('not a url', 'a b')).toBe('/community/repos/a%20b')
  })
})

describe('口径同源（主进程 electron/cloudbagTree.ts ↔ 渲染层 cloudBagData.ts）', () => {
  const samePaths = [
    'mod-info.txt', 'units/tank.ini', 'assets/graphics/tank.png', 'maps/field.tmx',
    '../evil.ini', '/abs/path.ini', 'C:\\abs\\path.ini', 'units\\tank.ini', 'bad\0.ini',
    `${'a'.repeat(201)}.ini`, 'mod.rwmod', 'data.db', 'noext', 'units/', '/units/tank.ini',
    'units/tank.ini:evil', 'units/tank.ini.', 'units/tank.ini ', 'a<b.ini', 'a|b.ini', 'a?b.ini',
  ]
  it('扩展名白名单逐项相同（上传侧与恢复侧不能各有一份不同的集合）', () => {
    expect([...mainTree.CLOUDBAG_ALLOWED_EXTENSIONS]).toEqual([...CLOUDBAG_ALLOWED_EXTENSIONS])
  })
  it('路径判定表逐项相同（含 ADS 冒号段、尾点/尾空格）', () => {
    for (const path of samePaths) {
      expect([path, isValidTreePath(path)]).toEqual([path, mainTree.isCloudBagTreePath(path)])
    }
    // 冒号段/尾点/尾空格必须两侧都拒（NTFS 上冒号段会落成不可见的备用数据流）
    expect(isValidTreePath('units/tank.ini:evil')).toBe(false)
    expect(isValidTreePath('units/tank.ini.')).toBe(false)
    expect(isValidTreePath('units/tank.ini ')).toBe(false)
    // 设备名由恢复侧单独的 DEVICE_NAME_RE 处理（与上传侧不同：服务端只拒段首设备名），
    // 路径谓词本身对 'nul.ini' 放行，两侧一致即可
    expect(mainTree.isCloudBagTreePath('nul.ini')).toBe(true)
    expect(isValidTreePath('nul.ini')).toBe(true)
  })
  it('上传时限公式与主进程同值（15s JSON 超时不得套在 50MiB 上传上）', () => {
    expect(mainTree.CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS).toBe(CLOUD_BAG_UPLOAD_TIMEOUT_MIN_MS)
    expect(mainTree.CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC).toBe(CLOUD_BAG_UPLOAD_ASSUMED_BYTES_PER_SEC)
    for (const bytes of [0, 1, 1024, 5 * 1024 * 1024, 50 * 1024 * 1024]) {
      expect(mainTree.cloudBagUploadTimeoutMs(bytes)).toBe(cloudBagUploadTimeoutMs(bytes))
    }
    expect(cloudBagUploadTimeoutMs(50 * 1024 * 1024)).toBeGreaterThanOrEqual(200_000)
    expect(cloudBagUploadTimeoutMs(0)).toBe(60_000)
  })
})

describe('cloudBagGate（离线/未登录/未验证不可互相误导）', () => {
  it('offline：不可浏览不可写，提示离线', () => {
    const gate = cloudBagGate('offline', null)
    expect(gate).toMatchObject({ canBrowse: false, canWrite: false })
    expect(gate.notice).toContain('离线')
  })
  it('未登录：引导登录', () => {
    const gate = cloudBagGate('signed_out', null)
    expect(gate.canBrowse).toBe(false)
    expect(gate.notice).toContain('登录')
  })
  it('已登录未邮箱验证：可浏览不可写，引导认证', () => {
    const gate = cloudBagGate('signed_in', { email: 'a@b.c', email_verified: false, status: 1 })
    expect(gate).toMatchObject({ canBrowse: true, canWrite: false })
    expect(gate.notice).toContain('邮箱认证')
  })
  it('已验证：全部放行', () => {
    expect(cloudBagGate('signed_in', { email: 'a@b.c', email_verified: true, status: 1 }).canWrite).toBe(true)
  })
})

describe('杂项', () => {
  it('safeUploadFileName 去路径分隔符与控制字符', () => {
    expect(safeUploadFileName('units/tank.ini')).toBe('tank.ini')
    expect(safeUploadFileName('a\\b\0c.ini')).toBe('a_b_c.ini')
    expect(safeUploadFileName('')).toBe('file')
  })
  it('newClientOpId 幂等键：同仓重放不产生第二次 versions 调用的前提是每次推送唯一', () => {
    const a = newClientOpId()
    const b = newClientOpId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-z]{8,64}$/)
  })
})
