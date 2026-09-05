/**
 * 模组工具与模板库 IPC（M40 巨型文件拆分批次 B4）。
 * 写操作互斥（packing）、音乐源白名单、导入目录登记与清理边界都在本域。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { isPathInside, normalizePath } from './paths'
import { buildLogicIdentifierMap } from '../src/services/translationRepair'
import {
  applyOptimization, checkMod, copyUnit, createMod, createUnit, createUnitFromTemplate, makeTrustedProjectRoot, processRepairSelections,
  deleteUserTemplate, deployMod, globalOp, importModBuffer, importTemplateFile, isRepairSourceFile,
  listTemplates, listUserTemplateKeys, normalizeRepairRelativePath, packModBufferWithCount, readModInfo,
  saveFileAsTemplate, scanOptimization, scanResources, scanTranslationRepair, scanUnits, writeModInfo,
} from './modTools'
import { requireInsideRoot, requireRealInsideRoot, registerRoot, exists, PROJECT_ROOTS_KEY } from './projectTrust'

/** 显式目录边界断言（防御性冗余；调用点均已先做信任锚校验） */
function assertInsideDir(base: string, target: string): void {
  if (!isPathInside(path.resolve(base), target)) throw new Error('目标路径超出项目目录范围，拒绝访问')
}

/** 模组工具与模板库 */
export function registerModIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  // M6.5 模板系统：模板列表 / 基于模板创建单位
  // M7：模板列表合并用户模板目录（userData/templates），并支持把单位文件保存为模板
  const userTemplatesDir = path.join(ctx.app.getPath('userData'), 'templates')

  ipc('mod:create', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    const p = (params ?? {}) as { musicFiles?: unknown }
    // L11：背景音乐源文件必须来自「选择音乐」对话框（会话内登记），拒绝渲染层传入任意路径
    if (Array.isArray(p.musicFiles)) {
      for (const f of p.musicFiles) {
        if (typeof f !== 'string' || !ctx.musicSources.has(normalizePath(f))) {
          throw new Error('包含未经选择的音频文件，已拒绝转换（请重新通过「选择音乐」添加）')
        }
      }
    }
    return createMod(rootPath, params as import('./modTools').CreateModParams)
  })

  ipc('mod:createUnit', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return createUnit(rootPath, params as { name: string; displayName?: string; folder?: string })
  })

  ipc('mod:listTemplates', async () => listTemplates([userTemplatesDir]))

  // M23 模板库管理：导入（文件对话框 → 校验 → 复制进用户目录）/ 删除用户模板 / 用户模板 key 列表
  ipc('template:import', async () => {
    const picked = await ctx.dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '模板文件（JSON）', extensions: ['json'] }] })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importTemplateFile(userTemplatesDir, picked.filePaths[0])
  })
  ipc('template:deleteUser', async (_event, key: unknown) => {
    if (typeof key !== 'string') return { ok: false, message: '参数错误' }
    return deleteUserTemplate(userTemplatesDir, key)
  })
  ipc('template:listUserKeys', async () => listUserTemplateKeys(userTemplatesDir))
  ipc('mod:saveFileAsTemplate', async (_event, rootPath: string, filePath: string, templateName: string, content?: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return saveFileAsTemplate(rootPath, filePath, templateName, userTemplatesDir, content)
  })
  ipc('mod:createUnitFromTemplate', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return createUnitFromTemplate(rootPath, params as { name: string; folder?: string; templateKey: string; values: Record<string, string> }, [userTemplatesDir])
  })

  // 写操作互斥：打包/全局操作都是批量 IO + 可能改写文件，并发会让内容互相覆盖。
  // 打包是全程内存 + 大量 IO 操作，并发两次会让内存翻倍且内容可能不一致
  ipc('mod:pack', async (_event, rootPath: string, options?: import('./modTools').PackOptions) => {
    if (ctx.packing.active) throw new Error('已有打包任务正在进行，请稍候')
    ctx.packing.active = true
    try {
      requireInsideRoot(ctx, rootPath, rootPath)
      // 只打包一次（避免打包两次之间文件变化导致 size/files 与写入内容不一致，也省一半 CPU）
      const { buffer, files, skippedLinks } = await packModBufferWithCount(rootPath, options ?? {})
      const suggested = path.join(path.dirname(rootPath), `${path.basename(rootPath)}.rwmod`)
      const result = await ctx.dialog.showSaveDialog({
        title: '保存打包文件',
        defaultPath: suggested,
        filters: [{ name: '铁锈战争模组包', extensions: ['rwmod'] }, { name: '压缩包', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.writeFile(result.filePath, buffer)
      return { canceled: false, filePath: result.filePath, size: buffer.byteLength, files, skippedLinks }
    } finally {
      ctx.packing.active = false
    }
  })

  // mod:pack 已合并为单次打包（见上）；未暴露给界面的 packTo 已移除（最小特权）

  // M35 F3：打包并部署到游戏 mods/units 目录（一键验证：打包→部署→启动）。
  // 与 mod:pack 同一互斥域；游戏目录不是项目根——目录判定在 deployMod 内部
  // 与 looksLikeGameDir 同标准，文件名清洗防穿越，同名未确认覆盖返回 EXISTS
  ipc('mod:packAndDeploy', async (_event, rootPath: unknown, options: unknown, gamePath: unknown, overwrite: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) throw new Error('项目目录为空')
    if (typeof gamePath !== 'string' || !gamePath) return { ok: false, message: '请先在设置中配置游戏安装目录' }
    if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new Error('overwrite 参数必须是布尔值')
    if (ctx.packing.active) throw new Error('已有打包任务正在进行，请稍候')
    ctx.packing.active = true
    try {
      // 登记校验用规范化路径（大小写不敏感）；执行传原始 rootPath——
      // normalizePath 在 win32 会把路径转小写，部署文件名取项目根 basename，
      // 传小写会让游戏内模组名（= .rwmod 文件名）丢失大小写（MyTankMod→mytankmod）
      const normalized = normalizePath(rootPath)
      if (!ctx.roots.has(normalized)) throw new Error('项目目录未登记，拒绝访问')
      return await deployMod(rootPath, gamePath, (options ?? {}) as import('./modTools').PackOptions, overwrite === true)
    } finally {
      ctx.packing.active = false
    }
  })

  ipc('mod:check', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return checkMod(rootPath)
  })

  // 模组自述文件：读取（不存在返回 null）/ 写回（覆盖式）
  ipc('mod:readModInfo', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return readModInfo(rootPath)
  })
  ipc('mod:writeModInfo', async (_event, rootPath: string, data: import('./modTools').ModInfoData) => {
    await requireRealInsideRoot(ctx, rootPath, rootPath)
    if (!data || typeof data !== 'object' || typeof data.title !== 'string') {
      throw new Error('写入自述文件失败：参数不完整')
    }
    await writeModInfo(rootPath, data)
    return { ok: true }
  })

  // 扫描项目资源（文件列表 + 单位名），供编辑器补全联想
  ipc('mod:scanResources', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return scanResources(rootPath)
  })

  // 单位库：扫描项目内全部单位概要
  ipc('mod:scanUnits', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return scanUnits(rootPath)
  })

  // 翻译恢复词典只允许读取内置知识包的白名单文件（与 knowledgePack 内部 DATA_FILE_NAMES 一致，
  // 在调用点显式约束，防止将来误传外部文件名）。
  const DICTIONARY_FILE_NAMES = new Set(['code.json', 'section.json', 'logicboolean.json', 'translations.json'])
  const readDictionaryFile = async (name: string) => {
    if (!DICTIONARY_FILE_NAMES.has(name)) throw new Error('不允许的数据文件')
    return ctx.knowledgePack.readDataFile(name)
  }

  const translationRepairDictionary = async () => {
    const [codeRaw, sectionRaw, logicRaw, translationsRaw] = await Promise.all([
      readDictionaryFile('code.json'),
      readDictionaryFile('section.json'),
      readDictionaryFile('logicboolean.json'),
      readDictionaryFile('translations.json'),
    ])
    const code = JSON.parse(codeRaw.content) as { data?: unknown }
    const section = JSON.parse(sectionRaw.content) as { data?: unknown }
    const logic = JSON.parse(logicRaw.content) as { data?: unknown }
    const translations = JSON.parse(translationsRaw.content) as { words?: unknown[]; data?: unknown[] }
    if (!Array.isArray(code.data) || !Array.isArray(section.data) || !Array.isArray(logic.data)) throw new Error('翻译恢复数据格式无效')
    const codes = code.data.filter((entry): entry is { code: string; translate: string; type?: string } =>
      !!entry && typeof entry === 'object' && typeof (entry as { code?: unknown }).code === 'string' && typeof (entry as { translate?: unknown }).translate === 'string',
    )
    const logicNames = logic.data
      .filter((entry): entry is { name: string } => !!entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')
      .map((entry) => entry.name)
    return {
      codes,
      sections: section.data.filter((entry): entry is { code: string; translate: string; needName?: boolean } =>
        !!entry && typeof entry === 'object' && typeof (entry as { code?: unknown }).code === 'string' && typeof (entry as { translate?: unknown }).translate === 'string',
      ),
      logicIdentifiers: buildLogicIdentifierMap(
        codes,
        logicNames,
        (translations.words ?? translations.data ?? []).filter((entry): entry is { en: string; zh: string } =>
          !!entry && typeof entry === 'object' && typeof (entry as { en?: unknown }).en === 'string' && typeof (entry as { zh?: unknown }).zh === 'string',
        ),
      ),
    }
  }

  // M38：扫描仅返回保守、可确定的译名恢复预览；不写入任何文件。
  ipc('mod:translationRepairScan', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) throw new Error('项目目录为空')
    await requireRealInsideRoot(ctx, rootPath, rootPath)
    return scanTranslationRepair(rootPath, await translationRepairDictionary())
  })

  // M38：写回只接受扫描结果中的相对路径与摘要；同批量 IO 互斥，防与打包/优化交叉覆盖。
  ipc('mod:translationRepairApply', async (_event, rootPath: unknown, selections: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) throw new Error('项目目录为空')
    if (!Array.isArray(selections)) throw new Error('修复选择无效')
    // 入口显式防御：与 modTools 内部的校验函数保持一致（单一事实来源）——
    // 只接受项目内的相对路径，拒绝绝对路径、空段、`.`/`..`、NUL 与超长路径；
    // 校验后重建规范化对象数组，避免把原始输入直接传入写文件流程。
    const verifiedSelections: Array<{ path: string; digest: string }> = []
    for (const selection of selections as Array<{ path?: unknown; digest?: unknown }>) {
      if (!selection || typeof selection.path !== 'string' || typeof selection.digest !== 'string') throw new Error('修复选择无效')
      const rel = normalizeRepairRelativePath(selection.path)
      if (!isRepairSourceFile(rel)) throw new Error('修复文件类型无效')
      verifiedSelections.push({ path: rel, digest: selection.digest })
    }
    if (ctx.packing.active) throw new Error('已有打包/全局操作正在进行，请稍候')
    ctx.packing.active = true
    try {
      await requireRealInsideRoot(ctx, rootPath, rootPath)
      const trustedRoot = [...ctx.roots].find((candidate) => normalizePath(candidate) === normalizePath(rootPath))
      if (!trustedRoot) throw new Error('项目目录未登记，拒绝访问')
      return processRepairSelections(
        makeTrustedProjectRoot(trustedRoot),
        await translationRepairDictionary(),
        verifiedSelections,
      )
    } finally {
      ctx.packing.active = false
    }
  })

  // M34 单位复制：从其它/同模组复制单位配置到当前项目。
  // 源与目标两端项目根都必须是已登记目录；真实文件级校验（越界/链接逃逸/
  // 单位格式/不覆盖）在 copyUnit 内完成，这里只做信任锚校验。
  ipc('mod:copyUnit', async (_event, params: import('./modTools').CopyUnitParams) => {
    if (!params || typeof params !== 'object') throw new Error('复制参数错误')
    if (typeof params.sourceRoot !== 'string' || typeof params.targetRoot !== 'string') throw new Error('复制参数缺少项目目录')
    if (typeof params.sourceFilePath !== 'string' || typeof params.targetName !== 'string') throw new Error('复制参数缺少源文件或目标名称')
    if (params.targetFolder !== undefined && typeof params.targetFolder !== 'string') throw new Error('复制参数中的目标文件夹无效')
    requireInsideRoot(ctx, params.sourceRoot, params.sourceRoot)
    requireInsideRoot(ctx, params.targetRoot, params.targetRoot)
    return copyUnit(params)
  })

  // 优化工具：扫描可优化项 / 执行优化
  ipc('mod:optimizeScan', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return scanOptimization(rootPath)
  })
  ipc('mod:optimizeApply', async (_event, rootPath: string, ids: string[]) => {
    // 优化（删文件/重写空行注释）与打包/全局操作都是批量改写，纳入同一互斥域
    if (ctx.packing.active) throw new Error('已有打包/全局操作正在进行，请稍候')
    ctx.packing.active = true
    try {
      requireInsideRoot(ctx, rootPath, rootPath)
      if (!Array.isArray(ids)) throw new Error('优化参数错误：缺少项目 id 列表')
      return await applyOptimization(rootPath, ids)
    } finally {
      ctx.packing.active = false
    }
  })

  // 全局操作：对整个模组源文件批量替换/头部附加/尾部附加（M 补齐手机版功能）
  ipc('mod:globalOp', async (_event, rootPath: string, params: import('./modTools').GlobalOpParams) => {
    if (ctx.packing.active) throw new Error('已有打包/全局操作正在进行，请稍候')
    ctx.packing.active = true
    try {
      requireInsideRoot(ctx, rootPath, rootPath)
      if (!params || typeof params !== 'object') throw new Error('全局操作参数错误')
      // 文本长度上限（防注入大文本刷盘）
      if (typeof params.text === 'string' && Buffer.byteLength(params.text, 'utf8') > 1024 * 1024) {
        throw new Error('文本过长（超过 1MB），已拒绝执行')
      }
      if (typeof params.find === 'string' && Buffer.byteLength(params.find, 'utf8') > 1024 * 1024) {
        throw new Error('查找文本过长（超过 1MB），已拒绝执行')
      }
      return await globalOp(rootPath, params)
    } finally {
      ctx.packing.active = false
    }
  })

  // M6.5 背景音乐：多选音频文件（mp3/wav/flac/m4a/ogg，转码在 createMod 时进行）
  // L11：返回的路径登记为「允许转码的音频源」，mod:create 只接受这个集合内的文件
  ipc('mod:chooseMusic', async () => {
    const result = await ctx.dialog.showOpenDialog({
      title: '选择背景音乐（可多选，将转换为 ogg）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    for (const p of result.filePaths) ctx.musicSources.add(normalizePath(p))
    return result.filePaths
  })

  // M6.5 导入模组：导入类型由应用内模态框明确传入。Windows/Linux 上一次系统对话框
  // 不能同时选文件和文件夹，所以主进程只打开与导入类型对应的一种原生选择器。
  ipc('mod:import', async (_event, kind: unknown) => {
    if (kind !== 'archive' && kind !== 'folder') throw new Error('无效的模组导入类型')
    if (kind === 'folder') {
      const pick = await ctx.dialog.showOpenDialog({ title: '选择模组文件夹', properties: ['openDirectory'] })
      if (pick.canceled || pick.filePaths.length === 0) return null
      const selected = pick.filePaths[0]
      registerRoot(ctx, selected)
      return { rootPath: selected, name: path.basename(selected) }
    }

    // 文件包：.rwmod/.zip（rwmod 即 zip 容器）
    const pick = await ctx.dialog.showOpenDialog({
      title: '选择模组文件（.rwmod / .zip）',
      properties: ['openFile'],
      filters: [{ name: '模组包', extensions: ['rwmod', 'zip'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (pick.canceled || pick.filePaths.length === 0) return null
    const selected = pick.filePaths[0]

    const dest = await ctx.dialog.showOpenDialog({
      title: '选择导入位置（将自动解压到该目录下）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (dest.canceled || dest.filePaths.length === 0) return null
    // baseName 清洗：非法字符 + 首尾点/空格（`...zip` 的 baseName 是 `..`，会路径穿越到父目录）
    let baseName = path.basename(selected, path.extname(selected)).replace(/[/:*?"<>|]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '')
    if (!baseName || baseName === '.' || baseName === '..') baseName = 'imported-mod'
    const destBase = dest.filePaths[0]
    let destRoot = path.join(destBase, baseName)
    // 显式边界断言：清洗后的子目录必须落在用户选择的导入目录内（baseName 已无分隔符/穿越段）
    assertInsideDir(destBase, destRoot)
    for (let suffix = 2; await exists(destRoot); suffix++) destRoot = path.join(destBase, `${baseName}-${suffix}`)
    // 原始包大小预检：超过 1GB 拒绝（全量读入内存的解压导入，超大包会 OOM）
    const pkgStat = await fs.stat(selected)
    if (pkgStat.size > 1024 * 1024 * 1024) {
      throw new Error(`导入包过大（${(pkgStat.size / 1024 / 1024 / 1024).toFixed(1)}GB，上限 1GB），请拆分后导入`)
    }
    // 解压写盘前检查批量任务互斥（不占锁——前面有两次系统对话框，占锁会长时间阻塞其它操作）
    if (ctx.packing.active) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const buf = await fs.readFile(selected)
    let files: number
    try {
      ;({ files } = await importModBuffer(buf, destRoot))
    } catch (err) {
      // 解压中途失败：清理半成品目录（不留残留），再抛给渲染层提示
      await fs.rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    registerRoot(ctx, destRoot)
    // 登记为「本次会话导入创建」：用户取消确认时可由 mod:discardImport 清理
    ctx.importedDirs.add(normalizePath(destRoot))
    return { rootPath: destRoot, name: path.basename(destRoot), files }
  })

  // 撤销导入：用户对「未保存编辑确认」点取消后，清理刚解压但未使用的目录（不留半导入残留）。
  // 只接受本会话 mod:import 刚创建的目录（importedDirs 登记），删除后从信任锚移除。
  ipc('mod:discardImport', async (_event, rootPath: string) => {
    const norm = normalizePath(rootPath)
    if (!ctx.importedDirs.has(norm)) return { ok: false } // 不是本次会话导入的：不动
    await fs.rm(rootPath, { recursive: true, force: true }).catch(() => undefined)
    ctx.roots.delete(norm)
    void ctx.store.set(PROJECT_ROOTS_KEY, [...ctx.roots])
    ctx.importedDirs.delete(norm)
    return { ok: true }
  })
}
