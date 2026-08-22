/**
 * projectSlice 域拆分（M39 巨型函数治理）的共享层：
 * 各域动作文件（projectTree/Tabs/Files/ModTools）与主编排（projectSlice.ts）
 * 共用的依赖类型、翻译辅助与路径工具。本文件不反向依赖任何 slice 文件。
 */
import type { StoreApi } from 'zustand'
import type { EditorTab, ProjectInfo } from '../../types/domain'
import type { BridgeApi } from '../../types/bridge'
import type { WorkspaceStore } from '../types'
import {
  getAllCodes, getAllSections, getEnToZhDict, getKeyZhToEnDict, getLogicIdentifierEnToZhDict,
  getLogicIdentifierZhToEnDict, getLogicValueKeys, getPreserveValueKeys, getSectionZhToEnDict,
  getZhToEnDict, isPreserveValueKey, normalizeValueForEngine,
} from '../../services/codeData'
import { makeDict, zhToEn } from '../../services/translation'
import { normalizeKeyValueSeparators } from '../../services/configSyntax'

export interface ProjectSliceDeps {
  bridge: BridgeApi
  /** 持久化（由组合根注入：防抖写 settings + workspace） */
  persist: () => void
}

/** 各域动作共享的上下文：由 createProjectSlice 创建并下发 */
export interface ProjectSliceContext {
  set: StoreApi<WorkspaceStore>['setState']
  get: () => WorkspaceStore
  deps: ProjectSliceDeps
  /** 标签撤销/重做历史（按标签 id；切换项目等边界由动作清理） */
  historyByTab: Map<string, { undo: string[]; redo: string[] }>
  /** 当前活动项目（无项目返回 null） */
  activeProject: () => ProjectInfo | null
}

export function projectTranslationDict() {
  return makeDict(
    getEnToZhDict(),
    getZhToEnDict(),
    getKeyZhToEnDict(),
    getSectionZhToEnDict(),
    getLogicIdentifierZhToEnDict(),
    getLogicIdentifierEnToZhDict(),
    getPreserveValueKeys(),
    getLogicValueKeys(),
    isPreserveValueKey,
    normalizeValueForEngine,
  )
}

/** 标签内容 → 写盘内容（翻译模式回译；ini/template 再做键分隔符规范化） */
export function contentForDisk(content: string, tab: EditorTab): string {
  const translated = tab.translationEnabled ? zhToEn(content, projectTranslationDict(), tab.translationMap) : content
  return /\.(ini|template)$/i.test(tab.path) ? normalizeKeyValueSeparators(translated) : translated
}

/** 中文模式打开/重载 .ini 时修复已写成中文的节名/字段名用的词典 */
export function repairDictionary() {
  return {
    sections: getAllSections(),
    codes: getAllCodes().map((code) => ({ code: code.code, translate: code.translate, type: code.type })),
    logicIdentifiers: getLogicIdentifierZhToEnDict(),
  }
}

/** 标签路径去重比较：Windows 分隔符/大小写不敏感——
 * 树节点（反斜杠绝对路径）与单位库（joinProjectPath 混合分隔符）打开同一文件
 * 时按字符串比较会变成两个标签，这里统一规范化后比较 */
export function sameTabPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** 路径归一化（分隔符 → /，小写）：用于前缀匹配与替换定位（\\/ 与大小写均为 1:1 映射，
 * 归一化后的长度与原串一致，slice 索引可直接用于原串） */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 路径前缀匹配（目录 target 匹配自身与子路径；分隔符/大小写不敏感） */
export function pathStartsWith(path: string, target: string): boolean {
  if (path === target) return true
  return normPath(path).startsWith(normPath(target) + '/')
}

/** 替换路径前缀（target 匹配到的最前位置；分隔符/大小写不敏感，替换段保持 replacement 原文） */
export function replacePathPrefix(path: string, target: string, replacement: string): string {
  const idx = normPath(path).indexOf(normPath(target))
  if (idx < 0) return path
  return path.slice(0, idx) + replacement + path.slice(idx + target.length)
}

/** 切换/导入/移除项目时的工作区状态重置（原 4 处复制粘贴块收拢于此；
 * 曾因漏抄 translationRepair 两个字段导致导入项目残留上个项目的修复结果——串数据）。
 * activeConversationId 的恢复值（selectProject 从历史取）由调用方在展开后覆盖。 */
export function resetProjectWorkspaceState(): Pick<WorkspaceStore,
  'openTabs' | 'activeTabId' | 'treeRoot' | 'treeError' | 'activeConversationId' |
  'modCheckResult' | 'optimizeItems' | 'optimizeError' | 'translationRepairItems' |
  'translationRepairError' | 'modDialog' | 'modReport' | 'modReportOpen' | 'modReportError' | 'modReportProgress'
> {
  return {
    openTabs: [],
    activeTabId: null,
    treeRoot: null,
    treeError: null,
    activeConversationId: null,
    modCheckResult: null,
    optimizeItems: null,
    optimizeError: null,
    translationRepairItems: null,
    translationRepairError: null,
    modDialog: null,
    modReport: null,
    modReportOpen: false,
    modReportError: null,
    modReportProgress: null,
  }
}
