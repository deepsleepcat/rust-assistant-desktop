/**
 * 真实模组一键检查（M28）：用「深渊星辰」两个真实模组全量回归 app 的
 * 扫描/检查管线（lint + 16 语义检查器 + 主进程 checkMod）。
 *
 * 用法：npm run check:real-mods
 * - 模组目录在 W:\mao\tx\ 下（只读，绝不修改/复制）；
 * - 目录不存在时测试自动跳过（如换机器）；
 * - 断言：解析零崩溃（checkFailedFiles === 0）、引擎合法语法零误报
 *   （action 节名/枚举值/表达式/单位列表语法等）；
 * - 剩余 error 只允许「模组自身问题」（引擎同样会报），有上限兜底。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const vitestEntry = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(
  process.execPath,
  // 直接调用本地 Vitest 入口，避免 Windows 下 spawnSync(npx.cmd) 返回 EINVAL。
  // vitest 4 已移除 basic reporter（加载会直接启动失败），用默认 reporter。
  [vitestEntry, 'run', 'tests/realMods.test.ts'],
  { stdio: 'inherit', cwd: projectRoot },
)

console.log('\n──────── 真实模组检查 ────────')
if (result.status === 0) {
  console.log('✓ 两个模组全量检查通过：解析零崩溃，引擎合法语法零误报')
  console.log('  （剩余 warning/error 为模组自身问题：0 值判定单位、引用不存在单位等）')
} else {
  console.log('✗ 检查失败（详见上方 vitest 输出）')
}
process.exit(result.status ?? 1)
