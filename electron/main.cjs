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
const builtins = require('./builtin-profiles.cjs');
const copier = require('./copy.cjs');
const journal = require('./journal.cjs');

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

app.whenReady().then(() => {
  // Before the window, so the first profiles-boot already sees them.
  try { builtins.seed(app, profiles); } catch (e) { /* never block startup on this */ }
  createWindow();
});
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

// ── compare / scan ──────────────────────────────────────────────────────────
/*
 * One driver for both. A scan is the same walk with the NAS half and the
 * matching left out, so giving it a second fork/IPC/error path would mean two
 * places to keep the crash and exit-code handling correct.
 */
/*
 * Silence, not total elapsed time, is what marks a stall.
 *
 * The walk streams a progress message per root, so a healthy run is never quiet
 * for long even on a large Drive. A blocked readdir on a mount that has dropped
 * — Drive for Desktop reconnecting, a NAS share gone away — produces no message
 * and no exit, so the promise simply never settles and the window sits at
 * "Starting…" with every control disabled, forever. A total timeout cannot tell
 * that apart from a genuinely long scan; an idle timeout can.
 */
const WORKER_IDLE_MS = 5 * 60 * 1000;

function runWorker(cmd, payload, label) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'worker.mjs'), [], {
      // Electron's bundled Node needs this to run a forked script as plain Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let settled = false;
    let lastPhase = 'starting';
    let idle = null;
    const done = (m) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      resolve(m);
      try { child.kill(); } catch { /* already gone */ }
    };
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        done({
          type: 'error',
          message: `The ${label} stopped responding.\n\n` +
            `Nothing was heard from it for ${Math.round(WORKER_IDLE_MS / 60000)} minutes ` +
            `while it was ${lastPhase}.\n\n` +
            `This usually means a drive or share stopped answering — Google Drive for ` +
            `Desktop reconnecting, or the NAS dropping off. Check the folders are still ` +
            `reachable and run it again. Nothing was changed.`,
        });
      }, WORKER_IDLE_MS);
    };
    arm();

    child.on('message', (m) => {
      arm();   // any word from the worker means it is still alive
      if (m.type === 'progress') {
        lastPhase = m.text || m.phase || lastPhase;
        if (win) win.webContents.send('progress', m);
        return;
      }
      if (m.type === 'done') {
        lastRun = {
          result: m.result, overlap: m.overlap, nasIndex: m.nasIndex,
          driveRoot: (payload.driveRoots || [])[0] || '',
          driveFiles: m.driveFiles || [],
          scanned: !!m.scanned,
        };
      }
      done(m);
    });
    child.on('error', (e) => done({ type: 'error', message: e.message }));
    child.on('exit', (code) => done({
      type: 'error',
      message: `The ${label} stopped unexpectedly (exit code ${code}). Nothing was changed.`,
    }));
    child.send({ cmd, ...payload });
  });
}

ipcMain.handle('compare', async (_e, payload) => runWorker('compare', payload, 'comparison'));
ipcMain.handle('scan', async (_e, payload) => runWorker('scan', payload, 'scan'));

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

/**
 * What is available to export right now, so the picker offers only real options
 * instead of a single button that fails with a message nobody sees.
 */
ipcMain.handle('export-options', async () => ({
  hasRun: !!lastRun,
  scanned: !!(lastRun && lastRun.scanned),
  driveFiles: lastRun ? (lastRun.driveFiles || []).length : 0,
  newRows: lastRun ? (lastRun.result.new || []).length : 0,
  compared: !!(lastRun && !lastRun.scanned),
}));

/*
 * A drive manifest, from whichever walk last happened — scan or comparison.
 *
 * This is the file the app has always ASKED for and never been able to produce,
 * which is how someone ends up feeding it new.csv and getting "0 usable rows".
 * It is written through serialiseManifest, which sits beside loadManifest so the
 * columns cannot drift apart.
 */
ipcMain.handle('export-manifest', async () => {
  if (!lastRun || !(lastRun.driveFiles || []).length) {
    return { ok: false, error: 'Nothing has been scanned yet. Run Scan or Compare first.' };
  }
  const r = await dialog.showSaveDialog(win, {
    title: 'Save drive manifest',
    defaultPath: path.join(app.getPath('documents'), 'drive-manifest.csv'),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const { serialiseManifest } = await import('../src/manifest.mjs');
  const { csv, rows } = serialiseManifest(lastRun.driveFiles);
  fs.writeFileSync(r.filePath, csv, 'utf8');
  return { ok: true, file: r.filePath, rows };
});

/*
 * Did the files actually land?
 *
 * robocopy reports per-DIRECTORY exit codes, so a failed run told you "3 of 8
 * folders FAILED" and left you to read a log to find out which files. Statting
 * the intended destinations answers it directly, in the same terms the user
 * chose them in, and works the same for rsync — no locale-dependent log parsing.
 *
 * A size mismatch counts as not-landed: a truncated file is worse than a missing
 * one, because the next comparison sees a file at the destination and stops
 * calling it new.
 */
/*
 * Why a file did not land, when the source explains it.
 *
 * Google-native files are stubs with no retrievable bytes: Drive for Desktop
 * answers a read with ERROR_INVALID_FUNCTION ("Incorrect function"), robocopy
 * retries, gives up, and the file simply never appears. Six .gvid files failed
 * exactly this way, and the extension table did not know about Google Vids yet.
 *
 * Probing the source here catches the NEXT Google file type without anyone
 * having to guess extensions in advance — the table is the fast path, this is
 * the backstop.
 *
 * Bounded by size on purpose. Reading a file on a Stream-mode mount DOWNLOADS
 * it, so this only ever touches things small enough to be a stub; a 12 GB video
 * that failed for some other reason is never opened.
 */
const STUB_PROBE_MAX = 16 * 1024;

function diagnoseSource(row) {
  const src = row.driveAbs ||
    (row.driveRoot && row.drivePath
      ? path.join(row.driveRoot, String(row.drivePath).split('/').join(path.sep))
      : null);
  if (!src) return null;
  const size = Number(row.size);
  if (!Number.isFinite(size) || size > STUB_PROBE_MAX) return null;

  /*
   * Stat first, so a genuine directory is not mistaken for the stub signature.
   *
   * Windows reports a contentless Drive file as ERROR_INVALID_FUNCTION, and
   * libuv translates that to EISDIR — the same code a real directory produces.
   * Assuming EINVAL here (which is what "Incorrect function" reads like) was
   * wrong and the test caught it. A regular file that answers a read with
   * EISDIR is not a directory; it is Drive saying there are no bytes.
   */
  let st;
  try {
    st = fs.statSync(src);
  } catch (e) {
    return `the source is no longer there (${e.code || e.message})`;
  }
  if (st.isDirectory()) return 'the source is a folder, not a file';

  try {
    fs.readFileSync(src);
    return null;   // readable: the failure was something else
  } catch (e) {
    const code = e.code || '';
    if (code === 'EISDIR' || code === 'EINVAL' || /incorrect function/i.test(e.message || '')) {
      return 'the source has no file contents — it is a Google-native stub, ' +
             'so there is nothing to copy and retrying cannot help';
    }
    return `the source could not be read (${code || e.message})`;
  }
}

/*
 * PRE-FLIGHT — prove every file is readable BEFORE the copy engine runs.
 *
 * The failure this removes: robocopy discovers an unreadable source mid-run,
 * exits per-directory, and the user is left with "4 of 254 folder(s) FAILED"
 * and a log to read. Nothing is wrong with the copy; the plan was wrong, and
 * it was wrong before it started.
 *
 * ONE BYTE, and one byte is the whole trick. Measured on the real mount:
 *   openSync alone SUCCEEDS on a contentless Google stub (0.6ms) — opening
 *   proves nothing at all. Reading one byte throws EISDIR on the stub and
 *   succeeds on a real file. So the read is not optional.
 *
 * That read can hydrate a Stream-mode file, which sounds expensive until you
 * notice the copy is about to read the entire file anyway. The probe brings no
 * extra download forward for anything that goes on to copy; it only spends
 * effort on files that were going to fail. Measured cost: 0.6ms per stub,
 * ~5ms per real file.
 */
/*
 * ASYNC, deliberately, and it is not a style preference.
 *
 * This ran with statSync/openSync/readSync on the main process. That is the
 * process that owns the window, so a few hundred probes against a Google Drive
 * for Desktop mount — where a stat can go to the network — held its event loop
 * long enough for Windows to mark the window "Not Responding". The progress
 * events the loop was dutifully sending could not be delivered either, because
 * nothing could run between them.
 *
 * Awaiting the promise API yields between files. Same checks, same verdicts.
 */
async function probeReadable(abs) {
  let st;
  try {
    st = await fs.promises.stat(abs);
  } catch (e) {
    return { ok: false, kind: 'gone', reason: `the source is no longer there (${e.code || e.message})` };
  }
  if (st.isDirectory()) return { ok: false, kind: 'folder', reason: 'the source is a folder, not a file' };

  let fh;
  try {
    fh = await fs.promises.open(abs, 'r');
  } catch (e) {
    return { ok: false, kind: openKind(e), reason: openReason(e) };
  }
  try {
    if (st.size === 0) return { ok: true };   // legitimately empty; nothing to read
    // One byte. open() SUCCEEDS on a contentless Drive stub — only a read fails,
    // which is the whole reason this probe exists.
    await fh.read(Buffer.alloc(1), 0, 1, 0);
    return { ok: true };
  } catch (e) {
    const code = e.code || '';
    if (code === 'EISDIR' || code === 'EINVAL' || /incorrect function/i.test(e.message || '')) {
      return {
        ok: false, kind: 'stub',
        reason: 'a Google-native file with no contents — there is nothing to copy, ' +
                'and it must be exported from Google instead',
      };
    }
    return { ok: false, kind: openKind(e), reason: openReason(e) };
  } finally {
    try { await fh.close(); } catch { /* already gone */ }
  }
}

function openKind(e) {
  const c = e.code || '';
  if (c === 'EACCES' || c === 'EPERM') return 'permission';
  if (c === 'EBUSY') return 'locked';
  if (c === 'ENOENT') return 'gone';
  return 'unreadable';
}
function openReason(e) {
  const c = e.code || '';
  if (c === 'EACCES' || c === 'EPERM') return 'permission denied on the source';
  if (c === 'EBUSY') return 'the source is open in another program';
  if (c === 'ENOENT') return 'the source is no longer there';
  return `the source could not be read (${c || e.message})`;
}

ipcMain.handle('preflight-copy', async (_e, rows) => {
  const ready = [], blocked = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const src = row.driveAbs ||
      (row.driveRoot && row.drivePath
        ? path.join(row.driveRoot, String(row.drivePath).split('/').join(path.sep))
        : null);
    if (!src) { blocked.push({ ...row, kind: 'nosource', reason: 'source path unknown' }); continue; }
    const v = await probeReadable(src);
    if (v.ok) ready.push(row);
    else blocked.push({ ...row, kind: v.kind, reason: v.reason });
    // Every 25 now, and it actually arrives: the loop yields between files, so
    // the renderer gets a chance to paint each one.
    if (win && (i % 25 === 0 || i === list.length - 1)) {
      win.webContents.send('copy-event', {
        type: 'preflight', done: i + 1, total: list.length, blocked: blocked.length,
        name: row.name || '',
      });
    }
  }
  return { ready, blocked };
});

/*
 * The exact check, moved here from the comparison.
 *
 * A file whose destination already holds something of the SAME SIZE was being
 * called identical and dropped from the plan on that basis alone. Size is not
 * identity — a re-rendered export, a re-saved document, a truncated transfer
 * can all land on the same byte count — and this is the one decision in the
 * whole tool where being wrong means a file silently never arrives.
 *
 * It belongs here rather than in the comparison because only here is the set
 * small: comparison asks about the whole Drive and answers "not there" for
 * nearly all of it, which needs no hash. This asks only about files that are
 * already at their destination, and only when the manifest gave us something to
 * check them against.
 *
 * Reads the DESTINATION, never the Drive source. Drive for Desktop would
 * materialise every file to satisfy a read, turning a verification pass into a
 * full download.
 */
const { createHash } = require('node:crypto');

function md5OfFile(abs) {
  return new Promise((resolve) => {
    const h = createHash('md5');
    const s = fs.createReadStream(abs);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', () => resolve(null));   // unreadable — caller keeps the size verdict
  });
}

/*
 * Reads `verifyPath` when given, otherwise the copy destination. The two
 * callers ask the same question of different files: the copy review asks about
 * the file already sitting where a copy would land; the comparison asks about
 * the NAS file it matched a Drive file to. Both are decisions NOT to copy, and
 * both were being made on size alone.
 */
ipcMain.handle('verify-dest', async (_e, rows) => {
  const pathOf = (r) => r.verifyPath || r.proposedNas;
  const list = (rows || []).filter((r) => r && pathOf(r) && r.md5);
  const out = {};
  let bytes = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (win) {
      win.webContents.send('copy-event', {
        type: 'verify', done: i, total: list.length, name: r.name || '',
      });
    }
    const got = await md5OfFile(pathOf(r));
    bytes += Number(r.size) || 0;
    // null => could not read it; say so rather than guessing either way.
    out[pathOf(r)] = got === null ? 'unreadable' : (got === r.md5 ? 'same' : 'differs');
  }
  if (win) {
    win.webContents.send('copy-event', {
      type: 'verify', done: list.length, total: list.length, name: '',
    });
  }
  return { verdicts: out, checked: list.length, bytes };
});

ipcMain.handle('verify-copy', async (_e, rows) => {
  const missing = [], short = [], ok = [];
  for (const row of rows || []) {
    const dest = row && row.proposedNas;
    if (!dest) continue;
    try {
      const st = fs.statSync(dest);
      const want = Number(row.size);
      if (Number.isFinite(want) && want > 0 && st.size !== want) {
        short.push({ ...row, actual: st.size });
      } else ok.push(row);
    } catch (e) {
      missing.push({ ...row, why: e.code || e.message, diagnosis: diagnoseSource(row) });
    }
  }
  const unfixable = missing.filter((m) => m.diagnosis && /Google-native stub/.test(m.diagnosis));
  return { ok: ok.length, missing, short, unfixable: unfixable.length };
});

/** Write the not-landed list somewhere the user can act on it. */
ipcMain.handle('export-failures', async (_e, rows) => {
  if (!rows || !rows.length) return { ok: false, error: 'nothing to export' };
  const r = await dialog.showSaveDialog(win, {
    title: 'Save the list of files that did not copy',
    defaultPath: path.join(app.getPath('documents'), 'did-not-copy.csv'),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const cell = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = 'name,drivePath,proposedNas,bytes,actualBytes,reason';
  const body = rows.map((x) => [x.name, x.drivePath, x.proposedNas, x.size,
    x.actual === undefined ? '' : x.actual, x.why || 'size mismatch'].map(cell).join(','));
  fs.writeFileSync(r.filePath, [head, ...body].join('\n') + '\n', 'utf8');
  return { ok: true, file: r.filePath, rows: rows.length };
});

// ── profiles ────────────────────────────────────────────────────────────────
ipcMain.handle('profiles-list', async () => profiles.list(app));
ipcMain.handle('profiles-save', async (_e, p) => profiles.save(app, p));
ipcMain.handle('profiles-load', async (_e, file) => profiles.load(app, file));
ipcMain.handle('profiles-delete', async (_e, file) => { profiles.remove(app, file); return true; });
ipcMain.handle('profiles-set-default', async (_e, file) => { profiles.setDefault(app, file); return true; });
ipcMain.handle('profiles-settings', async () => profiles.getSettings(app));
ipcMain.handle('splash-seen', async (_e, version) => {
  const fsx = require('node:fs');
  const f = path.join(app.getPath('userData'), 'settings.json');
  let s = {};
  try { s = JSON.parse(fsx.readFileSync(f, 'utf8')); } catch { /* first run */ }
  s.splashSeenVersion = version;
  fsx.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
  return true;
});

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
    const r = await copier.run(opts, send);
    // Record every run, including failures and dry runs -- a journal that only
    // logs successes is no use when you are trying to work out what happened.
    journal.append(app, r, opts.rows || []);
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('journal-read', async (_e, limit) => journal.read(app, limit || 50));
ipcMain.handle('journal-reversal', async (_e, entry) => ({
  files: journal.reversalList(entry),
  note: 'These are the files that run added. Nothing is deleted here — this is a list for you to act on.',
}));

ipcMain.handle('copy-cancel', async () => { copier.cancel(); return true; });
ipcMain.handle('copy-engine', async () => ({ engine: copier.engine(), isWindows: copier.IS_WIN }));

ipcMain.handle('app-info', async () => ({
  version: app.getVersion(),
  engine: copier.engine(),
  isWindows: copier.IS_WIN,
  electron: process.versions.electron,
}));

/**
 * What is already sitting at each destination. Needed because a destination the
 * user just picked may be outside the NAS roots that were scanned, so the
 * comparison index cannot answer for it.
 */
/*
 * Async for the same reason as probeReadable: this stats one path per planned
 * file, over SMB, on the process that owns the window. Synchronously that is
 * hundreds of blocking network round-trips before the copy dialog can draw
 * anything.
 */
ipcMain.handle('inspect-dest', async (_e, paths) => {
  const list = paths || [];
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    try {
      const st = await fs.promises.stat(p);
      out[String(p).toLowerCase().split('\\').join('/')] = { size: st.size, mtimeMs: st.mtimeMs };
    } catch { /* not there: that is the answer */ }
    if (win && (i % 50 === 0 || i === list.length - 1)) {
      win.webContents.send('copy-event', {
        type: 'inspect', done: i + 1, total: list.length,
      });
    }
  }
  return out;
});
