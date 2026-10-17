import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorState } from '@codemirror/state'
import { bilingualLabelForLine, bilingualLabels } from '../src/features/editor/bilingualLabels'
import { loadCodeData, reloadCodeData } from '../src/services/codeData'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge, MOCK_PROJECT_ROOT } from '../src/services/mockBridge'

beforeAll(async () => {
  const root = path.resolve(__dirname, '../public/data')
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const file = path.resolve(root, String(input).replace(/^\/?data\//, ''))
    if (!file.startsWith(root + path.sep)) throw new Error('Fixture outside data directory')
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) } as Response
  }))
  reloadCodeData()
  await loadCodeData()
})
afterAll(() => { vi.unstubAllGlobals(); reloadCodeData() })

describe('display-only bilingual fields', () => {
  it('labels keys and named sections without labeling comments or values', () => {
    expect(bilingualLabelForLine('  name: 中文值')).toMatchObject({ from: 2, to: 6, label: expect.any(String) })
    expect(bilingualLabelForLine('[turret_main]')).toMatchObject({ from: 1, to: 12, label: expect.any(String) })
    expect(bilingualLabelForLine('# name: comment')).toBeNull()
    expect(bilingualLabelForLine('; image: comment')).toBeNull()
    expect(bilingualLabelForLine('user_variable: name/path.png')).toBeNull()
  })
  it('extension leaves document, values, paths and names unchanged', () => {
    const source = '[core]\nname: 用户名\nimage: folder/name.png\n@global customVariable: 2\n# name: 注释'
    const state = EditorState.create({ doc: source, extensions: bilingualLabels })
    expect(state.doc.toString()).toBe(source)
  })
  it.each(['\n', '\r\n', '\r'])('view then save preserves original %j text without a write', async (newline) => {
    const file = `${MOCK_PROJECT_ROOT}\\units\\bilingual.ini`
    const source = ['[core]', 'name = 原名', 'image: folder/name.png', '# 保留注释'].join(newline)
    const bridge = createMockBridge([{ path: file, content: source }])
    const write = vi.spyOn(bridge.project, 'writeFile')
    const store = createWorkspaceStore(bridge)
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(file)
    const tab = store.getState().openTabs[0]
    expect(tab.translationEnabled).toBe(false)
    expect(tab.content).toBe(source)
    expect(tab.dirty).toBe(false)
    expect(await store.getState().saveTab(tab.id)).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect((await bridge.project.readFile(MOCK_PROJECT_ROOT, file)).content).toBe(source)
  })
})
