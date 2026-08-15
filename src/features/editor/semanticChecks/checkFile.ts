/**
 * 文件级检查（checkFile）：
 * 单位文件必须有 [core] 节和 name 键（无 core 的文件不会被游戏加载为单位；
 * 无 name 则单位无法注册）；name 值不允许含空白字符（name 是内部唯一标识，
 * 官方单位为小驼峰，含空格会导致引用失效）。
 * 非单位文件（mod-info.txt、地图等）没有 [core] 时不报——只有文件里出现
 * 任意已知单位节（core/graphics/movement）时才要求 core 完整。
 * .template 是模板源文件（引擎只加载 .ini；.template 仅在 copyFrom 引用时
 * 生效，ag.java:3760 目录扫描只认 endsWith(".ini")），不要求 [core]/name。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, getIni, sectionEnName, toEnKey } from './helpers'

/** 这些节出现即视为单位文件 */
const UNIT_SECTIONS = new Set(['core', 'graphics', 'movement', 'attack', 'turret_', 'projectile_'])

export const checkFile: SemanticChecker = {
  id: 'checkFile',
  title: '文件级检查',
  description: '单位文件必须有 [core] + name，name 不允许空白字符',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    // .template 模板源文件不要求 [core]/name（引擎不加载 .template 为单位）
    if (ctx?.file && /\.template$/i.test(ctx.file)) return issues
    const { sections } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    if (sections.length === 0) return issues // 空文件/纯注释：不打扰

    const isUnitFile = sections.some((s) => {
      const lower = sectionEnName(s, zhToEn)
      return UNIT_SECTIONS.has(lower) || [...UNIT_SECTIONS].some((p) => p.endsWith('_') && lower.startsWith(p))
    })
    if (!isUnitFile) return issues

    const core = sections.find((s) => sectionEnName(s, zhToEn) === 'core')
    if (!core) {
      issues.push(
        issue(
          sections[0].startLine,
          `缺少 [core] 节，游戏不会把该文件加载为单位`,
          `在文件开头添加 [core] 节并声明 name（如 [core]\\nname: myUnit）`,
          'checkFile',
          'error',
          `[${sections[0].name}]`,
        ),
      )
      return issues
    }
    const name = keyValuesInSection(core).find((kv) => toEnKey(kv.key, zhToEn).toLowerCase() === 'name')
    if (!name) {
      issues.push(
        issue(
          core.startLine,
          `[core] 节缺少 name 键，单位无法注册`,
          `在 [core] 节添加 name: <单位唯一标识>（如 name: myTank）`,
          'checkFile',
          'error',
          `[${core.name}]`,
        ),
      )
    } else if (!name.value.trim()) {
      issues.push(
        issue(
          name.line,
          `单位 name 为空，单位无法注册`,
          `填写单位唯一标识（如 name: myTank）`,
          'checkFile',
          'error',
          name.value,
        ),
      )
    } else if (/\s/.test(name.value)) {
      issues.push(
        issue(
          name.line,
          `单位 name「${name.value}」包含空白字符`,
          `name 是内部唯一标识，用无空格的小驼峰命名（如 myTank）；显示名用 displayLocaleKey/description`,
          'checkFile',
          'warning',
          name.value,
        ),
      )
    }
    return issues
  },
}
