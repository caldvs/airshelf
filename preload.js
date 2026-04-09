const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('airshelf', {
  listBooks: () => ipcRenderer.invoke('books:list'),
  addBooks: () => ipcRenderer.invoke('books:add'),
  addBookPaths: (paths) => ipcRenderer.invoke('books:addPaths', paths),
  deleteBook: (id) => ipcRenderer.invoke('books:delete', id),
  serverInfo: () => ipcRenderer.invoke('server:info'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // Electron >= 32 removed File.path; use webUtils.getPathForFile
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onBooksChanged: (cb) => {
    ipcRenderer.on('books:changed', () => cb());
  },
  showContextMenu: (id) => ipcRenderer.invoke('books:showContextMenu', id),
});
