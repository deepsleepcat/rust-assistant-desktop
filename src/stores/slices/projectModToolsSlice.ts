/**
 * 项目切片 → 模组工具与自动更新域（M39 巨型函数治理拆分）：
 * 新建模组/自述文件/模板/单位、打包（含部署+运行前检查）、模组检查、质量报告、
 * 优化、全局操作、翻译修复，以及应用自动更新动作。
 */
import { invalidateResourceCache } from '../../features/editor/completion'
import { getBridge } from '../../services/bridge'
import { generateModReport as generateModReportFn } from '../../features/modTools/modReport'
import { contentForDisk, type ProjectSliceContext } from './projectShared'

export function createModToolActions(ctx: ProjectSliceContext) {
  const { set, get, deps } = ctx
  return {
    // ── M5 模组工具 ─────────────────────────────────────────────
    async createModProject(params: { title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }) {
      const project = ctx.activeProject()
      if (!project) return
      try {
        const { files, musicFailed } = await deps.bridge.mod.create(project.rootPath, params)
        await get().refreshTree()
        const failedTip = musicFailed && musicFailed.length > 0 ? `；${musicFailed.length} 首音乐转换失败：${musicFailed.join('、')}` : ''
        get().notify(`模组已创建：${files.join('、')}${failedTip}`)
      } catch (err) {
        get().notify(`创建模组失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async saveModInfo(data: { title: string; description?: string; author?: string; version?: string; thumbnail?: string; minVersion?: string; musicFiles: string[]; musicExclusive: boolean; mapsFiles: string[]; mapsExtra: boolean; musicSourceFolder?: string; mapsSourceFolder?: string; updateUrl?: string }) {
      const project = ctx.activeProject()
      if (!project) return
      try {
        await deps.bridge.mod.writeModInfo(project.rootPath, data)
        await get().refreshTree()
        get().notify('模组自述文件已保存')
      } catch (err) {
        get().notify(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async saveActiveFileAsTemplate(name: string) {
      const project = ctx.activeProject()
      const tab = get().openTabs.find((t) => t.id === get().activeTabId)
      if (!project || !tab) return
      try {
        // 保存模板 = 保存当前编辑内容（中文显示层需先回译成英文，与 saveTab 一致；追踪表精确还原）
        const content = contentForDisk(tab.content, tab)
        const { key } = await deps.bridge.mod.saveFileAsTemplate(project.rootPath, tab.path, name, content)
        get().notify(`已保存为模板：${name}（${key}），可在「新建单位」中选择`)
      } catch (err) {
        get().notify(`保存模板失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async createUnitFile(params: { name: string; templateKey: string; values: Record<string, string> }) {
      const project = ctx.activeProject()
      if (!project) return
      try {
        const { path: rel } = await deps.bridge.mod.createUnitFromTemplate(project.rootPath, params)
        await get().refreshTree()
        get().notify(`已创建单位：${rel}`)
      } catch (err) {
        get().notify(`创建单位失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async packModProject() {
      // M32：打开打包选项弹窗前提示未保存文件——打包读的是磁盘内容，
      // 未保存的编辑不会进产物（不阻塞打包，用户可先保存）
      const dirtyTabs = get().openTabs.filter((t) => t.dirty)
      if (dirtyTabs.length > 0) {
        const names = dirtyTabs.slice(0, 3).map((t) => t.name).join('、')
        get().notify(`⚠ ${dirtyTabs.length} 个文件有未保存修改（${names}${dirtyTabs.length > 3 ? '…' : ''}），打包可能不含最新内容`)
      }
      // 打开打包选项弹窗（由 ModToolModals 渲染），确认后调用 packModWithOptions
      set({ modDialog: 'pack' })
    },

    async packModWithOptions(
      options: { removeEmptyFiles?: boolean; removeEmptyFolders?: boolean; removeEmptyLines?: boolean; removeComments?: boolean; formatCode?: boolean },
      deployToGame = false,
    ) {
      const project = ctx.activeProject()
      if (!project) return
      const gamePath = get().settings.gamePath
      if (deployToGame && !gamePath) {
        get().notify('未配置游戏安装目录，请在 设置 → 游戏 中配置后再试')
        return
      }
      set({ modDialog: null })
      get().notify(deployToGame ? '正在打包并部署到游戏…' : '正在打包模组…')
      try {
        if (deployToGame) {
          // M35 F3：一键验证——打包 → 部署到游戏 mods/units → 自动启动游戏
          let result = await deps.bridge.mod.packAndDeploy(project.rootPath, options, gamePath, false)
          if (!result.ok && result.code === 'EXISTS') {
            const fileName = result.filePath?.split(/[\\/]/).pop() ?? ''
            if (window.confirm(`游戏模组目录已存在同名模组「${fileName}」，覆盖它？`)) {
              result = await deps.bridge.mod.packAndDeploy(project.rootPath, options, gamePath, true)
            } else {
              get().notify('已取消部署（同名模组未覆盖）')
              return
            }
          }
          if (!result.ok) {
            get().notify(`部署失败：${result.message}`)
            return
          }
          const mb = (result.size / 1024 / 1024).toFixed(2)
          const skippedTip = result.skippedLinks ? `；已跳过 ${result.skippedLinks} 个指向项目外的链接` : ''
          get().notify(
            `已部署到游戏：${result.files} 个文件，${mb} MB${skippedTip}（${result.filePath}）`,
          )
          // 自动启动游戏（不阻塞部署结果提示）
          void getBridge()
            .game.launch(gamePath)
            .then((r) => {
              if (!r.ok) get().notify(`启动游戏失败：${r.message}`)
            })
            .catch(() => undefined)
        } else {
          const result = await deps.bridge.mod.pack(project.rootPath, options)
          if ('canceled' in result && result.canceled) {
            get().notify('已取消打包')
            return
          }
          const mb = (result.size / 1024 / 1024).toFixed(2)
          // LOW-1：指向项目外的链接被跳过时给出提示（不再中止整次打包）
          const skippedTip = result.skippedLinks ? `；已跳过 ${result.skippedLinks} 个指向项目外的链接` : ''
          get().notify(`打包完成：${result.files} 个文件，${mb} MB → ${result.filePath}${skippedTip}`)
        }
        // M12：打包后自动运行前检查（两种模式共用；不阻塞；结果持久化到设置「试玩联动」，
        // 失败时追加提示引导去查看/修复——「打包 → 检查 → 进游戏」闭环）
        void getBridge()
          .game.preflight(project.rootPath)
          .then((r) => {
            if (!r) return
            // 打包后项目可能已被关闭/切换：仅当仍是当前项目时才追加失败通知
            // （检查结果本身仍写入设置，供设置页「上次检查」查看）
            const stillActive = get().activeProjectId === project.id
            const errors = r.issues.filter((i) => i.severity === 'error').length
            const warnings = r.issues.filter((i) => i.severity === 'warning').length
            // 经 updateSettings（sanitize + 持久化）
            get().updateSettings({
              gameLastCheck: {
                at: Date.now(),
                ok: r.ok,
                message: r.issues.length === 0 ? '检查通过' : `${errors} 个错误，${warnings} 个警告`,
              },
            })
            if (!r.ok && stillActive) {
              get().notify(`运行前检查发现 ${errors} 个错误（设置 → 试玩联动 查看详情）`)
            }
          })
          .catch(() => undefined)
      } catch (err) {
        get().notify(`打包失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async checkModProject() {
      const project = ctx.activeProject()
      if (!project) return
      try {
        const result = await deps.bridge.mod.check(project.rootPath)
        set({ modCheckResult: result, modDialog: 'check' })
      } catch (err) {
        get().notify(`检查失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    // M13：生成模组质量报告（全量语义检查汇总；脱敏——仅相对路径）
    async generateModReport() {
      const project = ctx.activeProject()
      if (!project || get().modReportBusy) return
      const pid = project.id
      set({ modReportBusy: true, modReportOpen: true, modReportError: null, modReportProgress: null })
      try {
        const report = await generateModReportFn(
          project.rootPath,
          {
            projectName: project.name,
            semanticCheckers: get().settings.semanticCheckers,
            targetVersionName: get().settings.targetGameVersion,
            onProgress: (done, total) => {
              // 生成期间用户可能已切换项目：进度只写给当前项目
              if (get().activeProjectId === pid) set({ modReportProgress: { done, total } })
            },
          },
        )
        // 竞态守卫：生成期间切换项目 → 丢弃旧项目报告（对齐 scanOptimizeProject 模式）
        if (get().activeProjectId !== pid) return
        set({ modReport: report })
      } catch (err) {
        // 保留弹窗内联展示错误（不突然关闭，用户可重试或关闭）
        if (get().activeProjectId === pid) set({ modReportError: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ modReportBusy: false })
      }
    },

    setModReportOpen(open: boolean) {
      set({ modReportOpen: open, modReport: open ? get().modReport : null, modReportError: open ? null : get().modReportError, modReportProgress: open ? get().modReportProgress : null })
    },

    // M13：导出质量报告（文本/JSON；保存位置由系统对话框决定）
    async exportModReport(kind: 'text' | 'json') {
      const report = get().modReport
      if (!report) return
      const { reportToJson, reportToText } = await import('../../features/modTools/modReport')
      const content = kind === 'json' ? reportToJson(report) : reportToText(report)
      // 项目名可能含 Windows 非法文件名字符：清洗后作为建议文件名
      const safeName = report.meta.projectName.replace(/[\\/:*?"<>|]/g, '-').replace(/[\s.]+$/g, '')
      const defaultName = `mod-report-${safeName || 'mod'}-${new Date().toISOString().slice(0, 10)}.${kind === 'json' ? 'json' : 'txt'}`
      try {
        const result = await deps.bridge.project.saveText('导出模组质量报告', defaultName, content)
        if (result.ok) get().notify(`报告已导出：${result.path}`)
        else if (!result.canceled) get().notify(`导出失败：${result.message ?? '未知原因'}`)
      } catch (err) {
        get().notify(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async scanOptimizeProject() {
      const project = ctx.activeProject()
      if (!project) {
        // LOW-1：无项目时直接显示错误（否则弹窗永远停在「正在扫描」且无重试效果）
        set({ optimizeError: '请先打开一个模组项目，再使用优化工具' })
        return
      }
      const pid = project.id
      // 先清失败状态：重试期间显示「扫描中…」而不是残留错误
      set({ optimizeError: null })
      try {
        const items = await deps.bridge.mod.optimizeScan(project.rootPath)
        // LOW-3a：扫描期间切换了项目——丢弃过期结果，避免旧项目列表覆盖新项目
        if (get().activeProjectId !== pid) return
        // 扫描期间用户可能已手动关闭弹窗（ESC/遮罩）——只更新结果，不强制重开
        set((s) => ({ optimizeItems: items, optimizeError: null, modDialog: s.modDialog }))
      } catch (err) {
        if (get().activeProjectId !== pid) return
        // 失败时保留弹窗并显示错误与重试入口（不再卡在「正在扫描」；不触碰 modDialog，
        // 用户已关闭弹窗则保持关闭）
        set({ optimizeError: err instanceof Error ? err.message : String(err) })
      }
    },

    async applyOptimizeProject(ids: string[]) {
      const project = ctx.activeProject()
      if (!project) return
      try {
        const { done, failed } = await deps.bridge.mod.optimizeApply(project.rootPath, ids)
        get().notify(failed > 0 ? `优化完成：${done} 项成功，${failed} 项失败` : `优化完成：共处理 ${done} 项`)
        // L2：只关「优化」弹窗——执行期间用户可能经命令面板打开了别的弹窗，不能误关
        set((s) => ({
          optimizeItems: null,
          optimizeError: null,
          modDialog: s.modDialog === 'optimize' ? null : s.modDialog,
        }))
        await get().refreshTree()
      } catch (err) {
        get().notify(`优化失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    /** 全局操作：对整个模组源文件批量替换/头部附加/尾部附加（返回结果供弹窗展示） */
    async globalOpProject(params: { kind: 'replace' | 'prepend' | 'append'; find?: string; text?: string }) {
      const project = ctx.activeProject()
      if (!project) return null
      try {
        const result = await deps.bridge.mod.globalOp(project.rootPath, params)
        // 内容变化：失效补全资源缓存（@file 引用内容可能已变）
        invalidateResourceCache()
        return result
      } catch (err) {
        // 返回 null：弹窗显示错误状态（不显示误导的「0 个文件」成功文案）
        get().notify(`全局操作失败：${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },

    // M38：翻译损坏修复（扫描 → 预览 → 确认写回）
    async scanTranslationRepairProject() {
      const project = ctx.activeProject()
      if (!project) {
        set({ translationRepairError: '请先打开一个模组项目，再使用修复工具' })
        return
      }
      const pid = project.id
      set({ translationRepairError: null })
      try {
        const result = await deps.bridge.mod.translationRepairScan(project.rootPath)
        if (get().activeProjectId !== pid) return
        set((s) => ({ translationRepairItems: result.files, translationRepairError: null, modDialog: s.modDialog }))
      } catch (err) {
        if (get().activeProjectId !== pid) return
        set({ translationRepairError: err instanceof Error ? err.message : String(err) })
      }
    },

    async applyTranslationRepairProject(selections: Array<{ path: string; digest: string }>) {
      const project = ctx.activeProject()
      if (!project) return
      try {
        const result = await deps.bridge.mod.translationRepairApply(project.rootPath, selections)
        get().notify(
          result.failed > 0
            ? `修复完成：${result.done} 个文件成功，${result.skipped} 个跳过，${result.failed} 个失败`
            : `修复完成：${result.done} 个文件已恢复，${result.skipped} 个跳过`,
        )
        set((s) => ({
          translationRepairItems: null,
          translationRepairError: null,
          modDialog: s.modDialog === 'translationRepair' ? null : s.modDialog,
        }))
        if (result.changedPaths.length > 0) {
          invalidateResourceCache()
          await get().refreshTree()
          get().notify('部分文件已被修复，已打开的受影响标签请重新加载')
        }
      } catch (err) {
        get().notify(`修复失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    // ── M6 自动更新 ─────────────────────────────────────────────
    async checkUpdate() {
      set({ updateState: { status: 'checking' } })
      try {
        const result = await deps.bridge.app.checkUpdate()
        if (result.skipped) {
          set({ updateState: { status: 'not_available', message: result.message ?? '开发模式不检查更新' } })
        }
        // 未 skipped：结果由 onUpdateEvent 事件推送更新
      } catch (err) {
        set({ updateState: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
      }
    },

    async downloadUpdate() {
      try {
        await deps.bridge.app.downloadUpdate()
        set({ updateState: { status: 'downloading', percent: 0 } })
      } catch (err) {
        set({ updateState: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
      }
    },

    installUpdate() {
      void deps.bridge.app.installUpdate()
    },
  }
}
