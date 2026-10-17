import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { fileFingerprint, snapshotLocalTree } from '../electron/cloudbagSnapshot'
import { restoreRwmod } from '../electron/cloudbagRestore'
import { acquireCloudBagOperation, ownsCloudBagOperation } from '../src/services/cloudBagOperation'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudbag-snapshot-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'unit.ini'), '[core]\nname: original\n')
  return root
}

describe('raw snapshot restore protection', () => {
  it('ignores anchor metadata but detects changed original bytes', async () => {
    const root = await fixture()
    const first = await snapshotLocalTree(root)
    await fs.mkdir(path.join(root, '.ohmytx'))
    await fs.writeFile(path.join(root, '.ohmytx', 'cloud.json'), '{}')
    expect((await snapshotLocalTree(root)).digest).toBe(first.digest)
    await fs.writeFile(path.join(root, 'unit.ini'), '[core]\nname: edited\n')
    expect((await snapshotLocalTree(root)).digest).not.toBe(first.digest)
    expect(await fileFingerprint(path.join(root, 'missing.ini'))).toBeNull()
  })
  it('refuses stale snapshots without overwriting later edits', async () => {
    const root = await fixture()
    const snapshot = await snapshotLocalTree(root)
    await fs.writeFile(path.join(root, 'unit.ini'), 'new local edit')
    const zip = new JSZip()
    zip.file('unit.ini', 'remote content')
    await expect(restoreRwmod(await zip.generateAsync({ type: 'nodebuffer' }), root, 1, snapshot.digest)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'unit.ini'), 'utf8')).toBe('new local edit')
  })
  it('restores against an unchanged snapshot', async () => {
    const root = await fixture()
    const snapshot = await snapshotLocalTree(root)
    const zip = new JSZip()
    zip.file('unit.ini', '[core]\nname: remote\n')
    const result = await restoreRwmod(await zip.generateAsync({ type: 'nodebuffer' }), root, 1, snapshot.digest)
    expect(result.written).toBe(1)
    expect(await fs.readFile(path.join(root, 'unit.ini'), 'utf8')).toContain('remote')
  })
})

describe('directory operation ownership', () => {
  it('holds a normalized root until release and ignores stale releases', () => {
    const root = 'W:\\project\\mod\\'
    const first = acquireCloudBagOperation(root)!
    expect(first).toBeTypeOf('function')
    expect(acquireCloudBagOperation('w:/project/mod')).toBeNull()
    expect(ownsCloudBagOperation('w:/project/mod', first)).toBe(true)
    first()
    const second = acquireCloudBagOperation(root)!
    first()
    expect(ownsCloudBagOperation(root, second)).toBe(true)
    second()
  })
})
