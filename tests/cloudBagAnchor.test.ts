/**
 * 云书包锚点排除回归（桌面契约 §6.4 / §10.7）：
 * `.ohmytx/cloud.json`（及 .ohmytx 目录内任意锚点/备份）绝不打进 .rwmod；
 * 服务端导出按同一排除规则（§8.4 双保险）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { packModBufferWithCount } from '../electron/modPack'
import { isExcluded, PACK_EXCLUDE_PATTERNS } from '../electron/modScan'

describe('打包排除 .ohmytx 锚点（§10.7）', () => {
  it('PACK_EXCLUDE_PATTERNS 命中 .ohmytx 目录', () => {
    expect(PACK_EXCLUDE_PATTERNS).toContain('.ohmytx')
    expect(isExcluded('.ohmytx/cloud.json')).toBe(true)
    expect(isExcluded('.ohmytx/backup/3/units/tank.ini')).toBe(true)
  })

  it('排除判定大小写不敏感（NTFS 目标平台），且看任意深度而非只看首段', () => {
    // 大小写变体：旧实现大小写敏感，这些会漏网
    expect(isExcluded('.OHMYTX/cloud.json')).toBe(true)
    expect(isExcluded('.OhMyTx/backup/3/units/tank.ini')).toBe(true)
    expect(isExcluded('.GIT/hooks/pre-commit')).toBe(true)
    expect(isExcluded('Node_Modules/pkg/index.js')).toBe(true)
    expect(isExcluded('Thumbs.DB')).toBe(true)
    // 深度 >1 的排除目录（旧 firstSegmentExcluded 只看首段会漏）
    expect(isExcluded('assets/node_modules/x.js')).toBe(true)
    expect(isExcluded('units/.git/config')).toBe(true)
    // 正常文件不受影响
    expect(isExcluded('units/tank.ini')).toBe(false)
    expect(isExcluded('mod-info.txt')).toBe(false)
  })

  it('含锚点的项目树打包：产物中无 .ohmytx/cloud.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-anchor-'))
    try {
      await fs.mkdir(path.join(root, 'units'), { recursive: true })
      await fs.mkdir(path.join(root, '.ohmytx'), { recursive: true })
      await fs.writeFile(path.join(root, 'mod-info.txt'), '[mod]\ntitle: t\n', 'utf8')
      await fs.writeFile(path.join(root, 'units', 'a.ini'), '[core]\nname: a\n', 'utf8')
      await fs.writeFile(path.join(root, '.ohmytx', 'cloud.json'), JSON.stringify({ repoSlug: 'iron-curtain', baselineSeq: 3 }), 'utf8')
      const { buffer } = await packModBufferWithCount(root)
      const zip = await JSZip.loadAsync(buffer)
      const names = Object.keys(zip.files)
      expect(names).toContain('mod-info.txt')
      expect(names).toContain('units/a.ini')
      expect(names.some((name) => name.replace(/\\/g, '/').startsWith('.ohmytx/'))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
