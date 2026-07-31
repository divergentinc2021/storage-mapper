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
  profilesBoot: () => ipcRenderer.invoke('profiles-boot'),
  profilesList: () => ipcRenderer.invoke('profiles-list'),
  profilesSave: (p) => ipcRenderer.invoke('profiles-save', p),
  profilesLoad: (f) => ipcRenderer.invoke('profiles-load', f),
  profilesDelete: (f) => ipcRenderer.invoke('profiles-delete', f),
  profilesSetDefault: (f) => ipcRenderer.invoke('profiles-set-default', f),
  profilesExport: (profile, includeLocal) => ipcRenderer.invoke('profiles-export', { profile, includeLocal }),
  profilesImport: () => ipcRenderer.invoke('profiles-import'),
  profilesSetShared: (pick) => ipcRenderer.invoke('profiles-set-shared', pick),
  profilesSharedApplied: (hash, shared) => ipcRenderer.invoke('profiles-shared-applied', { hash, shared }),
  profilesSettings: () => ipcRenderer.invoke('profiles-settings'),
  splashSeen: (v) => ipcRenderer.invoke('splash-seen', v),
  journalRead: (n) => ipcRenderer.invoke('journal-read', n),
  journalReversal: (e) => ipcRenderer.invoke('journal-reversal', e),
  inspectDest: (paths) => ipcRenderer.invoke('inspect-dest', paths),
  scan: (payload) => ipcRenderer.invoke('scan', payload),
  exportOptions: () => ipcRenderer.invoke('export-options'),
  exportManifest: () => ipcRenderer.invoke('export-manifest'),
  verifyCopy: (rows) => ipcRenderer.invoke('verify-copy', rows),
  verifyDest: (rows) => ipcRenderer.invoke('verify-dest', rows),
  preflightCopy: (rows) => ipcRenderer.invoke('preflight-copy', rows),
  exportFailures: (rows) => ipcRenderer.invoke('export-failures', rows),
  appInfo: () => ipcRenderer.invoke('app-info'),
  copyRun: (opts) => ipcRenderer.invoke('copy-run', opts),
  copyCancel: () => ipcRenderer.invoke('copy-cancel'),
  copyEngine: () => ipcRenderer.invoke('copy-engine'),
  onCopyEvent: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('copy-event', h);
    return () => ipcRenderer.removeListener('copy-event', h);
  },
  onProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('progress', h);
    return () => ipcRenderer.removeListener('progress', h);
  },
});
