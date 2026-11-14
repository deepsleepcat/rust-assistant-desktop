import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorState } from '@codemirror/state'
import { bilingualLabelForLine, bilingualLabelsForLine, bilingualLabels } from '../src/features/editor/bilingualLabels'
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
  it('labels the complete logic value from the reported mod, including calls without parentheses', () => {
    const line = 'autoTrigger:if self.isControlledByAI'
    const labels = bilingualLabelsForLine(line)
    expect(labels).toHaveLength(2)
    expect(labels[0].label).toBe('自动触发')
    expect(labels[1]).toEqual({ from: 12, to: line.length, label: '如果 自身属于AI控制' })
    expect(bilingualLabelsForLine('autoTrigger:if self.isMoving')[1].label).not.toContain('isMoving')
  })
  it.each(['true', 'false', 'TRUE', 'False'])('labels boolean %s independently of key spacing', (value) => {
    for (const separator of [':', ': ', '=', '：']) {
      const line = `ai_isHighPriority${separator}${value}`
      const label = bilingualLabelsForLine(line)[1]
      expect(label).toEqual({ from: line.length - value.length, to: line.length, label: value.toLowerCase() === 'true' ? '真' : '假' })
    }
  })
  it('protects quoted parameters and keeps inline hashes in the value as the engine does', () => {
    const line = 'autoTrigger: if self.hasFlag(id=1) and true # false self.isMoving'
    const label = bilingualLabelsForLine(line)[1]
    expect(label.label).toContain('和 真')
    expect(line.slice(label.from, label.to)).toBe('if self.hasFlag(id=1) and true # false self.isMoving')
    expect(label.label).toContain('# 假')
    const quoted = 'isVisible:if self.resource(type="if #true",greaterThan=0) and false'
    expect(bilingualLabelsForLine(quoted)[1].label).toContain('type="if #true",greaterThan=0')
    expect(bilingualLabelsForLine(quoted)[1].label).toContain('和 假')
    expect(bilingualLabelsForLine("isVisible:if self.hasTags(includes='true')")[1].label).toContain("includes='true'")
  })
  it.each([
    'name: true', 'image: folder/if/true.png', 'tags: if,true,false',
    'displayText: if self.isControlledByAI', 'unknownKey: true',
    'color: #8E8E8E', '# autoTrigger: true', '; ai_isHighPriority:false',
    'autoTrigger: memory.true', 'autoTrigger: self.customFunction',
  ])('does not annotate free values, unknown tokens or comments: %s', (line) => {
    expect(bilingualLabelsForLine(line).every((label) => label.to <= line.indexOf(':'))).toBe(true)
  })
  it('view and save preserve the reported logic, booleans and colors without a write', async () => {
    const file = `${MOCK_PROJECT_ROOT}\\units\\translation-regression.ini`
    const source = '[hiddenAction_ai]\r\nautoTrigger:if self.isControlledByAI\r\nai_isHighPriority:true\r\nisVisible:false\r\n[effect_smoke]\r\ncolor:#8E8E8E\r\n'
    const bridge = createMockBridge([{ path: file, content: source }])
    const write = vi.spyOn(bridge.project, 'writeFile')
    const store = createWorkspaceStore(bridge)
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(file)
    const tab = store.getState().openTabs[0]
    const state = EditorState.create({ doc: tab.content, extensions: bilingualLabels })
    expect(state.doc.toString()).toBe(source.replace(/\r\n/g, '\n'))
    expect(tab.content).toBe(source)
    expect(tab.dirty).toBe(false)
    expect(await store.getState().saveTab(tab.id)).toBe(true)
    expect(write).not.toHaveBeenCalled()
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
