/**
 * 版本兼容提示（checkVersionCompatibility，M11，P1 任务 3）：
 * 代码表字段带 addVersion（加入版本号）/removeVersion（移除版本号，
 * ≥0 表示已移除）。
 * - 字段加入版本晚于目标版本 → 警告（旧版本游戏会静默忽略该字段）；
 * - 字段已移除且移除版本 ≤ 目标版本 → 警告（字段已失效/被取代）。
 * 目标版本由设置「当前项目目标游戏版本」提供（ctx.targetVersionNumber，
 * 缺省 = 最新版本，此时不会有过新字段）。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, getIni, toEnKey } from './helpers'
import { latestVersionNumber, versionNumberToName } from '../../../services/codeData'

export const checkVersionCompatibility: SemanticChecker = {
  id: 'checkVersionCompatibility',
  title: '版本兼容提示',
  description: '写入的字段与当前项目目标游戏版本的兼容性（过新/已移除）',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    if (!ctx?.findCode) return issues
    const target = ctx.targetVersionNumber ?? latestVersionNumber()
    if (target === undefined) return issues // 版本数据缺失：跳过（不误报）
    const { keyValues } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    const seen = new Set<string>()
    for (const kv of keyValues) {
      const enKey = toEnKey(kv.key, zhToEn)
      const lower = enKey.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      const code = ctx.findCode(enKey)
      if (!code) continue
      // 过新字段：加入版本 > 目标版本 → 旧游戏不识别
      if (typeof code.addVersion === 'number' && code.addVersion > target) {
        const addedName = versionNumberToName(code.addVersion)
        issues.push(
          issue(
            kv.line,
            `「${kv.key}」在版本 ${addedName ?? code.addVersion} 才加入，目标版本不认识该字段`,
            `把项目目标版本升级到 ${addedName ?? code.addVersion} 及以上，或移除该字段`,
            'checkVersionCompatibility',
            'warning',
            kv.value,
          ),
        )
      }
      // 已移除字段：removeVersion ≥ 0 且 ≤ 目标版本 → 字段已失效
      if (typeof code.removeVersion === 'number' && code.removeVersion >= 0 && code.removeVersion <= target) {
        const removedName = versionNumberToName(code.removeVersion)
        issues.push(
          issue(
            kv.line,
            `「${kv.key}」在版本 ${removedName ?? code.removeVersion} 已被移除/弃用`,
            `查找替代字段，或确认目标版本仍支持该字段`,
            'checkVersionCompatibility',
            'warning',
            kv.value,
          ),
        )
      }
    }
    return issues
  },
}
