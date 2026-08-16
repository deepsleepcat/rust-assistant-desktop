/**
 * 真实模组回归（M28）：以「深渊星辰」两个真实模组为输入，全量跑 app 的
 * 扫描/检查管线，验证：
 * - 解析不崩溃（checkFailedFiles === 0）；
 * - 引擎合法语法零误报（节名/键名 Unicode、action 前缀族、三引号值等）。
 *
 * 模组根目录由本地配置文件提供（tests/real-mods.config.json，.gitignore 排除、不入库）：
 *   [{ "name": "模组名", "root": "模组绝对路径", "errorBudget": 20 }]
 * 配置文件缺失或路径不存在时整个 describe 跳过（与 officialUnits.test.ts 同模式）。
 *
 * 引擎语义锚（反编译 ae.java/ag.java 实证）：
 * - 节名 = \s*\[([^]]*)\]\s*：除 ] 外任意字符；键名除 = : 外任意字符；
 * - action_/hiddenAction_ 前缀节即行动（startsWith，后缀无字符限制）；
 * - 匹配精确大小写敏感；# 整行注释；""" 多行值；BOM 剥离。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { scanResources, scanUnits, checkMod } from '../electron/modTools'

interface RealModConfig {
  name: string
  root: string
  errorBudget: number
}

const CONFIG_PATH = path.join(process.cwd(), 'tests', 'real-mods.config.json')
/** 本地配置文件 → 模组清单；缺失/损坏时为空数组（测试整体跳过） */
function loadModRoots(): RealModConfig[] {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return []
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as unknown
    const arr = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { mods?: unknown }).mods) ? (parsed as { mods: unknown[] }).mods : []
    return arr.filter(
      (m): m is RealModConfig =>
        typeof m === 'object' && m !== null && typeof (m as RealModConfig).name === 'string' && typeof (m as RealModConfig).root === 'string',
    )
  } catch {
    return []
  }
}

const MOD_ROOTS = loadModRoots()

// 占位套件：配置文件缺失时（CI/他人 clone）文件不能为空——vitest 对零测试文件报 Failed Suites。
// 有配置时本套件跳过，真实模组回归由下方循环生成。
describe.skipIf(MOD_ROOTS.length > 0)('真实模组回归（未配置）', () => {
  it('缺少本地配置文件 tests/real-mods.config.json，跳过真实模组回归', () => {
    expect(true).toBe(true)
  })
})

const DATA_DIR = path.join(process.cwd(), 'public', 'data')

/** 供 loadCodeData 的真实数据（Node 下 fetch 不可用，stub 返回 public/data 内容） */
function stubDataFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url)
    const name = u.replace(/^.*?data\//, '').replace(/^\//, '')
    try {
      const content = await fsp.readFile(path.join(DATA_DIR, name), 'utf8')
      return { ok: true, status: 200, json: async () => JSON.parse(content) } as Response
    } catch {
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }
  })
}

/** 真 fs 桥（generateModReport 依赖注入：fs 通道要求绝对路径） */
function makeRealFsBridge() {
  return {
    mod: { scanResources: (r: string) => scanResources(r) },
    project: {
      readFile: async (_r: string, f: string) => ({ content: await fsp.readFile(f, 'utf8'), hasBom: false }),
      readDir: async (_r: string, dir: string) =>
        (await fsp.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
    },
  }
}

/** 输出汇总（跑数据用；每个模组一段） */
function summarize(label: string, stats: Record<string, string | number>): void {
  const lines = Object.entries(stats).map(([k, v]) => `${k}=${v}`)
  console.log(`\n[realMods] ${label} ${lines.join(' ')}`)
}

for (const mod of MOD_ROOTS) {
  const exists = fs.existsSync(mod.root)
  describe.skipIf(!exists)(`真实模组：${mod.name}`, () => {
    afterEach(() => vi.unstubAllGlobals())

    it('scanResources/scanUnits/checkMod 全量跑通（不崩溃、有单位）', async () => {
      const scan = await scanResources(mod.root)
      expect(scan.files.length).toBeGreaterThan(0)
      const units = await scanUnits(mod.root)
      summarize(mod.name, { 扫描文件数: scan.files.length, 单位名: scan.unitNames.length, 单位库: units.length })
      const check = await checkMod(mod.root)
      summarize(mod.name, { checkMod单位: check.unitCount, checkMod问题: check.issues.length })
      expect(check.unitCount).toBeGreaterThan(0)
      // checkMod 的 error 只允许两类模组自身问题（缺 name / 重复名），不允许其他异常
      for (const it of check.issues) {
        if (it.level !== 'error') continue
        expect(it.message).toMatch(/重复|缺少 \[core\] name/)
      }
    }, 120_000)

    it('generateModReport 全量检查（lint + 16 语义检查器）不崩溃', async () => {
      stubDataFetch()
      const { generateModReport } = await import('../src/features/modTools/modReport')
      const report = await generateModReport(mod.root, { projectName: mod.name }, makeRealFsBridge())
      summarize(mod.name, {
        ini文件: report.meta.fileCount,
        单位数: report.meta.unitCount,
        图片: report.meta.imageCount,
        音频: report.meta.audioCount,
        错误: report.errorCount,
        警告: report.warningCount,
        跳过: report.meta.skippedLargeFiles,
        异常: report.meta.checkFailedFiles,
      })
      expect(report.meta.checkFailedFiles).toBe(0)
      expect(report.meta.unitCount).toBeGreaterThan(0)
      // 全量检查器汇总（不受 500 条清单上限影响）
      for (const c of report.checkerSummary) {
        summarize(`${mod.name} 检查器`, { ruleId: c.ruleId, errors: c.errors, warnings: c.warnings })
      }
      // 引擎合法语法零误报：action 前缀族（含数字/中文/小数点后缀）不得报「节名不合法」
      const actionFp = report.issues.filter((i) => i.ruleId === 'checkActionReferences' && i.message.includes('节名'))
      for (const fp of actionFp) summarize(`${mod.name} action误报`, { file: fp.file, line: fp.line, message: fp.message })
      expect(actionFp).toEqual([])
      // 文件级/正数/键拼写/弹体检查器在真实模组上零 error
      // （.template 模板、0 值判定单位、多资源价格、跨文件弹体引用均已引擎对齐）
      const expectZero = new Set(['checkFile', 'checkPositiveCoreStats', 'checkKeyTypos', 'checkProjectileLifecycle'])
      for (const c of report.checkerSummary) {
        if (expectZero.has(c.ruleId)) expect(c.errors, `${mod.name} ${c.ruleId} 误报`).toBe(0)
      }
      // checkKeyTypos 的 warning 也零误报（黄色感叹号盲区：此前只断言 errors，
      // 词典被虚构节 prices 覆盖后中文键「价格」回译失败会误报「不在代码表」）
      for (const c of report.checkerSummary) {
        if (c.ruleId === 'checkKeyTypos') expect(c.warnings, `${mod.name} checkKeyTypos warning 误报`).toBe(0)
      }
      // 剩余 error 只允许模组自身问题（引擎同样会报，如 isLockedAlt2 写了提示文本）：
      // 上限兜底防回归（模组更新后若引擎合法语法再次被误报，这里会先炸）
      expect(report.errorCount, `${mod.name} 总 error 超模组自身问题上限`).toBeLessThanOrEqual(mod.errorBudget)
    }, 120_000)

    it('引擎「= 分隔符」也解析（IniReader 正则 [^=:]* 同时认 = 和 :）', async () => {
      // 采样：扫描里是否有用 = 分隔的键值行（引擎支持，app 解析器只认 : —— 这里是摸底）
      const scan = await scanResources(mod.root)
      let eqLines = 0
      const sample: string[] = []
      for (const f of scan.files.filter((x) => /\.(ini|template)$/i.test(x)).slice(0, 400)) {
        const content = await fsp.readFile(path.join(mod.root, f), 'utf8').catch(() => '')
        for (const line of content.split(/\r?\n/)) {
          const t = line.trim()
          if (t && !t.startsWith('#') && !t.startsWith('[') && t.includes('=') && !t.includes(':') && sample.length < 5) {
            eqLines++
            sample.push(`${f}: ${t}`)
          }
        }
      }
      summarize(mod.name, { 等号分隔行采样: eqLines })
      for (const s of sample) console.log(`  =分隔样例: ${s}`)
    }, 60_000)
  })
}
