/**
 * 语义检查器框架类型（M10，P1 任务 1）：
 * 把 M9 的基础 lint（值类型校验）升级为「铁锈语义级」检查器框架——
 * 每个检查器是一个可独立开关的规则，输出统一格式
 * （文件 + 行号 + 原因 + 修复建议 + 证据），供编辑器波浪线、
 * AI 写后自动质检、手动全量检查共用。
 *
 * 设计：检查器都是同步纯函数（content + ctx），便于测试与串行执行；
 * 需要项目级数据的规则（单位引用等）通过 ctx 注入可选数据，
 * 拿不到数据时跳过引用类检查（降级，不影响其它规则）。
 */
import type { ValueTypeInfo } from '../../../services/codeData'

/** 单条检查结果：行号（1 基）+ 原因 + 严重度 + 修复建议 + 规则 id + 证据（该行原文） */
export interface SemanticIssue {
  line: number
  message: string
  severity: 'error' | 'warning' | 'info'
  suggestion: string
  /** 规则 id（registry 中的检查器 id） */
  ruleId: string
  /** 证据：触发问题的原文（UI 展示「证据」列） */
  evidence?: string
}

/** 检查器上下文：代码表查询 + 可选的跨文件数据 */
export interface SemanticCheckContext {
  /** 键 → 代码表条目（大小写不敏感由实现方保证；版本字段供版本兼容检查） */
  findCode?: (key: string) => { type: string; description?: string; demo?: string; addVersion?: number; removeVersion?: number } | undefined
  /** 值类型查询（枚举 list 等） */
  findType?: (type: string) => ValueTypeInfo | undefined
  /** 中文显示层回译（中文键/值 → 英文） */
  zhToEn?: (key: string) => string | undefined
  /** 项目内单位名集合（危险引用/action 引用检查用；缺省跳过引用类检查） */
  unitNames?: ReadonlySet<string>
  /** 代码表全部英文键（键名拼写检查的候选池；缺省跳过拼写检查） */
  codes?: readonly string[]
  /** 当前项目目标游戏版本号（版本兼容检查用；缺省 = 最新版本） */
  targetVersionNumber?: number
  /** 共享解析结果（runSemanticChecks 注入，避免每个检查器重复扫描全文；检查器用 getIni 取） */
  parsed?: import('./helpers').ParsedIni
}

/** 检查器定义：id 全局唯一，title/description 供设置页展示 */
export interface SemanticChecker {
  id: string
  title: string
  description: string
  /** 默认开启（用户可在设置里单独关闭） */
  defaultOn: boolean
  check: (content: string, ctx: SemanticCheckContext) => SemanticIssue[]
}

/** 运行选项 */
export interface SemanticCheckOptions {
  /** 要运行的规则 id 集合；缺省 = 全部启用中的规则（由调用方过滤后传入） */
  ruleIds?: ReadonlySet<string>
  ctx?: SemanticCheckContext
}
