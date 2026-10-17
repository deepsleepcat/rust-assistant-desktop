import { create } from 'zustand'
import { createCloudBagApi } from './cloudBagApi'
import { getBridge } from './bridge'
import { useWorkspaceStore } from '../stores/workspace'
import { readCloudBagAnchor, pushLocalTree, pullRemoteVersion, writeCloudBagAnchor, type SyncProgress } from './cloudBagSync'
import { scanLocalTree, resolveBaselineTree } from './cloudBagTreeState'
import { acquireCloudBagOperation } from './cloudBagOperation'

interface Binding {
  key: string; endpoint: string; userId: number; rootPath: string; projectId: string; repoSlug: string
  enabled: boolean; paused: boolean; message: string; progress?: SyncProgress
}
export const useCloudBagAutoSync = create<{ bindings: Record<string, Binding> }>(() => ({ bindings: {} }))
const pending = new Map<string, { digest: string; base: number; id: string }>()
const running = new Set<string>()
export function isFileInSyncRoot(filePath: string, rootPath: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(filePath).startsWith(`${normalize(rootPath)}/`)
}
export function pauseInvalidAutoSyncBindings(): void {
  const state = useWorkspaceStore.getState()
  for (const binding of Object.values(useCloudBagAutoSync.getState().bindings)) {
    if (!binding.enabled || binding.paused) continue
    if (state.communityAuth.status !== 'signed_in' || state.communityAuth.user?.id !== binding.userId || state.settings.ai.communityEndpoint !== binding.endpoint || !state.projects.some((project) => project.id === binding.projectId && project.rootPath === binding.rootPath)) {
      update(binding.key, { paused: true, progress: undefined, message: '账号、服务器或本地项目已变化，请重新开启' })
    }
  }
}
export function autoSyncKey(endpoint: string, userId: number, root: string, slug: string): string { return JSON.stringify([endpoint, userId, root, slug]) }
function update(key: string, patch: Partial<Binding>) { useCloudBagAutoSync.setState((state) => ({ bindings: { ...state.bindings, [key]: { ...state.bindings[key], ...patch } } })) }
export function configureAutoSync(binding: Omit<Binding, 'key' | 'enabled' | 'paused' | 'message'>, action: 'enable' | 'pause' | 'disable') {
  const key = autoSyncKey(binding.endpoint, binding.userId, binding.rootPath, binding.repoSlug)
  update(key, { ...binding, key, enabled: action !== 'disable', paused: action === 'pause', message: action === 'enable' ? '等待检查' : action === 'pause' ? '已暂停' : '已关闭' })
}

export async function tickAutoSync(): Promise<void> {
  for (const binding of Object.values(useCloudBagAutoSync.getState().bindings)) {
    if (!binding.enabled || binding.paused || running.has(binding.key)) continue
    const current = () => {
      const state = useWorkspaceStore.getState()
      const live = useCloudBagAutoSync.getState().bindings[binding.key]
      return Boolean(live?.enabled && !live.paused && state.communityAuth.status === 'signed_in' && state.communityAuth.user?.id === binding.userId && state.settings.ai.communityEndpoint === binding.endpoint && state.projects.some((project) => project.id === binding.projectId && project.rootPath === binding.rootPath))
    }
    if (!current()) { update(binding.key, { paused: true, message: '账号、服务器或本地项目已变化，请重新开启' }); continue }
    const dirty = () => useWorkspaceStore.getState().openTabs.some((tab) => isFileInSyncRoot(tab.path, binding.rootPath) && (tab.dirty || tab.pendingRepair))
    const operationLease = acquireCloudBagOperation(binding.rootPath)
    if (!operationLease) { update(binding.key, { message: '等待当前目录的同步操作完成' }); continue }
    running.add(binding.key)
    try {
      const bridge = getBridge()
      const api = createCloudBagApi(binding.endpoint)
      const anchor = await readCloudBagAnchor(bridge, binding.rootPath)
      if (!anchor || anchor.repoSlug !== binding.repoSlug || !anchor.baselineTreeDigest) throw new Error('同步绑定或基线不完整，请先完成一次手动同步')
      if (!current()) continue
      if (dirty()) { update(binding.key, { message: '等待保存编辑器中的修改' }); continue }
      const repo = await api.repo(binding.repoSlug)
      if (repo.myRole !== 'owner' && repo.myRole !== 'editor') throw new Error('仓库编辑权限已失效')
      const rawSnapshot = await bridge.cloudbag?.snapshot?.(binding.rootPath)
      if (!rawSnapshot) throw new Error('当前客户端缺少安全快照能力，请重启应用')
      const onProgress = (progress: SyncProgress) => update(binding.key, { progress, message: '正在同步' })
      const scan = await scanLocalTree(bridge, binding.rootPath, { onProgress, isCancelled: () => !current() })
      if (!scan || !current()) continue
      if (scan.skippedBinary.length || scan.oversized.length) throw new Error('有文件读取失败或超过限制，请手动检查')
      const baseline = await resolveBaselineTree({ anchor, api, bridge, rootPath: binding.rootPath, repoSlug: binding.repoSlug, localEntries: scan.entries, isCancelled: () => !current() })
      if (!baseline) throw new Error('无法确认同步基线')
      const localChanged = scan.digest !== baseline.digest
      const remoteChanged = repo.headVersionNo !== anchor.baselineSeq
      if (localChanged && remoteChanged) throw new Error('本地与远端都有修改，请打开同步窗口处理冲突')
      if (!localChanged && !remoteChanged) { update(binding.key, { message: '已同步', progress: undefined }); continue }
      if (dirty() || !current()) continue
      const host = { api, bridge, rootPath: binding.rootPath, repoSlug: binding.repoSlug, onProgress, operationLease, isAborted: () => !current() || dirty() }
      if (localChanged) {
        let operation = pending.get(binding.key)
        if (operation && (operation.digest !== scan.digest || operation.base !== anchor.baselineSeq)) throw new Error('上次提交结果尚未确认且本地已变化，请手动检查远端版本')
        if (!operation) { operation = { digest: scan.digest, base: anchor.baselineSeq, id: crypto.randomUUID() }; pending.set(binding.key, operation) }
        const result = await pushLocalTree(host, { message: '自动同步本地修改', baseVersionNo: anchor.baselineSeq, clientOpId: operation.id, strict: true, expectedDigest: scan.digest })
        if (result.status !== 'pushed' || !result.versionNo || !result.treeDigest) throw new Error(result.status === 'conflict' ? '远端已更新，请手动处理冲突' : result.error ?? '自动同步已停止')
        if (!current()) throw new Error('同步已完成，但账号或绑定已变化，未更新本地基线，请手动核对')
        await writeCloudBagAnchor(bridge, binding.rootPath, { repoSlug: binding.repoSlug, baselineSeq: result.versionNo, baselineTreeDigest: result.treeDigest, lastSyncedAt: Math.floor(Date.now() / 1000) })
        pending.delete(binding.key)
      } else {
        if (pending.has(binding.key)) throw new Error('上次提交结果尚未确认，请手动核对远端版本')
        const result = await pullRemoteVersion(host, { versionNo: repo.headVersionNo, expectedSnapshot: rawSnapshot })
        if (result.status !== 'pulled' || !result.treeDigest) throw new Error(result.error ?? '拉取未完成，请手动检查')
        if (!current()) throw new Error('同步已完成，但账号或绑定已变化，未更新本地基线，请手动核对')
        await writeCloudBagAnchor(bridge, binding.rootPath, { repoSlug: binding.repoSlug, baselineSeq: repo.headVersionNo, baselineTreeDigest: result.treeDigest, lastSyncedAt: Math.floor(Date.now() / 1000) })
        await useWorkspaceStore.getState().checkExternalChanges()
      }
      update(binding.key, { message: '已同步', progress: undefined })
    } catch (err) { update(binding.key, { paused: true, progress: undefined, message: err instanceof Error ? err.message : String(err) }) }
    finally { operationLease(); running.delete(binding.key) }
  }
}
