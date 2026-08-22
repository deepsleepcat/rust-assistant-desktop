import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
type AuditIssue = { code: string; message: string; level: 'error' | 'warning' | 'info'; file?: string }
type AuditResult = {
  kind: string
  packageRoot: string
  manifest: { title: string | null }
  issues: AuditIssue[]
  summary: { error: number }
}
type SkillValidation = {
  summary: { ok: boolean; referenceCount: number; referenceHanChars: number }
  findings: Array<{ code: string; message: string }>
}
type SkillModules = {
  auditRwmod: (input: string) => Promise<AuditResult>
  validateSkill: () => Promise<SkillValidation>
}

type CorpusInventory = {
  sources: Array<{
    path: string
    subsetOf?: string
    overlap?: { allPayloadsMatchParentCorpus?: boolean; addsNewTopLevelSampleIdentities?: number }
    readOnlyAudit?: { archives?: number; recursivePhysicalArchivePaths?: number; specialSubsetPhysicalArchivePaths?: number }
  }>
}
const skillRoot = path.resolve(process.cwd(), '.agents', 'skills', 'rusted-warfare-modding')
const skillAvailable = existsSync(path.join(skillRoot, 'scripts', 'audit-rwmod.mjs')) && existsSync(path.join(skillRoot, 'scripts', 'validate-skill.mjs'))
let skillModules: SkillModules | null = null

async function loadSkillModules(): Promise<SkillModules | null> {
  if (!skillAvailable) return null
  if (!skillModules) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>
    skillModules = await dynamicImport(path.join(skillRoot, 'scripts', 'audit-rwmod.mjs')) as SkillModules
    const validation = await dynamicImport(path.join(skillRoot, 'scripts', 'validate-skill.mjs')) as { validateSkill: () => Promise<SkillValidation> }
    skillModules.validateSkill = validation.validateSkill
  }
  return skillModules
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rw-skill-'))
}

async function remove(pathname: string): Promise<void> {
  await fs.rm(pathname, { recursive: true, force: true })
}

const skillDescribe = skillAvailable ? describe : describe.skip

skillDescribe('Rusted Warfare project skill', () => {
  it('has a discoverable, complete, linked reference library', async () => {
    const skill = await loadSkillModules()
    if (!skill) return
    const result = await skill.validateSkill()
    expect(result.summary.ok, result.findings.map((item) => `${item.code}: ${item.message}`).join('\n')).toBe(true)
    expect(result.summary.referenceCount).toBe(13)
    expect(result.summary.referenceHanChars).toBeGreaterThanOrEqual(110_000)
  })

  it('records the special archive folder as an overlapping read-only subset', async () => {
    const inventoryPath = path.resolve(process.cwd(), '.agents', 'skills', 'rusted-warfare-modding', 'references', 'corpus-inventory.json')
    const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8')) as CorpusInventory
    const parent = inventory.sources.find((source) => source.path === 'W:\\mao\\tx\\模组实例')
    const special = inventory.sources.find((source) => source.path === 'W:\\mao\\tx\\模组实例\\特殊')

    expect(parent?.readOnlyAudit?.archives).toBe(48)
    expect(parent?.readOnlyAudit?.recursivePhysicalArchivePaths).toBe(59)
    expect(parent?.readOnlyAudit?.specialSubsetPhysicalArchivePaths).toBe(11)
    expect(special?.readOnlyAudit?.archives).toBe(11)
    expect(special?.subsetOf).toBe('W:\\mao\\tx\\模组实例')
    expect(special?.overlap?.allPayloadsMatchParentCorpus).toBe(true)
    expect(special?.overlap?.addsNewTopLevelSampleIdentities).toBe(0)
  })
})

skillDescribe('auditRwmod', () => {
  it('accepts a valid directory mod and resolves root references', async () => {
    const root = await makeTempDir()
    try {
      await fs.mkdir(path.join(root, 'units', 'scout'), { recursive: true })
      await fs.mkdir(path.join(root, 'art'), { recursive: true })
      await fs.writeFile(path.join(root, 'mod-info.txt'), '[mod]\ntitle: Test Mod\nminVersion: 1.15p9\nthumbnail: art/icon.png\n', 'utf8')
      await fs.writeFile(path.join(root, 'art', 'icon.png'), 'png', 'utf8')
      await fs.writeFile(path.join(root, 'art', 'scout.png'), 'png', 'utf8')
      await fs.writeFile(path.join(root, 'units', 'base.template'), '[core]\nmaxHp: 20\n', 'utf8')
      await fs.writeFile(path.join(root, 'units', 'scout', 'scout.ini'), '[core]\nname: scout\ncopyFrom: ROOT:units/base.template\n\n[graphics]\nimage: ROOT:art/scout.png\n', 'utf8')
      const skill = await loadSkillModules()
      if (!skill) return
      const result = await skill.auditRwmod(root)
      expect(result.summary.error).toBe(0)
      expect(result.manifest.title).toBe('Test Mod')
      expect(result.issues.some((item) => item.code === 'copyfrom-missing')).toBe(false)
      expect(result.issues.some((item) => item.code === 'asset-missing')).toBe(false)
    } finally {
      await remove(root)
    }
  })

  it('reports missing manifest and unsafe copyFrom path without modifying the directory', async () => {
    const root = await makeTempDir()
    try {
      const unit = path.join(root, 'bad.ini')
      const source = '[core]\nname: bad\ncopyFrom: ../../outside.template\n'
      await fs.writeFile(unit, source, 'utf8')
      const skill = await loadSkillModules()
      if (!skill) return
      const result = await skill.auditRwmod(root)
      expect(result.issues.some((item) => item.code === 'manifest-missing')).toBe(true)
      expect(result.issues.some((item) => item.code === 'copyfrom-path')).toBe(true)
      expect(await fs.readFile(unit, 'utf8')).toBe(source)
    } finally {
      await remove(root)
    }
  })

  it('handles a one-directory rwmod wrapper and resolves package-root resources', async () => {
    const root = await makeTempDir()
    try {
      const archive = path.join(root, 'wrapped.rwmod')
      const zip = new JSZip()
      zip.file('Wrapped/mod-info.txt', '[mod]\ntitle: Wrapped\nminVersion: 1.15p9\nthumbnail: icon.png\n')
      zip.file('Wrapped/icon.png', 'icon')
      zip.file('Wrapped/units/a.ini', '[core]\nname: wrappedUnit\n\n[graphics]\nimage: ROOT:icon.png\n')
      await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }))
      const skill = await loadSkillModules()
      if (!skill) return
      const result = await skill.auditRwmod(archive)
      expect(result.kind).toBe('rwmod')
      expect(result.packageRoot).toBe('Wrapped/')
      expect(result.manifest.title).toBe('Wrapped')
      expect(result.summary.error).toBe(0)
      expect(result.issues.some((item) => item.code === 'thumbnail-missing')).toBe(false)
      expect(result.issues.some((item) => item.code === 'asset-missing')).toBe(false)
    } finally {
      await remove(root)
    }
  })

  it('reports archive path traversal and legacy name-only metadata', async () => {
    const root = await makeTempDir()
    try {
      const archive = path.join(root, 'unsafe.rwmod')
      const zip = new JSZip()
      zip.file('mod-info.txt', '[mod]\nname: Legacy\n')
      zip.file('../escape.ini', '[core]\nname: escape\n')
      await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }))
      const skill = await loadSkillModules()
      if (!skill) return
      const result = await skill.auditRwmod(archive)
      expect(result.issues.some((item) => item.code === 'archive-path-traversal')).toBe(true)
      expect(result.issues.some((item) => item.code === 'manifest-title')).toBe(true)
      expect(result.issues.some((item) => item.code === 'legacy-name')).toBe(true)
    } finally {
      await remove(root)
    }
  })
})
