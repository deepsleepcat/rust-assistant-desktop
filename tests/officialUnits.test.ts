/**
 * 官方单位全量回归（M10）：把游戏安装目录的全部官方单位文件
 * 跑一遍 15 个语义检查器，验证零误报。
 * - 引用类检查（unitNames）使用官方全部单位名——官方单位互相引用，应全部命中；
 * - 键名拼写/逻辑布尔检查使用真实代码表（public/data/code.json）——
 *   保证 checkKeyTypos / checkLogicBooleanPrecedence 真实运行而非空跑。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { runSemanticChecks } from '../src/features/editor/semanticChecks'

const GAME_UNITS = 'W:/steam/steamapps/common/Rusted Warfare/assets/units'
const CODE_TABLE = path.resolve(__dirname, '../public/data/code.json')

function collectOfficialUnits(): string[] {
  if (!fs.existsSync(GAME_UNITS)) return []
  return fs
    .readdirSync(GAME_UNITS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(GAME_UNITS, e.name))
}

describe('官方单位零误报（游戏安装目录存在时运行）', () => {
  const dirs = collectOfficialUnits()
  const skip = it.skip
  if (dirs.length === 0) {
    skip('游戏目录不可用', () => undefined)
    return
  }

  const files: string[] = []
  for (const dir of dirs) {
    const ini = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ini'))
    for (const f of ini) files.push(path.join(dir, f))
  }

  // 官方全部单位名（builtFrom/convertTo 引用用）
  const unitNames = new Set<string>()
  for (const f of files) {
    const m = /^\s*name:\s*(.+?)\s*$/m.exec(fs.readFileSync(f, 'utf8'))
    if (m) unitNames.add(m[1])
  }

  // 真实代码表（public/data/code.json）：键名拼写/逻辑布尔检查的真实数据源
  const codeTable = JSON.parse(fs.readFileSync(CODE_TABLE, 'utf8')) as { data: Array<{ code: string; type: string }> }
  const codes = codeTable.data.map((c) => c.code)
  const findCode = (k: string) => codeTable.data.find((c) => c.code.toLowerCase() === k.toLowerCase())

  it(`全部 ${files.length} 个官方单位文件零误报（含真实代码表）`, () => {
    const failures: Array<{ file: string; issues: unknown[] }> = []
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8')
      const issues = runSemanticChecks(content, {
        ctx: { unitNames, findCode, codes },
      })
      if (issues.length > 0) failures.push({ file: f.replace(GAME_UNITS, ''), issues })
    }
    expect(failures).toEqual([])
  })
})
