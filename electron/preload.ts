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
    readImageAsDataUrl: (imagePath: string) => ipcRenderer.invoke('image:readAsDataUrl', imagePath),
  },
}

void ipcRenderer.invoke('app:info').then((info: { version: string }) => {
  api.version = info.version
})

contextBridge.exposeInMainWorld('rustAssistant', api)
