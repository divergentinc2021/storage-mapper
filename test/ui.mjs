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

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
