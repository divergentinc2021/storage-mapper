/**
 * The only bridge between the renderer and Node. Every channel is explicit —
 * the renderer gets no fs, no shell, no require.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapper', {
  pickFolder: (title, multi) => ipcRenderer.invoke('pick-folder', { title, multi }),
  pickManifest: () => ipcRenderer.invoke('pick-manifest'),
  compare: (payload) => ipcRenderer.invoke('compare', payload),
  searchNas: (query, size) => ipcRenderer.invoke('search-nas', { query, size }),
  loadMapping: () => ipcRenderer.invoke('load-mapping'),
  saveMapping: (m) => ipcRenderer.invoke('save-mapping', m),
  mappingPath: () => ipcRenderer.invoke('mapping-path'),
  exportReports: () => ipcRenderer.invoke('export-reports'),
  revealInFolder: (p) => ipcRenderer.invoke('open-path', p),
  onProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('progress', h);
    return () => ipcRenderer.removeListener('progress', h);
  },
});
