const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('airshelf', {
  listBooks: () => ipcRenderer.invoke('books:list'),
  addBooks: () => ipcRenderer.invoke('books:add'),
  pickBookPaths: () => ipcRenderer.invoke('books:pick'),
  addBookPaths: (paths) => ipcRenderer.invoke('books:addPaths', paths),
  deleteBook: (id) => ipcRenderer.invoke('books:delete', id),
  serverInfo: () => ipcRenderer.invoke('server:info'),
  onServerTokenRotated: (cb) => {
    ipcRenderer.on('server:tokenRotated', (_e, info) => cb(info));
  },
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // Electron >= 32 removed File.path; use webUtils.getPathForFile
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onBooksChanged: (cb) => {
    ipcRenderer.on('books:changed', () => cb());
  },
  showContextMenu: (id) => ipcRenderer.invoke('books:showContextMenu', id),
  setCoverFromUrl: (id, url) => ipcRenderer.invoke('cover:setFromUrl', id, url),
  onCoverPromptUrl: (cb) => {
    ipcRenderer.on('cover:prompt-url', (_e, id) => cb(id));
  },
  calibreStatus: () => ipcRenderer.invoke('calibre:status'),
  calibreLocate: () => ipcRenderer.invoke('calibre:locate'),
  calibreClear: () => ipcRenderer.invoke('calibre:clear'),
  backupLibrary: () => ipcRenderer.invoke('library:backup'),
  restoreLibrary: () => ipcRenderer.invoke('library:restore'),
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('updater:available', (_e, info) => cb(info));
  },
  onUpdateDownloaded: (cb) => {
    ipcRenderer.on('updater:downloaded', (_e, info) => cb(info));
  },
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  pairCurrent: () => ipcRenderer.invoke('pair:current'),
  pairRotate: () => ipcRenderer.invoke('pair:rotate'),
  importFromCalibre: () => ipcRenderer.invoke('library:importCalibre'),
  onImportProgress: (cb) => {
    ipcRenderer.on('library:importProgress', (_e, payload) => cb(payload));
  },
});
