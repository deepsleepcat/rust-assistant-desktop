/**
 * 代码数据服务（M40 巨型文件拆分：本文件是兼容 façade）：
 * - codeDataState.ts  数据加载与内存索引（键/节/值类型/翻译词典/词库）
 * - codeDataLookup.ts 查询函数（代码/节/值类型/词库/枚举规范化）
 * 所有既有导入路径（编辑器/lint/AI 质检/版本差异/设置页等）不变。
 */

export type {
  CodeInfo,
  SectionInfo,
  ValueTypeInfo,
  VocabularyItem,
  LogicBooleanInfo,
  OfficialUnitInfo,
  GameVersionInfo,
} from './codeDataState'
export type { DataVersionInfo } from './codeDataLookup'

export {
  dataReady,
  loadCodeData,
  reloadCodeData,
  getEnToZhDict,
  getZhToEnDict,
  getKeyZhToEnDict,
  getSectionZhToEnDict,
  getValueZhDict,
  getPluginEnumExplanation,
  getValueZhToEnDict,
  getValueZhToEnCandidates,
  getLogicIdentifierZhToEnDict,
  getLogicIdentifierEnToZhDict,
  getLogicValueKeys,
  getPreserveValueKeys,
  isPreserveValueKey,
  getAliasDict,
  getCustomValueTypes,
  saveCustomValueTypes,
} from './codeDataState'

export {
  resolveValueZhToEn,
  normalizeValueForEngine,
  aliasMatches,
  zhToEnKeySegments,
  normalizeSectionName,
  findCodesBySection,
  findCodesByQuery,
  findCodeByCode,
  findCodesByType,
  findSectionsByQuery,
  getAllSections,
  getAllCodes,
  getAllValueTypes,
  getAllOfficialUnits,
  getGameVersions,
  versionNameToNumber,
  versionNumberToName,
  latestVersionNumber,
  getDataVersionInfo,
  findValueType,
  findValueTypes,
  parseValueList,
  findLogicBoolean,
  searchLogicBooleans,
  searchVocabulary,
  getDialectWords,
  codeInfoToCompletion,
} from './codeDataLookup'
