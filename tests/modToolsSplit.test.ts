/**
 * M40 巨型文件拆分回归（批次 A/B）：
 * - modTools.ts 保留为兼容 façade，断言关键导出与域实现为同一函数/类型可达；
 * - modTranslationRepair 的路径校验函数此前缺少直接单测（路径穿越/NUL/超长/扩展名），
 *   拆分后从域文件直接导入补充覆盖。
 */
import { describe, expect, it } from 'vitest'
import * as facade from '../electron/modTools'
import * as ini from '../electron/modIni'
import * as scan from '../electron/modScan'
import * as check from '../electron/modCheck'
import * as optimization from '../electron/modOptimization'
import * as repair from '../electron/modTranslationRepair'
import * as templates from '../electron/modTemplates'
import * as pack from '../electron/modPack'
import * as create from '../electron/modCreate'
import * as unit from '../electron/modUnit'
import { normalizeRepairRelativePath, isRepairSourceFile } from '../electron/modTranslationRepair'

/** façade 的再导出必须与域实现同一引用（防止 re-export 遗漏或双实现漂移） */
describe('modTools façade 再导出同一性', () => {
  const identity: Array<[string, unknown, unknown]> = [
    ['scanResources', facade.scanResources, scan.scanResources],
    ['scanUnits', facade.scanUnits, scan.scanUnits],
    ['isExcluded', facade.isExcluded, scan.isExcluded],
    ['PACK_EXCLUDE_PATTERNS', facade.PACK_EXCLUDE_PATTERNS, scan.PACK_EXCLUDE_PATTERNS],
    ['checkMod', facade.checkMod, check.checkMod],
    ['runChainInspection', facade.runChainInspection, check.runChainInspection],
    ['loadChainRules', facade.loadChainRules, check.loadChainRules],
    ['scanOptimization', facade.scanOptimization, optimization.scanOptimization],
    ['applyOptimization', facade.applyOptimization, optimization.applyOptimization],
    ['globalOp', facade.globalOp, optimization.globalOp],
    ['processRepairSelections', facade.processRepairSelections, repair.processRepairSelections],
    ['makeTrustedProjectRoot', facade.makeTrustedProjectRoot, repair.makeTrustedProjectRoot],
    ['scanTranslationRepair', facade.scanTranslationRepair, repair.scanTranslationRepair],
    ['isRepairSourceFile', facade.isRepairSourceFile, repair.isRepairSourceFile],
    ['normalizeRepairRelativePath', facade.normalizeRepairRelativePath, repair.normalizeRepairRelativePath],
    ['listTemplates', facade.listTemplates, templates.listTemplates],
    ['saveFileAsTemplate', facade.saveFileAsTemplate, templates.saveFileAsTemplate],
    ['buildTemplateFromFile', facade.buildTemplateFromFile, templates.buildTemplateFromFile],
    ['buildFileFromTemplate', facade.buildFileFromTemplate, templates.buildFileFromTemplate],
    ['createUnitFromTemplate', facade.createUnitFromTemplate, templates.createUnitFromTemplate],
    ['importTemplateFile', facade.importTemplateFile, templates.importTemplateFile],
    ['deleteUserTemplate', facade.deleteUserTemplate, templates.deleteUserTemplate],
    ['listUserTemplateKeys', facade.listUserTemplateKeys, templates.listUserTemplateKeys],
    ['packModBuffer', facade.packModBuffer, pack.packModBuffer],
    ['packModBufferWithCount', facade.packModBufferWithCount, pack.packModBufferWithCount],
    ['importModBuffer', facade.importModBuffer, pack.importModBuffer],
    ['deployMod', facade.deployMod, pack.deployMod],
    ['processSourceForPack', facade.processSourceForPack, pack.processSourceForPack],
    ['formatIniText', facade.formatIniText, pack.formatIniText],
    ['createMod', facade.createMod, create.createMod],
    ['transcodeToOgg', facade.transcodeToOgg, create.transcodeToOgg],
    ['createUnit', facade.createUnit, unit.createUnit],
    ['copyUnit', facade.copyUnit, unit.copyUnit],
    ['readModInfo', facade.readModInfo, ini.readModInfo],
    ['writeModInfo', facade.writeModInfo, ini.writeModInfo],
    ['buildModInfo', facade.buildModInfo, ini.buildModInfo],
    ['buildUnitSkeleton', facade.buildUnitSkeleton, ini.buildUnitSkeleton],
    ['escapeIniComment', facade.escapeIniComment, ini.escapeIniComment],
    ['isValidUpdateUrl', facade.isValidUpdateUrl, ini.isValidUpdateUrl],
  ]
  it('全部关键导出与域实现同一', () => {
    for (const [name, a, b] of identity) {
      expect(a, name).toBe(b)
    }
  })
  it('applyTranslationRepair 别名仍指向 processRepairSelections', () => {
    expect(facade.applyTranslationRepair).toBe(repair.processRepairSelections)
  })
})

describe('翻译修复路径校验（拆分后补直接单测）', () => {
  it('normalizeRepairRelativePath 接受安全相对路径并统一正斜杠', () => {
    expect(normalizeRepairRelativePath('units/a.ini')).toBe('units/a.ini')
    expect(normalizeRepairRelativePath('units\\a.template')).toBe('units/a.template')
  })
  it('拒绝绝对路径、穿越段、NUL、空串与超长路径', () => {
    expect(() => normalizeRepairRelativePath('C:/x.ini')).toThrow('修复文件路径无效')
    expect(() => normalizeRepairRelativePath('../x.ini')).toThrow('修复文件路径无效')
    expect(() => normalizeRepairRelativePath('a/../b.ini')).toThrow('修复文件路径无效')
    expect(() => normalizeRepairRelativePath('a//b.ini')).toThrow('修复文件路径无效')
    expect(() => normalizeRepairRelativePath('a\0b.ini')).toThrow('修复文件路径无效')
    expect(() => normalizeRepairRelativePath('')).toThrow('修复文件路径无效')
    expect(() => normalizeRepairRelativePath('a/'.repeat(600) + 'x.ini')).toThrow('修复文件路径无效')
  })
  it('isRepairSourceFile 只放行 .ini/.template', () => {
    expect(isRepairSourceFile('units/a.ini')).toBe(true)
    expect(isRepairSourceFile('units/a.TEMPLATE')).toBe(true)
    expect(isRepairSourceFile('units/a.txt')).toBe(false)
    expect(isRepairSourceFile('units/a.ini.exe')).toBe(false)
    expect(isRepairSourceFile('units/a')).toBe(false)
  })
})
