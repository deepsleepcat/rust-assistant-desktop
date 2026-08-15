/**
 * AI 工具集测试（第一线 ②：补核心链路测试——AI 工具执行器）。
 * 之前 rustAgentTools.ts 全模块零测试；这里覆盖 7 个工具的执行分支与路径安全校验。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initAiHistory, getHistory } from '../electron/aiHistory'
import {
  clearSnapshotInfo,
  createCodeTableTool,
  createGenerateCheckCasesTool,
  createListProjectTool,
  createOutlineTool,
  createReadFileTool,
  createRustAgentTools,
  createSearchTool,
  createWriteFileTool,
  getAgentRoot,
  setAgentRoot,
  takeSnapshotInfo,
} from '../electron/rustAgentTools'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-tools-'))
  initAiHistory(path.join(root, 'ai-history.json'))
  setAgentRoot(root)
})

afterEach(async () => {
  clearSnapshotInfo()
  await fs.rm(root, { recursive: true, force: true })
})

/** 工具执行结果里的文本内容（content[0].text） */
function textOf(result: { content?: unknown }): string {
  const arr = result.content as Array<{ text?: string }> | undefined
  return arr?.[0]?.text ?? ''
}

/** 断言工具执行抛出路径安全类错误（win32 命中「超出项目目录范围」；
 * Linux 上反斜杠绝对路径被当普通文件名，可能抛英文 ENOENT——一并覆盖） */
async function expectRejected(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toThrow(/超出项目目录范围|未登记|目录不存在|不存在|无效|no such file|ENOENT/i)
}

describe('rustAgentTools 工具集', () => {
  it('工具清单完整：7 个工具全部暴露', () => {
    const tools = createRustAgentTools()
    expect(tools.map((t) => t.name)).toEqual([
      'listProject', 'readFile', 'searchInProject', 'codeTable', 'sectionOutline', 'writeFile', 'generateCheckCases',
    ])
  })

  it('setAgentRoot/getAgentRoot 往返', () => {
    setAgentRoot(path.join(root, 'a'))
    expect(getAgentRoot()).toBe(path.join(root, 'a'))
  })

  describe('listProject', () => {
    it('列出目录内容（目录/文件标记，深度 1）', async () => {
      await fs.mkdir(path.join(root, 'units'))
      await fs.writeFile(path.join(root, 'mod-info.txt'), 'hello', 'utf8')
      const out = await createListProjectTool().execute('id', {})
      const text = textOf(out)
      expect(text).toContain('[目录] units/')
      expect(text).toContain('[文件] mod-info.txt')
    })

    it('空目录提示；子路径可指定', async () => {
      await fs.mkdir(path.join(root, 'empty'))
      const empty = textOf(await createListProjectTool().execute('id', { path: 'empty' }))
      expect(empty).toContain('（空目录）')
    })

    it('路径穿越拒绝', async () => {
      await expectRejected(createListProjectTool().execute('id', { path: '../outside' }))
    })
  })

  describe('readFile', () => {
    it('读取文件内容（相对路径）', async () => {
      await fs.mkdir(path.join(root, 'units'))
      await fs.writeFile(path.join(root, 'units', 'a.txt'), '内容一\n内容二', 'utf8')
      const out = textOf(await createReadFileTool().execute('id', { path: 'units/a.txt' }))
      expect(out).toContain('内容一')
      expect(out).toContain('内容二')
    })

    it('BOM 剥离', async () => {
      await fs.writeFile(path.join(root, 'bom.txt'), '\uFEFF带BOM内容', 'utf8')
      const out = textOf(await createReadFileTool().execute('id', { path: 'bom.txt' }))
      expect(out).toBe('带BOM内容')
      expect(out).not.toContain('\uFEFF')
    })

    it('超长内容截断并标注', async () => {
      await fs.writeFile(path.join(root, 'long.txt'), 'x'.repeat(25000), 'utf8')
      const out = textOf(await createReadFileTool().execute('id', { path: 'long.txt' }))
      expect(out).toContain('内容过长已截断')
      expect(out.length).toBeLessThan(21000)
    })

    it('超大文件（>64MB）拒绝读取并提示', async () => {
      const file = path.join(root, 'big.txt')
      await fs.writeFile(file, '', 'utf8')
      await fs.truncate(file, 65 * 1024 * 1024) // 稀疏文件：瞬间创建 65MB 逻辑大小
      const out = textOf(await createReadFileTool().execute('id', { path: 'big.txt' }))
      expect(out).toContain('文件过大')
    })

    it('路径穿越与绝对路径拒绝', async () => {
      await expectRejected(createReadFileTool().execute('id', { path: '../secret.txt' }))
      await expectRejected(createReadFileTool().execute('id', { path: 'C:\\Windows\\win.ini' }))
    })
  })

  describe('searchInProject', () => {
    it('按文件名关键词匹配（不递归）', async () => {
      await fs.writeFile(path.join(root, 'tank.txt'), '', 'utf8')
      await fs.writeFile(path.join(root, 'rifle.txt'), '', 'utf8')
      await fs.mkdir(path.join(root, 'sub'))
      await fs.writeFile(path.join(root, 'sub', 'tank2.txt'), '', 'utf8')
      const out = textOf(await createSearchTool().execute('id', { query: 'tank' }))
      expect(out).toContain('tank.txt')
      expect(out).not.toContain('tank2.txt') // 不递归子目录
      expect(out).toContain('找到 1 个')
    })

    it('无匹配时给出未找到提示', async () => {
      const out = textOf(await createSearchTool().execute('id', { query: 'zzz' }))
      expect(out).toContain('未找到')
    })
  })

  describe('sectionOutline', () => {
    it('提取节名与行号', async () => {
      await fs.writeFile(
        path.join(root, 'unit.ini'),
        '[core]\nname = "a"\n\n[attack]\nrange = 100\n[turret_1]\nprojectile:1\n',
        'utf8',
      )
      const out = textOf(await createOutlineTool().execute('id', { path: 'unit.ini' }))
      expect(out).toContain('[core] 第 1 行')
      expect(out).toContain('[attack] 第 4 行')
      expect(out).toContain('[turret_1] 第 6 行')
    })

    it('无节时提示', async () => {
      await fs.writeFile(path.join(root, 'plain.txt'), '没有节\n', 'utf8')
      const out = textOf(await createOutlineTool().execute('id', { path: 'plain.txt' }))
      expect(out).toContain('（无节）')
    })
  })

  describe('writeFile', () => {
    it('新建文件（自动建父目录）+ 记录快照（新建 = null 快照）', async () => {
      const out = textOf(await createWriteFileTool().execute('call-1', { path: 'units/new/a.txt', content: '新内容' }))
      expect(out).toContain('已新增 units/new/a.txt')
      expect(await fs.readFile(path.join(root, 'units', 'new', 'a.txt'), 'utf8')).toBe('新内容')
      const snap = takeSnapshotInfo('call-1')
      expect(snap?.skipped).toBe(false)
      expect(snap?.id).toBeTruthy()
      // 快照内容为 null（文件不存在时快照）：恢复 = 删除文件
      const entry = await getHistory().getEntry(root, 'units/new/a.txt', snap!.id!)
      expect(entry?.content).toBeNull()
    })

    it('修改已有文件 + 每文件版本累积', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), 'v1', 'utf8')
      await createWriteFileTool().execute('c1', { path: 'a.txt', content: 'v2' })
      await createWriteFileTool().execute('c2', { path: 'a.txt', content: 'v3' })
      expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v3')
      const history = await getHistory().listHistory(root, 'a.txt')
      expect(history.length).toBe(2)
      const first = await getHistory().getEntry(root, 'a.txt', history[1].id)
      expect(first?.content).toBe('v1')
    })

    it('超大文件快照跳过（skipped=true，不阻断写入）', async () => {
      await fs.writeFile(path.join(root, 'big.txt'), '', 'utf8')
      await fs.truncate(path.join(root, 'big.txt'), 2 * 1024 * 1024 + 1)
      await createWriteFileTool().execute('c1', { path: 'big.txt', content: '小内容' })
      const snap = takeSnapshotInfo('c1')
      expect(snap?.skipped).toBe(true)
      expect(snap?.id).toBeUndefined()
      expect(await fs.readFile(path.join(root, 'big.txt'), 'utf8')).toBe('小内容')
    })

    it('路径穿越拒绝（写入前校验，不落盘）', async () => {
      await expectRejected(createWriteFileTool().execute('c1', { path: '../evil.txt', content: 'x' }))
      expect(await fs.readdir(path.dirname(root))).not.toContain('evil.txt')
    })

    it('超 64MB 内容拒绝并提示', async () => {
      const out = textOf(await createWriteFileTool().execute('c1', { path: 'huge.txt', content: 'x'.repeat(64 * 1024 * 1024 + 1) }))
      expect(out).toContain('超过 64MB 上限')
    })

    it('takeSnapshotInfo 读取即删除（防表泄漏）', async () => {
      await createWriteFileTool().execute('c1', { path: 'a.txt', content: 'x' })
      expect(takeSnapshotInfo('c1')).not.toBeNull()
      expect(takeSnapshotInfo('c1')).toBeNull()
    })
  })

  describe('codeTable', () => {
    it('按英文键查询命中（读真实 public/data/code.json）', async () => {
      const out = textOf(await createCodeTableTool().execute('id', { query: 'maxHp' }))
      expect(out).toContain('maxHp')
    })

    it('按中文译名查询命中', async () => {
      const out = textOf(await createCodeTableTool().execute('id', { query: '生命' }))
      expect(out.length).toBeGreaterThan(0)
      // 至少返回了条目（含字段说明文本）
      expect(out).not.toContain('代码表中未找到')
    })

    it('无结果提示', async () => {
      const out = textOf(await createCodeTableTool().execute('id', { query: 'zzz不存在的字段zzz' }))
      expect(out).toContain('代码表中未找到')
    })
  })

  describe('generateCheckCases', () => {
    it('合法声明式规则通过并返回摘要', async () => {
      const result = await createGenerateCheckCasesTool().execute('id', {
        targetPath: 'units/a.ini',
        rules: [
          { id: 'hp-range', title: '血量范围', key: 'maxHp', section: 'core', severity: 'warning', check: { type: 'numeric-range', min: 1, max: 10000 } },
          { id: 'name-required', title: '必须有名字', section: 'core', key: 'name', check: { type: 'required-key' } },
        ],
        note: '示例',
      })
      const details = result.details as { ok: boolean; rules: unknown[] }
      expect(details.ok).toBe(true)
      expect(details.rules.length).toBe(2)
      expect(textOf(result)).toContain('已生成 2 条检查用例')
    })

    it('非法检查类型被拒绝并给出错误', async () => {
      const result = await createGenerateCheckCasesTool().execute('id', {
        rules: [{ id: 'bad', title: '坏规则', key: 'x', check: { type: 'evil-script' } }],
      })
      const details = result.details as { ok: boolean; errors: string[] }
      expect(details.ok).toBe(false)
      expect(details.errors.length).toBeGreaterThan(0)
      expect(textOf(result)).toContain('格式有误')
    })

    it('重复 id 被拒绝', async () => {
      const result = await createGenerateCheckCasesTool().execute('id', {
        rules: [
          { id: 'dup', title: '一', key: 'a', check: { type: 'numeric-range', min: 1 } },
          { id: 'dup', title: '二', key: 'b', check: { type: 'numeric-range', min: 1 } },
        ],
      })
      expect((result.details as { ok: boolean }).ok).toBe(false)
    })
  })
})
