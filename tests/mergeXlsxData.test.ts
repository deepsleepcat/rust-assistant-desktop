import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'merge-xlsx-data.py')

describe('merge-xlsx-data 工作簿审计', () => {
  it('默认只审计：识别无冒号字段、模板字段并报告所有重复键', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-audit-'))
    const workbook = path.join(dir, 'fixture.xlsx')
    const before = fs.readFileSync(path.join(ROOT, 'public/data/code.json'))
    try {
      execFileSync('python', ['-c', [
        'import openpyxl, sys',
        'wb=openpyxl.Workbook()',
        'ws=wb.active',
        "ws.title='代码表HX'",
        "ws.append([None, '代码', '代码翻译', '描述', '例子', '值类型'])",
        "ws.append([None, '代码', '代码翻译', '[core]', None, None])",
        "ws.append([None, 'customFixture', '夹具字段', '用于测试', 'customFixture: 1', 'string'])",
        "ws.append([None, 'displayText_{LANG}', '多语言文本', '模板字段', '', 'string'])",
        "ws.append([None, 'duplicateFixture:', '重复一', '重复字段', '', 'string'])",
        "ws.append([None, 'duplicateFixture', '重复二', '重复字段', '', 'float'])",
        'wb.save(sys.argv[1])',
      ].join(';'), workbook], { cwd: ROOT, encoding: 'utf8' })
      const output = execFileSync('python', [SCRIPT, workbook], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      expect(output).toContain('重复键')
      expect(output).toContain('第5行')
      expect(output).toContain('第6行')
      expect(output).toContain('审计完成；未写入数据')
      expect(fs.readFileSync(path.join(ROOT, 'public/data/code.json'))).toEqual(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
