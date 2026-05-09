import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('airshelf', {
  listBooks: () => ipcRenderer.invoke('books:list'),
  addBooks: () => ipcRenderer.invoke('books:add'),
  pickBookPaths: () => ipcRenderer.invoke('books:pick'),
  addBookPaths: (paths: string[]) => ipcRenderer.invoke('books:addPaths', paths),
  deleteBook: (id: string) => ipcRenderer.invoke('books:delete', id),
  serverInfo: () => ipcRenderer.invoke('server:info'),
  onServerTokenRotated: (cb: (info: unknown) => void) => {
    ipcRenderer.on('server:tokenRotated', (_e, info) => cb(info));
  },
  openExternal: (url: string) => ipcRenderer.invoke('open:external', url),
  // Electron >= 32 removed File.path; use webUtils.getPathForFile
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  onBooksChanged: (cb: () => void) => {
    ipcRenderer.on('books:changed', () => cb());
  },
  showContextMenu: (id: string) => ipcRenderer.invoke('books:showContextMenu', id),
  setCoverFromUrl: (id: string, url: string) => ipcRenderer.invoke('cover:setFromUrl', id, url),
  onCoverPromptUrl: (cb: (id: string) => void) => {
    ipcRenderer.on('cover:prompt-url', (_e, id) => cb(id));
  },
  calibreStatus: () => ipcRenderer.invoke('calibre:status'),
  calibreLocate: () => ipcRenderer.invoke('calibre:locate'),
  calibreClear: () => ipcRenderer.invoke('calibre:clear'),
  backupLibrary: () => ipcRenderer.invoke('library:backup'),
  restoreLibrary: () => ipcRenderer.invoke('library:restore'),
  onUpdateAvailable: (cb: (info: unknown) => void) => {
    ipcRenderer.on('updater:available', (_e, info) => cb(info));
  },
  onUpdateDownloaded: (cb: (info: unknown) => void) => {
    ipcRenderer.on('updater:downloaded', (_e, info) => cb(info));
  },
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  pairCurrent: () => ipcRenderer.invoke('pair:current'),
  pairRotate: () => ipcRenderer.invoke('pair:rotate'),
  importFromCalibre: () => ipcRenderer.invoke('library:importCalibre'),
  importFromGoodreads: () => ipcRenderer.invoke('library:importGoodreads'),
  onImportProgress: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('library:importProgress', (_e, payload) => cb(payload));
  },
});
