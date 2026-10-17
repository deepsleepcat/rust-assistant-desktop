/**
 * 应用根组件：组装桌面壳、五个工作面、主题、快捷键与全局弹层。
 */
import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from './stores/workspace'
import { getBridge, isElectron } from './services/bridge'
import { Backdrop } from './components/Backdrop'
import { CloudBagAutoSyncService } from './components/CloudBagAutoSyncService'
import { TitleBar } from './components/TitleBar'
import { StatusBar } from './components/StatusBar'
import { ApprovalDialog, ConfirmDialog } from './components/Modal'
import { installEscapeDispatcher } from './utils/modalStack'
import { useAppShortcuts } from './utils/useAppShortcuts'
import { WorkbenchLayout } from './components/WorkbenchLayout'
import { DesktopShell } from './components/desktop/DesktopShell'
import { SurfaceAuthGate } from './components/desktop/SurfaceAuthGate'
import { DashboardSurface, CloudBagSurface } from './components/desktop/surfaceModules'
import { SurfaceDeck } from './components/desktop/SurfaceDeck'
import { useDesktopPreferences } from './components/desktop/desktopPreferences'
import { LeftColumn } from './features/workspace/LeftColumn'
import { EditorArea } from './features/editor/EditorArea'
import { CommunityPanel } from './features/community/CommunityPanel'
import { SettingsPage } from './features/settings/SettingsPage'
import { CommandPalette } from './features/workspace/CommandPalette'
import { ModToolModals } from './features/modTools/ModToolModals'
import { CodeTableModal } from './features/editor/CodeTableModal'
import { VersionDiffModal } from './features/editor/VersionDiffModal'
import { RelationGraphModal } from './features/graph/RelationGraphModal'
import { TemplateLibraryModal } from './features/modTools/TemplateLibraryModal'
import { GitInfoModal } from './features/project/GitInfoModal'
import { UnitLibraryModal } from './features/editor/UnitLibraryModal'
import { ValueTypeModal } from './features/settings/ValueTypeModal'
import { CursorEffect } from './components/CursorEffect'
import { LogoR } from './components/LogoR'

interface StartupScreenProps {
  initError: string | null
  onRetry: () => void
}

function StartupScreen({ initError, onRetry }: StartupScreenProps) {
  return (
    <main className="startup-screen" aria-labelledby="startup-title">
      <section className="startup-panel">
        <div className="startup-brand">
          <LogoR size="about" />
          <span>铁锈工坊</span>
        </div>
        <div className={`startup-state${initError ? ' startup-error' : ''}`} role={initError ? 'alert' : 'status'} aria-live={initError ? undefined : 'polite'}>
          <h1 id="startup-title">{initError ? '启动失败' : '正在启动…'}</h1>
          {initError ? (
            <>
              <p>{initError}</p>
              <button className="btn primary" onClick={onRetry}>重试</button>
            </>
          ) : (
            <span className="startup-spinner" aria-hidden="true" />
          )}
        </div>
      </section>
    </main>
  )
}

export function App() {
  const ready = useWorkspaceStore((s) => s.ready)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const settings = useWorkspaceStore((s) => s.settings)
  const codeTableOpen = useWorkspaceStore((s) => s.codeTableOpen)
  const versionDiffOpen = useWorkspaceStore((s) => s.versionDiffOpen)
  const relationGraphOpen = useWorkspaceStore((s) => s.relationGraphOpen)
  const templateLibraryOpen = useWorkspaceStore((s) => s.templateLibraryOpen)
  const gitInfoOpen = useWorkspaceStore((s) => s.gitInfoOpen)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const unitLibraryOpen = useWorkspaceStore((s) => s.unitLibraryOpen)
  const valueTypeOpen = useWorkspaceStore((s) => s.valueTypeOpen)
  const toast = useWorkspaceStore((s) => s.toast)
  const dismissToast = useWorkspaceStore((s) => s.dismissToast)
  // 工作面切换不丢编辑器标签/光标/项目状态；编辑器节点始终挂载。
  const activeSurface = useWorkspaceStore((s) => s.activeSurface)
  const desktopPreferences = useDesktopPreferences()

  // 初始化：读取本地设置与工作区（失败时展示错误面板与重试入口；initPromise 已重置可重试）
  const [initError, setInitError] = useState<string | null>(null)
  const handleInitError = useCallback((err: unknown) => {
    console.error('[app] 初始化失败:', err)
    setInitError(err instanceof Error ? err.message : String(err))
  }, [])
  const runInit = useCallback(() => {
    setInitError(null)
    void useWorkspaceStore.getState().init().catch(handleInitError)
  }, [handleInitError])
  useEffect(() => {
    // 首次启动：initError 初始为 null，直接调用（无同步 setState）
    void useWorkspaceStore.getState().init().catch(handleInitError)
  }, [handleInitError])

  // 主题：浅色 / 深色 / 跟随系统（system 模式监听系统偏好变化实时切换）
  useEffect(() => {
    const applyTheme = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      // 缓存到 localStorage：下次启动首帧前（main.tsx 顶部）同步应用，避免白屏闪烁
      try {
        localStorage.setItem('ra-theme', settings.theme)
      } catch {
        /* 存储不可用（隐私模式等）：忽略，仅影响启动首帧 */
      }
    }
    applyTheme()
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', applyTheme)
      return () => mq.removeEventListener('change', applyTheme)
    }
  }, [settings.theme])

  useEffect(() => {
    document.body.classList.toggle('electron', isElectron)
    // 弹窗 Escape 栈：多弹窗叠放时只关最上层（capture 阶段拦截）
    installEscapeDispatcher()
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const device = navigator as Navigator & { deviceMemory?: number }
    const applyPerformanceHints = () => {
      document.body.classList.toggle('ra-reduced-motion', media.matches || desktopPreferences.reduceMotion)
      document.body.classList.toggle('ra-low-performance', desktopPreferences.lowPerformance || (navigator.hardwareConcurrency || 8) <= 4 || (device.deviceMemory ?? 8) <= 2)
    }
    applyPerformanceHints()
    media.addEventListener('change', applyPerformanceHints)
    return () => media.removeEventListener('change', applyPerformanceHints)
  }, [desktopPreferences.lowPerformance, desktopPreferences.reduceMotion])

  useAppShortcuts()

  // 外部文件修改轮询：只标记，不自动覆盖用户内容
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(() => void useWorkspaceStore.getState().checkExternalChanges(), 3000)
    return () => clearInterval(timer)
  }, [ready])

  // LOW-3b：窗口关闭前同步落盘（渲染层 300ms 防抖的最后写入不丢失），
  // 完成后向主进程确认，主进程再销毁窗口
  useEffect(() => {
    return getBridge().app.onBeforeClose(() => {
      void useWorkspaceStore
        .getState()
        .flushPersist()
        .catch((err) => {
          // 落盘失败要可感知（如 store 超限被主进程拒绝）：提示用户，避免静默丢对话/项目记录。
          // 退出瞬间 toast 不可见——同时写 console.error 留痕
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[flushPersist] 数据落盘失败', err)
          useWorkspaceStore.getState().notify(`数据保存失败，部分内容可能未写入：${msg}`)
        })
        .finally(() => {
          void getBridge().app.confirmClose()
        })
    })
  }, [])

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismissToast, 2600)
    return () => clearTimeout(t)
  }, [toast, dismissToast])

  if (!ready) {
    return <StartupScreen initError={initError} onRetry={runInit} />
  }

  const signedIn = communityAuth.status === 'signed_in'

  return (
    <div className={`app${settings.background.kind !== 'none' ? ' has-backdrop' : ''}`} data-surface={activeSurface}>
      <Backdrop />
      <CloudBagAutoSyncService />
      {settings.cursorEffect && <CursorEffect intensity={settings.cursorEffectIntensity} color={settings.cursorEffectColor} />}

      <DesktopShell>
        <TitleBar />
        <main className="app-body" id="main-content">
          <SurfaceDeck pages={{
            editor: <WorkbenchLayout left={<LeftColumn />} editor={<EditorArea />} />,
            dashboard: signedIn
              ? <DashboardSurface key={`${settings.ai.communityEndpoint}:${communityAuth.user?.id ?? ''}`} />
              : <SurfaceAuthGate surfaceLabel="仪表盘" description="登录后才能读取真实余额、准确 Token 用量和调用日志。" />,
            community: signedIn
              ? <CommunityPanel key={`${settings.ai.communityEndpoint}:${communityAuth.user?.id ?? ''}`} />
              : <SurfaceAuthGate surfaceLabel="社区" description="登录后才能浏览实时帖子、互动与社区账户内容。" />,
            cloudBag: signedIn
              ? <CloudBagSurface key={`${settings.ai.communityEndpoint}:${communityAuth.user?.id ?? ''}`} />
              : <SurfaceAuthGate surfaceLabel="云仓库" description="登录后才能访问云仓库版本、文件树与下载授权。" />,
            settings: <SettingsPage />,
          }} />
        </main>
        <StatusBar />
      </DesktopShell>

      <CommandPalette />
      <ModToolModals />
      {codeTableOpen && <CodeTableModal onClose={() => useWorkspaceStore.getState().setCodeTableOpen(false)} />}
      {versionDiffOpen && <VersionDiffModal onClose={() => useWorkspaceStore.getState().setVersionDiffOpen(false)} />}
      {relationGraphOpen && (
        <RelationGraphModal
          // key 跟随项目：切换项目时整体重挂载，避免旧项目的关系图/错误横幅残留
          key={activeProjectId ?? 'none'}
          onClose={() => useWorkspaceStore.getState().setRelationGraphOpen(false)}
        />
      )}
      {templateLibraryOpen && <TemplateLibraryModal onClose={() => useWorkspaceStore.getState().setTemplateLibraryOpen(false)} />}
      {gitInfoOpen && activeProjectId && (
        <GitInfoModal
          // key 跟随项目：切换项目时重挂载；无活动项目时走下方提示分支（互斥）
          key={activeProjectId}
          rootPath={useWorkspaceStore.getState().projects.find((p) => p.id === activeProjectId)?.rootPath ?? ''}
          onClose={() => useWorkspaceStore.getState().setGitInfoOpen(false)}
        />
      )}
      {gitInfoOpen && !activeProjectId && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && useWorkspaceStore.getState().setGitInfoOpen(false)}>
          <div className="modal-card vdiff-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Git 历史与回滚（本地）</div>
            <div className="modal-body">
              <p className="codetable-empty">请先打开一个模组项目，再查看 Git 历史。</p>
            </div>
            <div className="modal-footer">
              <button className="btn primary" onClick={() => useWorkspaceStore.getState().setGitInfoOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {unitLibraryOpen && <UnitLibraryModal onClose={() => useWorkspaceStore.getState().setUnitLibraryOpen(false)} />}
      {valueTypeOpen && (
        <ValueTypeModal
          onClose={() => useWorkspaceStore.getState().setValueTypeOpen(false)}
          onNotify={(m) => useWorkspaceStore.getState().notify(m)}
        />
      )}
      <ConfirmDialog />
      <ApprovalDialog />

      {toast && <div className="toast">{toast}</div>}

      {!isElectron && (
        <div
          style={{
            position: 'fixed',
            bottom: 34,
            right: 14,
            zIndex: 500,
            fontSize: 11,
            color: 'var(--text-3)',
            pointerEvents: 'none',
          }}
        >
          浏览器预览模式（未连接桌面端）
        </div>
      )}
    </div>
  )
}
