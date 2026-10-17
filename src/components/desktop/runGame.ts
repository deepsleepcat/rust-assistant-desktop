import { getBridge } from '../../services/bridge'
import { useWorkspaceStore } from '../../stores/workspace'

let gameActionInFlight = false

/**
 * Navigation action for launching the game.
 *
 * It deliberately uses the existing bridge validation and preflight path instead
 * of duplicating filesystem checks in the renderer. A failed preflight remains
 * visible through the normal confirm surface so the user can choose whether to
 * continue or open the game settings.
 */
export async function runGameAction(): Promise<void> {
  if (gameActionInFlight) return
  gameActionInFlight = true
  const store = useWorkspaceStore.getState()
  const bridge = getBridge()
  store.notify('正在检查游戏安装…')

  try {
    const detected = await bridge.game.detect(store.settings.gamePath || undefined)
    if (!detected.found || !detected.gamePath) {
      store.notify('未找到铁锈战争安装目录，请先在设置 → 游戏中配置')
      store.openSettings('game')
      return
    }

    const project = store.projects.find((item) => item.id === store.activeProjectId) ?? null
    if (project) {
      const preflight = await bridge.game.preflight(project.rootPath)
      const errors = preflight.issues.filter((item) => item.severity === 'error').length
      const warnings = preflight.issues.filter((item) => item.severity === 'warning').length
      store.updateSettings({
        gameLastCheck: {
          at: Date.now(),
          ok: preflight.ok,
          message: preflight.issues.length === 0 ? '检查通过' : `${errors} 个错误，${warnings} 个警告`,
        },
      })

      if (!preflight.ok) {
        store.requestConfirm({
          title: '运行前检查未通过',
          message: `当前模组有 ${errors} 个错误${warnings > 0 ? `、${warnings} 个警告` : ''}。仍要启动游戏吗？`,
          confirmText: '仍要启动',
          cancelText: '打开游戏设置',
          onConfirm: () => {
            void launchDetectedGame(detected.gamePath!)
          },
          onCancel: () => store.openSettings('game'),
        })
        return
      }
    }

    await launchDetectedGame(detected.gamePath)
  } catch (error) {
    store.notify(`启动游戏失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    gameActionInFlight = false
  }
}

async function launchDetectedGame(gamePath: string): Promise<void> {
  const store = useWorkspaceStore.getState()
  store.notify('正在启动游戏…')
  try {
    const result = await getBridge().game.launch(gamePath)
    if (!result.ok) {
      store.notify(`启动游戏失败：${result.message ?? '未知原因'}`)
      return
    }
    store.notify('游戏已启动')
  } catch (error) {
    store.notify(`启动游戏失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
