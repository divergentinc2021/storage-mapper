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
  syncCopyButton, copyReadyRows, isAbsoluteDest };`);
const api = fn(...Object.values(sandbox));

let failures = 0;
const check = (name, f) => {
  try { f(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\nrenderer copy-button logic\n');

const btn = doc.getElementById('btnCopyTop');

check('disabled before any comparison, and says why', () => {
  api.RESULT = null;
  api.syncCopyButton();
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /Run a comparison first/);
});

check('ENABLED when new rows have absolute destinations', () => {
  api.RESULT = { new: [
    { drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: 'Z:/Projects/a/x.mp4' },
    { drivePath: 'a/y.mp4', name: 'y.mp4', size: 20, driveRoot: 'H:/d', proposedNas: 'Z:/Projects/a/y.mp4' },
  ] };
  api.syncCopyButton();
  assert.equal(btn.disabled, false, 'button stayed disabled with copyable rows');
  assert.match(btn.textContent, /Copy 2 to NAS/);
});

check('disabled but explains itself when destinations are relative', () => {
  api.RESULT = { new: [
    { drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: 'Projects/a/x.mp4' },
  ] };
  api.syncCopyButton();
  assert.equal(btn.disabled, true, 'a relative destination must not be copyable');
  assert.match(btn.title, /Set destination/);
});

check('disabled with the right reason when nothing is new', () => {
  api.RESULT = { new: [] };
  api.syncCopyButton();
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /already on the NAS/);
});

check('UNC destinations count as absolute', () => {
  assert.equal(api.isAbsoluteDest('\\\\UIZ-NAS\\Projects\\x'), true);
  assert.equal(api.isAbsoluteDest('Z:\\Projects\\x'), true);
  assert.equal(api.isAbsoluteDest('Projects\\x'), false);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
