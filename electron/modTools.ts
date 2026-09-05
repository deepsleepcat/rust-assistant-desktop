/**
 * 模组工具组合入口（M40 巨型文件拆分批次 A）：
 * 实现按域拆分到独立文件，本文件只保留兼容 re-export——
 * ipc.ts、game.ts 与既有测试的导入路径全部不变。
 *
 * 域划分：
 * - modShared            路径安全/受限读取（resolveInside/readTextLimited）
 * - modIni               INI 解析与自述文件读写
 * - modScan              资源/单位扫描 + 打包排除规则
 * - modCheck             模组检查 + 链式规则
 * - modOptimization      优化工具 + 全局批处理
 * - modTranslationRepair 中文翻译损坏恢复
 * - modTemplates         模板系统
 * - modPack              打包/导入/部署
 * - modCreate            模组创建 + 音频转码
 * - modUnit              单位创建/复制
 */

export type { CreateModParams, IniSection, ModInfoData } from './modIni'
export {
  buildModInfo,
  buildUnitSkeleton,
  escapeIniComment,
  isValidUpdateUrl,
  readModInfo,
  writeModInfo,
} from './modIni'

export { PACK_EXCLUDE_PATTERNS, isExcluded, scanResources, scanUnits, type UnitEntry } from './modScan'

export type { ChainRule, ModCheckIssue, ModCheckResult } from './modCheck'
export { checkMod, loadChainRules, runChainInspection } from './modCheck'

export type { GlobalOpKind, GlobalOpParams, GlobalOpResult, OptimizeItem } from './modOptimization'
export { applyOptimization, globalOp, scanOptimization } from './modOptimization'

export type {
  TranslationRepairApplyResult,
  TranslationRepairPreview,
  TranslationRepairScanResult,
  TranslationRepairSelection,
  TrustedProjectRoot,
} from './modTranslationRepair'
export {
  isRepairSourceFile,
  makeTrustedProjectRoot,
  normalizeRepairRelativePath,
  processRepairSelections,
  scanTranslationRepair,
} from './modTranslationRepair'

export type { RawTemplate } from './modTemplates'
export {
  buildFileFromTemplate,
  buildTemplateFromFile,
  createUnitFromTemplate,
  deleteUserTemplate,
  importTemplateFile,
  listTemplates,
  listUserTemplateKeys,
  saveFileAsTemplate,
} from './modTemplates'

export type { PackOptions } from './modPack'
export {
  deployMod,
  formatIniText,
  importModBuffer,
  packModBuffer,
  packModBufferWithCount,
  processSourceForPack,
} from './modPack'

export { createMod, transcodeToOgg } from './modCreate'

export type { CopyUnitParams } from './modUnit'
export { copyUnit, createUnit } from './modUnit'

import { processRepairSelections } from './modTranslationRepair'

/** 兼容旧调用方；安全校验由 applyVerifiedTranslationRepair 自身执行。 */
export const applyTranslationRepair = processRepairSelections
