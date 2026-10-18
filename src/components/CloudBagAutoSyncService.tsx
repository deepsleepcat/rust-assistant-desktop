import { useEffect } from 'react'
import { pauseInvalidAutoSyncBindings, tickAutoSync, useCloudBagAutoSync } from '../services/cloudBagAutoSync'
import { getBridge } from '../services/bridge'
import { useWorkspaceStore } from '../stores/workspace'

export function CloudBagAutoSyncService() {
  useEffect(() => {
    const cloudbag = getBridge().cloudbag
    const watching = new Set<string>()
    let disposed = false
    let reconcileQueue = Promise.resolve()
    const reconcile = () => {
      reconcileQueue = reconcileQueue.then(async () => {
        const roots = new Set(disposed ? [] : Object.values(useCloudBagAutoSync.getState().bindings)
          .filter((binding) => binding.enabled && !binding.paused).map((binding) => binding.rootPath))
        for (const root of watching) {
          if (roots.has(root)) continue
          watching.delete(root)
          await cloudbag?.watch?.(root, false).catch(() => {})
        }
        for (const root of roots) {
          if (watching.has(root)) continue
          watching.add(root)
          // A missing native watcher still permits the periodic safety check.
          await cloudbag?.watch?.(root, true).catch(() => {})
        }
      })
    }
    const unsubscribeWorkspace = useWorkspaceStore.subscribe(() => { pauseInvalidAutoSyncBindings() })
    const unsubscribeBindings = useCloudBagAutoSync.subscribe((state, previous) => {
      reconcile()
      if (Object.values(state.bindings).some((binding) => binding.enabled && !binding.paused && (!previous.bindings[binding.key]?.enabled || previous.bindings[binding.key]?.paused))) void tickAutoSync()
    })
    const unsubscribeChanges = cloudbag?.onChanged?.(() => { void tickAutoSync() })
    const timer = window.setInterval(() => { void tickAutoSync() }, 15000)
    const online = () => { void tickAutoSync() }
    window.addEventListener('online', online)
    pauseInvalidAutoSyncBindings()
    reconcile()
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('online', online)
      unsubscribeWorkspace()
      unsubscribeBindings()
      unsubscribeChanges?.()
      reconcile()
    }
  }, [])
  return null
}
