/**
 * Headless check of the renderer's copy-button logic.
 *
 * There is no browser available in this environment, and "the element exists in
 * the HTML" is not the same claim as "the button enables when it should". This
 * loads the REAL electron/ui/app.js against a minimal DOM stub and drives the
 * states that matter — the ones behind the report that the copy feature looked
 * missing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'electron', 'ui', 'app.js'), 'utf8');

// ── the smallest DOM that app.js will accept ────────────────────────────────
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', disabled: false,
    hidden: false, style: {}, dataset: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, insertAdjacentHTML() {}, showModal() {}, close() {},
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {}, removeAttribute() {}, setAttribute() {},
  };
}
const els = new Map();
const doc = {
  readyState: 'complete',
  getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: { getAttribute: () => null, setAttribute() {} },
  createElement: (t) => makeEl(t),
};

const noop = () => Promise.resolve(null);
const win = {
  mapper: {
    appInfo: () => Promise.resolve({ version: '9.9.9', engine: 'rsync', isWindows: false, electron: 'x' }),
    profilesBoot: () => Promise.resolve({ profile: null, defaultFile: null, shared: null }),
    profilesList: () => Promise.resolve([]),
    profilesSettings: () => Promise.resolve({}),
    loadMapping: () => Promise.resolve({ aliases: [], map: [] }),
    onProgress: () => () => {}, onCopyEvent: () => () => {},
    copyEngine: () => Promise.resolve({ engine: 'rsync', isWindows: false }),
    pickFolder: noop, pickManifest: noop, compare: noop, searchNas: () => Promise.resolve([]),
    profilesSave: noop, profilesLoad: noop, profilesDelete: noop, profilesSetDefault: noop,
    profilesExport: noop, profilesImport: noop, profilesSetShared: noop, profilesSharedApplied: noop,
    saveMapping: noop, exportReports: noop, revealInFolder: noop, copyRun: noop, copyCancel: noop,
  },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  prompt: () => null, confirm: () => false,
};

const sandbox = { document: doc, window: win, console, setTimeout, Set, JSON, Math, Date };
const fn = new Function(...Object.keys(sandbox), `${src}\n; return { get RESULT(){return RESULT}, set RESULT(v){RESULT=v},
  syncStageButtons, copyReadyRows, isAbsoluteDest, classifyAgainstDest,
  get MAPPED(){return MAPPED}, set MAPPED(v){MAPPED=v} };`);
const api = fn(...Object.values(sandbox));

let failures = 0;
const check = (name, f) => {
  try { f(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\nrenderer: staged Compare -> Map -> Copy\n');

const copyBtn = doc.getElementById('btnCopyTop');
const mapBtn = doc.getElementById('btnMapTop');

/*
  The staged flow is the contract: Compare lights Map, Map lights Copy. You must
  not be able to copy something you have not said where to put.
*/
check('before any comparison both Map and Copy are disabled', () => {
  api.RESULT = null; api.MAPPED = null;
  api.syncStageButtons();
  assert.equal(mapBtn.disabled, true);
  assert.equal(copyBtn.disabled, true);
  assert.match(mapBtn.title, /Run a comparison first/);
});

check('after a comparison Map lights up but Copy stays LOCKED', () => {
  // The destinations here are deliberately ALREADY ABSOLUTE. An earlier version
  // of this test used empty ones, so Copy was disabled for the wrong reason and
  // the test passed even when the Map gate was removed entirely. The gate is
  // "MAPPED is null", not "there is nothing copyable".
  api.RESULT = { new: [
    { drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: 'Z:/Amanzi/a/x.mp4' },
    { drivePath: 'a/y.mp4', name: 'y.mp4', size: 20, driveRoot: 'H:/d', proposedNas: 'Z:/Amanzi/a/y.mp4' },
  ] };
  api.MAPPED = null;
  api.syncStageButtons();
  assert.equal(mapBtn.disabled, false, 'Map should be available once there are new files');
  assert.match(mapBtn.textContent, /Map 2 new/);
  assert.equal(copyBtn.disabled, true, 'Copy must stay locked until a destination is mapped');
  assert.match(copyBtn.title, /Map a destination first/);
});

check('once mapped, Copy lights up with the count', () => {
  api.MAPPED = [
    { drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: 'Z:/Amanzi/a/x.mp4' },
    { drivePath: 'a/y.mp4', name: 'y.mp4', size: 20, driveRoot: 'H:/d', proposedNas: 'Z:/Amanzi/a/y.mp4' },
  ];
  api.syncStageButtons();
  assert.equal(copyBtn.disabled, false, 'Copy should unlock after mapping');
  assert.match(copyBtn.textContent, /Copy 2/);
});

check('a relative mapped destination does NOT unlock Copy', () => {
  api.MAPPED = [{ drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: 'Amanzi/a/x.mp4' }];
  api.syncStageButtons();
  assert.equal(copyBtn.disabled, true, 'a relative destination must never be copyable');
});

check('nothing new means Map is disabled and says why', () => {
  api.RESULT = { new: [] }; api.MAPPED = null;
  api.syncStageButtons();
  assert.equal(mapBtn.disabled, true);
  assert.match(mapBtn.title, /already on the NAS/);
});

check('classifying against the destination skips identical files', () => {
  const rows = [
    { drivePath: 'a.jpg', name: 'a.jpg', size: 100, proposedNas: 'Z:/n/a.jpg' },
    { drivePath: 'b.jpg', name: 'b.jpg', size: 200, proposedNas: 'Z:/n/b.jpg' },
    { drivePath: 'c.jpg', name: 'c.jpg', size: 300, proposedNas: 'Z:/n/c.jpg' },
  ];
  const out = api.classifyAgainstDest(rows, { 'z:/n/a.jpg': { size: 100 }, 'z:/n/b.jpg': { size: 9 } });
  assert.deepEqual(out.map((r) => r.state), ['identical', 'different', 'new']);
  assert.deepEqual(out.map((r) => r.selected), [false, false, true],
    'only genuinely new files are selected by default');
});

check('UNC destinations count as absolute', () => {
  assert.equal(api.isAbsoluteDest('\\\\UIZ-NAS\\Projects\\x'), true);
  assert.equal(api.isAbsoluteDest('Z:\\Projects\\x'), true);
  assert.equal(api.isAbsoluteDest('Projects\\x'), false);
});


// ── the renderer and the HTML must agree ────────────────────────────────────
check('every element the renderer binds exists in the HTML or is created by it', () => {
  /*
    Catches the dead-handler class of bug: a button removed from index.html while
    its addEventListener stays, so init() throws on a null and every later
    binding in that function silently never happens. An id is legitimate if the
    HTML declares it OR app.js builds it (the copy-review buttons are rendered
    into innerHTML and bound immediately after).
  */
  const html = readFileSync(path.join(ROOT, 'electron', 'ui', 'index.html'), 'utf8');
  const bound = new Set();
  for (const m of src.matchAll(/\$\('([A-Za-z0-9_]+)'\)\s*\.addEventListener/g)) bound.add(m[1]);
  assert.ok(bound.size > 20, 'expected the renderer to bind many ids');
  const missing = [...bound].filter((id) =>
    !html.includes(`id="${id}"`) && !src.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `bound but never created: ${missing.join(', ')}`);
});

check('no reference survives to a removed global', () => {
  // MAP_TARGET belonged to the old single-destination design; a stale handler
  // still assigned it and would have thrown ReferenceError on click.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bMAP_TARGET\b/.test(code), 'MAP_TARGET is gone; a reference remains');
});

// ── Electron-specific traps ─────────────────────────────────────────────────
check('the renderer never calls window.prompt (Electron does not implement it)', () => {
  // This is why the first profile save silently did nothing: prompt() returns
  // undefined in Electron, and the `if (name)` guard below it skipped the write.
  const calls = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bwindow\.prompt\s*\(/.test(calls),
    'window.prompt() found — use askText(), which Electron can actually show');
  assert.ok(!/(^|[^.\w])prompt\s*\(/.test(calls.replace(/askText/g, '')),
    'a bare prompt() call found');
});

// ── profile persistence, through the real module ────────────────────────────
import { createRequire as _cr } from 'node:module';
import { mkdtempSync, rmSync as _rm, existsSync as _ex, readFileSync as _rf } from 'node:fs';
import { tmpdir } from 'node:os';

const _require = _cr(import.meta.url);
const profiles = _require(path.join(ROOT, 'electron', 'profiles.cjs'));
const userData = mkdtempSync(path.join(tmpdir(), 'sm-profiles-'));
const fakeApp = { getPath: () => userData };

check('saving a profile actually writes a file that can be read back', () => {
  const p = profiles.empty('UIZ Windows');
  p.shared.aliases = [['UIH Dental', 'u0004_Custom_Haptic_VR_Dentistry']];
  p.local.driveRoots = ['H:\\My Drive'];
  p.local.nasRoots = ['Z:\\Projects'];

  const r = profiles.save(fakeApp, p);
  assert.ok(r.file, 'save returned no file path');
  assert.ok(_ex(r.file), `save reported ${r.file} but nothing is there`);

  const back = profiles.load(fakeApp, r.file);
  assert.equal(back.name, 'UIZ Windows');
  assert.deepEqual(back.shared.aliases, [['UIH Dental', 'u0004_Custom_Haptic_VR_Dentistry']]);
  assert.deepEqual(back.local.nasRoots, ['Z:\\Projects'], 'local paths must round-trip');
});

check('a saved profile appears in the list with its counts', () => {
  const list = profiles.list(fakeApp);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'UIZ Windows');
  assert.equal(list[0].counts.aliases, 1);
  assert.equal(list[0].counts.nasRoots, 1);
});

check('setting a default marks exactly that profile', () => {
  const list = profiles.list(fakeApp);
  profiles.setDefault(fakeApp, list[0].file);
  assert.equal(profiles.list(fakeApp)[0].isDefault, true);
  assert.equal(profiles.getSettings(fakeApp).defaultProfile, list[0].file);
});

check('a name with path separators cannot escape the profiles folder', () => {
  const r = profiles.save(fakeApp, profiles.empty('../../evil/../name'));
  assert.ok(path.dirname(r.file).endsWith('profiles'),
    `profile escaped its folder: ${r.file}`);
});

check('export defaults to rules only — local paths are not leaked', () => {
  const p = profiles.load(fakeApp, profiles.list(fakeApp).find((x) => x.name === 'UIZ Windows').file);
  const out = path.join(userData, 'shared.json');
  profiles.exportProfile(p, out, false);
  const shared = JSON.parse(_rf(out, 'utf8'));
  assert.deepEqual(shared.shared.aliases, [['UIH Dental', 'u0004_Custom_Haptic_VR_Dentistry']]);
  assert.deepEqual(shared.local.nasRoots, [], 'export leaked machine-specific paths');
  profiles.exportProfile(p, out, true);
  assert.deepEqual(JSON.parse(_rf(out, 'utf8')).local.nasRoots, ['Z:\\Projects'],
    'explicit include-paths export should carry them');
});

_rm(userData, { recursive: true, force: true });

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
