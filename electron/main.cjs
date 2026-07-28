/**
 * Electron main process.
 *
 * Holds no matching logic — it owns windows, native dialogs and IPC, and forks
 * worker.mjs to run the tested core. Nothing here can copy, move or delete: the
 * only filesystem writes are the mapping file and the exported reports.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const profiles = require('./profiles.cjs');
const copier = require('./copy.cjs');

const ROOT = path.join(__dirname, '..');
let win = null;
let lastRun = null; // { result, overlap, nasIndex } — reused when remapping

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 940, minHeight: 620,
    title: 'Storage Mapper',
    backgroundColor: '#f9f9f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

// ── dialogs ─────────────────────────────────────────────────────────────────
ipcMain.handle('pick-folder', async (_e, { title, multi }) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    properties: ['openDirectory', ...(multi ? ['multiSelections'] : [])],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-manifest', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the Drive manifest CSV (exported from Storage Explorer)',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-path', async (_e, p) => {
  // Reveal, never open — this app must not launch arbitrary files.
  shell.showItemInFolder(p);
});

// ── mapping persistence ─────────────────────────────────────────────────────
const mappingPath = () => path.join(app.getPath('userData'), 'mapping.json');

ipcMain.handle('load-mapping', async () => {
  try { return JSON.parse(fs.readFileSync(mappingPath(), 'utf8')); }
  catch { return { nasRoots: [], driveRoots: [], aliases: [], map: [] }; }
});

ipcMain.handle('save-mapping', async (_e, m) => {
  fs.writeFileSync(mappingPath(), JSON.stringify(m, null, 2) + '\n');
  return mappingPath();
});

ipcMain.handle('mapping-path', async () => mappingPath());

// ── compare ─────────────────────────────────────────────────────────────────
ipcMain.handle('compare', async (_e, payload) => new Promise((resolve) => {
  const child = fork(path.join(__dirname, 'worker.mjs'), [], {
    // Electron's bundled Node needs this to run a forked script as plain Node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let settled = false;
  child.on('message', (m) => {
    if (m.type === 'progress') { if (win) win.webContents.send('progress', m); return; }
    settled = true;
    if (m.type === 'done') {
      lastRun = { result: m.result, overlap: m.overlap, nasIndex: m.nasIndex,
                  driveRoot: (payload.driveRoots || [])[0] || '' };
    }
    resolve(m);
    child.kill();
  });
  child.on('error', (e) => { if (!settled) resolve({ type: 'error', message: e.message }); });
  child.on('exit', (code) => {
    if (!settled) resolve({ type: 'error', message: `comparison exited with code ${code}` });
  });
  child.send({ cmd: 'compare', ...payload });
}));

/** Search the NAS index from the last run — used by "find the match myself". */
ipcMain.handle('search-nas', async (_e, { query, size }) => {
  if (!lastRun) return [];
  const q = String(query || '').toLowerCase().trim();
  const rows = lastRun.nasIndex.filter((f) => {
    const nameHit = q ? f.base.toLowerCase().includes(q) : false;
    const sizeHit = size ? f.size === size : false;
    return nameHit || sizeHit;
  });
  // Exact size matches are the strongest candidates, so surface them first.
  rows.sort((a, b) => (b.size === size ? 1 : 0) - (a.size === size ? 1 : 0));
  return rows.slice(0, 200);
});

// ── report export ───────────────────────────────────────────────────────────
ipcMain.handle('export-reports', async () => {
  if (!lastRun) return { ok: false, error: 'nothing to export yet' };
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the reports',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled) return { ok: false, canceled: true };
  const outDir = r.filePaths[0];
  const { writeAll, writeCopyPlan } = await import('../src/report.mjs');
  const summary = writeAll(outDir, lastRun.result, lastRun.overlap);
  writeCopyPlan(outDir, lastRun.result, lastRun.driveRoot || '');
  return { ok: true, outDir, summary };
});

// ── profiles ────────────────────────────────────────────────────────────────
ipcMain.handle('profiles-list', async () => profiles.list(app));
ipcMain.handle('profiles-save', async (_e, p) => profiles.save(app, p));
ipcMain.handle('profiles-load', async (_e, file) => profiles.load(app, file));
ipcMain.handle('profiles-delete', async (_e, file) => { profiles.remove(app, file); return true; });
ipcMain.handle('profiles-set-default', async (_e, file) => { profiles.setDefault(app, file); return true; });
ipcMain.handle('profiles-settings', async () => profiles.getSettings(app));

/** Default profile plus any pending shared-profile update, read at launch. */
ipcMain.handle('profiles-boot', async () => {
  const s = profiles.getSettings(app);
  let profile = null;
  if (s.defaultProfile && fs.existsSync(s.defaultProfile)) {
    profile = profiles.load(app, s.defaultProfile);
  }
  return { profile, defaultFile: s.defaultProfile || null, shared: profiles.checkShared(app) };
});

ipcMain.handle('profiles-export', async (_e, { profile, includeLocal }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export profile',
    defaultPath: `${(profile.name || 'profile').replace(/[^A-Za-z0-9 _.-]/g, '_')}.smprofile.json`,
    filters: [{ name: 'Storage Mapper profile', extensions: ['json'] }],
  });
  if (r.canceled) return { ok: false, canceled: true };
  profiles.exportProfile(profile, r.filePath, !!includeLocal);
  return { ok: true, file: r.filePath };
});

ipcMain.handle('profiles-import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import a profile',
    filters: [{ name: 'Storage Mapper profile', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return { ok: false, canceled: true };
  return { ok: true, file: r.filePaths[0], profile: profiles.load(app, r.filePaths[0]) };
});

/** Point at a profile on a share; the app watches it for team updates. */
ipcMain.handle('profiles-set-shared', async (_e, pick) => {
  if (pick === null) { profiles.setSharedPath(app, null); return { ok: true, path: null }; }
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the shared profile (e.g. on the NAS)',
    filters: [{ name: 'Storage Mapper profile', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return { ok: false, canceled: true };
  profiles.setSharedPath(app, r.filePaths[0]);
  return { ok: true, path: r.filePaths[0], shared: profiles.checkShared(app) };
});

ipcMain.handle('profiles-shared-applied', async (_e, { hash, shared }) => {
  profiles.markSharedApplied(app, hash, shared);
  return true;
});

// ── copy ────────────────────────────────────────────────────────────────────
/*
  The only place this app writes to the NAS. It adds files and nothing else:
  the engine never emits /MIR, /PURGE or /MOV, and rsync runs without --delete.
  Only rows the renderer sends are acted on, and each is re-checked for an
  absolute destination inside the runner.
*/
ipcMain.handle('copy-run', async (_e, opts) => {
  if (copier.isBusy()) return { ok: false, error: 'a copy is already running' };
  const send = (evt) => { if (win) win.webContents.send('copy-event', evt); };
  try {
    return await copier.run(opts, send);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('copy-cancel', async () => { copier.cancel(); return true; });
ipcMain.handle('copy-engine', async () => ({ engine: copier.engine(), isWindows: copier.IS_WIN }));
