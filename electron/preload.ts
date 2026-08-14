/**
 * 预加载脚本：唯一允许在「主进程」与「界面进程」之间通信的桥。
 * 界面里只能拿到 window.rustAssistant 上这几个受控方法。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi } from '../src/types/bridge'

const api: BridgeApi = {
  platform: process.platform,
  version: '',
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
  project: {
    openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
    openImageDialog: () => ipcRenderer.invoke('dialog:openImage'),
    registerRoots: (roots: string[]) => ipcRenderer.invoke('project:registerRoots', roots),
    readDir: (rootPath: string, dirPath: string) => ipcRenderer.invoke('fs:readDir', rootPath, dirPath),
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
  avatar: {
    chooseLocal: () => ipcRenderer.invoke('avatar:chooseLocal'),
    /** 保存裁剪后的头像（PNG data URL）→ 返回已登记的文件路径 */
    saveCropped: (dataUrl: string) => ipcRenderer.invoke('avatar:saveCropped', dataUrl),
    uploadCommunity: () => ipcRenderer.invoke('avatar:uploadCommunity'),
  },
  mod: {
    create: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:create', rootPath, params),
    chooseMusic: () => ipcRenderer.invoke('mod:chooseMusic'),
    import: () => ipcRenderer.invoke('mod:import'),
    discardImport: (rootPath: string) => ipcRenderer.invoke('mod:discardImport', rootPath),
    createUnit: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:createUnit', rootPath, params),
    pack: (rootPath: string, options?: unknown) => ipcRenderer.invoke('mod:pack', rootPath, options),
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
    createUnitFromTemplate: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:createUnitFromTemplate', rootPath, params),
  },
  ai: {
    check: (settings) => ipcRenderer.invoke('ai:check', settings),
    info: () => ipcRenderer.invoke('ai:info'),
    stream: (params, settings, projectRoot) => ipcRenderer.invoke('ai:stream', params, settings, projectRoot),
    approve: (response: { id: string; approved: boolean }) => ipcRenderer.invoke('ai:approval:respond', response),
    streamAbort: () => ipcRenderer.invoke('ai:stream:abort'),
    onAiEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as never)
      ipcRenderer.on('ai:stream', listener)
      return () => ipcRenderer.removeListener('ai:stream', listener)
    },
  },
}

void ipcRenderer.invoke('app:info').then((info: { version: string }) => {
  api.version = info.version
})

contextBridge.exposeInMainWorld('rustAssistant', api)
