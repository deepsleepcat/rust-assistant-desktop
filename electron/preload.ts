/**
 * 预加载脚本：唯一允许在「主进程」与「界面进程」之间通信的桥。
 * 界面里只能拿到 window.rustAssistant 上这几个受控方法。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi } from '../src/types/bridge'

const api: BridgeApi = {
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke('app:info'),
  app: {
    checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
    downloadUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
    onUpdateEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as never)
      ipcRenderer.on('app:update', listener)
      return () => ipcRenderer.removeListener('app:update', listener)
    },
    onBeforeClose: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('app:before-close', listener)
      return () => ipcRenderer.removeListener('app:before-close', listener)
    },
    confirmClose: () => ipcRenderer.invoke('app:flush-done'),
  },
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
  },
  community: {
    request: (request) => ipcRenderer.invoke('community:request', request),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    startPairing: () => ipcRenderer.invoke('auth:startPairing'),
    pollPairing: () => ipcRenderer.invoke('auth:pollPairing'),
    cancelPairing: () => ipcRenderer.invoke('auth:cancelPairing'),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  project: {
    openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
    openImageDialog: () => ipcRenderer.invoke('dialog:openImage'),
    saveText: (title: string, defaultName: string, content: string) => ipcRenderer.invoke('dialog:saveText', title, defaultName, content),
    registerRoots: (roots: string[]) => ipcRenderer.invoke('project:registerRoots', roots),
    readDir: (rootPath: string, dirPath: string, showHidden?: boolean) => ipcRenderer.invoke('fs:readDir', rootPath, dirPath, showHidden),
    searchFiles: (rootPath: string, query: string, showHidden?: boolean) => ipcRenderer.invoke('project:searchFiles', rootPath, query, showHidden),
    stat: (rootPath: string, filePath: string) => ipcRenderer.invoke('fs:stat', rootPath, filePath),
    readFile: (rootPath: string, filePath: string) => ipcRenderer.invoke('fs:readFile', rootPath, filePath),
    writeFile: (rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }) =>
      ipcRenderer.invoke('fs:writeFile', rootPath, filePath, content, opts),
    createFile: (rootPath: string, dirPath: string, name: string) => ipcRenderer.invoke('fs:createFile', rootPath, dirPath, name),
    createFolder: (rootPath: string, dirPath: string, name: string) => ipcRenderer.invoke('fs:createFolder', rootPath, dirPath, name),
    rename: (rootPath: string, oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', rootPath, oldPath, newPath),
    delete: (rootPath: string, targetPath: string) => ipcRenderer.invoke('fs:delete', rootPath, targetPath),
    readImageAsDataUrl: (rootPath: string, imagePath: string) => ipcRenderer.invoke('image:readAsDataUrl', rootPath, imagePath),
    readAudioAsDataUrl: (rootPath: string, audioPath: string) => ipcRenderer.invoke('media:readAsDataUrl', rootPath, audioPath),
  },
  /** M18 知识包更新器（数据文件读取/更新检查/增量更新/回滚） */
  knowledge: {
    readDataFile: (name: string) => ipcRenderer.invoke('knowledge:readDataFile', name),
    info: () => ipcRenderer.invoke('knowledge:info'),
    checkUpdate: (sourceUrl: string) => ipcRenderer.invoke('knowledge:checkUpdate', sourceUrl),
    update: (sourceUrl: string) => ipcRenderer.invoke('knowledge:update', sourceUrl),
    rollback: () => ipcRenderer.invoke('knowledge:rollback'),
  },
  game: {
    detect: (configuredPath?: string) => ipcRenderer.invoke('game:detect', configuredPath),
    importSample: (gamePath: string, targetRoot: string, opts?: unknown) =>
      ipcRenderer.invoke('game:importSample', gamePath, targetRoot, opts),
    importMod: (gamePath: string, fileName: string, targetRoot: string) =>
      ipcRenderer.invoke('game:importMod', gamePath, fileName, targetRoot),
    launch: (gamePath: string) => ipcRenderer.invoke('game:launch', gamePath),
    openDir: (rootPath: string) => ipcRenderer.invoke('game:openDir', rootPath),
    preflight: (rootPath: string) => ipcRenderer.invoke('game:preflight', rootPath),
    readAssetImage: (gamePath: string, relPath: string) => ipcRenderer.invoke('game:readAssetImage', gamePath, relPath),
  },
  mod: {
    create: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:create', rootPath, params),
    chooseMusic: () => ipcRenderer.invoke('mod:chooseMusic'),
    import: (kind: 'archive' | 'folder') => ipcRenderer.invoke('mod:import', kind),
    discardImport: (rootPath: string) => ipcRenderer.invoke('mod:discardImport', rootPath),
    createUnit: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:createUnit', rootPath, params),
    pack: (rootPath: string, options?: unknown) => ipcRenderer.invoke('mod:pack', rootPath, options),
    packAndDeploy: (rootPath: string, options: unknown, gamePath: string, overwrite: boolean) =>
      ipcRenderer.invoke('mod:packAndDeploy', rootPath, options, gamePath, overwrite),
    check: (rootPath: string) => ipcRenderer.invoke('mod:check', rootPath),
    readModInfo: (rootPath: string) => ipcRenderer.invoke('mod:readModInfo', rootPath),
    writeModInfo: (rootPath: string, data: unknown) => ipcRenderer.invoke('mod:writeModInfo', rootPath, data),
    scanResources: (rootPath: string) => ipcRenderer.invoke('mod:scanResources', rootPath),
    scanUnits: (rootPath: string) => ipcRenderer.invoke('mod:scanUnits', rootPath),
    optimizeScan: (rootPath: string) => ipcRenderer.invoke('mod:optimizeScan', rootPath),
    optimizeApply: (rootPath: string, ids: string[]) => ipcRenderer.invoke('mod:optimizeApply', rootPath, ids),
    globalOp: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:globalOp', rootPath, params),
    listTemplates: () => ipcRenderer.invoke('mod:listTemplates'),
    saveFileAsTemplate: (rootPath: string, filePath: string, templateName: string, content?: string) => ipcRenderer.invoke('mod:saveFileAsTemplate', rootPath, filePath, templateName, content),
    importTemplate: () => ipcRenderer.invoke('template:import'),
    deleteUserTemplate: (key: string) => ipcRenderer.invoke('template:deleteUser', key),
    listUserTemplateKeys: () => ipcRenderer.invoke('template:listUserKeys'),
    createUnitFromTemplate: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:createUnitFromTemplate', rootPath, params),
    /** M34 单位复制：从其它/同模组复制单位配置（两侧项目根都须已登记） */
    copyUnit: (params: unknown) => ipcRenderer.invoke('mod:copyUnit', params),
    translationRepairScan: (rootPath: string) => ipcRenderer.invoke('mod:translationRepairScan', rootPath),
    translationRepairApply: (rootPath: string, selections: unknown) => ipcRenderer.invoke('mod:translationRepairApply', rootPath, selections),
  },
  git: {
    info: (rootPath: string) => ipcRenderer.invoke('git:info', rootPath),
    log: (rootPath: string, limit?: number) => ipcRenderer.invoke('git:log', rootPath, limit),
    status: (rootPath: string) => ipcRenderer.invoke('git:status', rootPath),
    conflicts: (rootPath: string) => ipcRenderer.invoke('git:conflicts', rootPath),
    diff: (rootPath: string, a: string, b: string, file?: string) => ipcRenderer.invoke('git:diff', rootPath, a, b, file),
    restore: (rootPath: string, file: string, commit?: string) => ipcRenderer.invoke('git:restore', rootPath, file, commit),
  },
  ai: {
    check: (settings) => ipcRenderer.invoke('ai:check', settings),
    deepSeekKey: {
      save: (key) => ipcRenderer.invoke('ai:credential:save', key),
      status: () => ipcRenderer.invoke('ai:credential:status'),
      clear: () => ipcRenderer.invoke('ai:credential:clear'),
    },
    info: () => ipcRenderer.invoke('ai:info'),
    stream: (params, settings, projectRoot) => ipcRenderer.invoke('ai:stream', params, settings, projectRoot),
    approve: (response: { id: string; approved: boolean }) => ipcRenderer.invoke('ai:approval:respond', response),
    streamAbort: () => ipcRenderer.invoke('ai:stream:abort'),
    historyList: (rootPath: string, relPath: string) => ipcRenderer.invoke('ai:history:list', rootPath, relPath),
    historyRestore: (rootPath: string, relPath: string, snapshotId: string) => ipcRenderer.invoke('ai:history:restore', rootPath, relPath, snapshotId),
    feedbackLint: (message: string) => ipcRenderer.invoke('ai:feedback', message),
    onAiEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as never)
      ipcRenderer.on('ai:stream', listener)
      return () => ipcRenderer.removeListener('ai:stream', listener)
    },
  },
}

contextBridge.exposeInMainWorld('rustAssistant', api)
