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
    readFile: (rootPath: string, filePath: string) => ipcRenderer.invoke('fs:readFile', rootPath, filePath),
    writeFile: (rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }) =>
      ipcRenderer.invoke('fs:writeFile', rootPath, filePath, content, opts),
    createFile: (rootPath: string, dirPath: string, name: string) => ipcRenderer.invoke('fs:createFile', rootPath, dirPath, name),
    createFolder: (rootPath: string, dirPath: string, name: string) => ipcRenderer.invoke('fs:createFolder', rootPath, dirPath, name),
    rename: (rootPath: string, oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', rootPath, oldPath, newPath),
    delete: (rootPath: string, targetPath: string) => ipcRenderer.invoke('fs:delete', rootPath, targetPath),
    readImageAsDataUrl: (rootPath: string, imagePath: string) => ipcRenderer.invoke('image:readAsDataUrl', rootPath, imagePath),
  },
  avatar: {
    chooseLocal: () => ipcRenderer.invoke('avatar:chooseLocal'),
    uploadCommunity: () => ipcRenderer.invoke('avatar:uploadCommunity'),
  },
  mod: {
    create: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:create', rootPath, params),
    createUnit: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:createUnit', rootPath, params),
    pack: (rootPath: string) => ipcRenderer.invoke('mod:pack', rootPath),
    check: (rootPath: string) => ipcRenderer.invoke('mod:check', rootPath),
    listTemplates: () => ipcRenderer.invoke('mod:listTemplates'),
    createUnitFromTemplate: (rootPath: string, params: unknown) => ipcRenderer.invoke('mod:createUnitFromTemplate', rootPath, params),
  },
  ai: {
    check: (settings) => ipcRenderer.invoke('ai:check', settings),
    info: () => ipcRenderer.invoke('ai:info'),
    stream: (params, settings, projectRoot) => ipcRenderer.invoke('ai:stream', params, settings, projectRoot),
    approve: (response: { id: string; approved: boolean }) => ipcRenderer.invoke('ai:approval:respond', response),
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
