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
    // Set per-test; a scan or compare returns whatever this yields.
    scan: () => Promise.resolve(win.__scanResult),
    exportOptions: () => Promise.resolve({ hasRun: false, scanned: false, driveFiles: 0, newRows: 0, compared: false }),
    exportManifest: noop, verifyCopy: () => Promise.resolve({ ok: 0, missing: [], short: [] }),
    verifyDest: (rows) => Promise.resolve(win.__destVerdicts || { verdicts: {}, checked: rows.length }),
    exportFailures: noop, inspectDest: () => Promise.resolve({}),
    preflightCopy: (rows) => Promise.resolve(win.__preflight || { ready: rows, blocked: [] }),
  },
  __scanResult: null,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  prompt: () => null, confirm: () => false,
};

const sandbox = { document: doc, window: win, console, setTimeout, Set, JSON, Math, Date };
const fn = new Function(...Object.keys(sandbox), `${src}\n; return { get RESULT(){return RESULT}, set RESULT(v){RESULT=v},
  syncStageButtons, copyReadyRows, isAbsoluteDest, classifyAgainstDest, applyDestVerdicts,
  clashingRoots, renderPaths, verifyDuplicates, destForDrivePath,
  actionableRows, electedConflictRows, alongsideName,
  get MAPPING(){return MAPPING}, set MAPPING(v){MAPPING=v},
  get CONFLICT_PICKS(){return CONFLICT_PICKS}, set CONFLICT_PICKS(v){CONFLICT_PICKS=v},
  get CONV_ROOTS(){return CONV_ROOTS}, set CONV_ROOTS(v){CONV_ROOTS=v},
  get MAPPED(){return MAPPED}, set MAPPED(v){MAPPED=v},
  get DRIVE_ROOTS(){return DRIVE_ROOTS}, set DRIVE_ROOTS(v){DRIVE_ROOTS=v},
  get NAS_ROOTS(){return NAS_ROOTS}, set NAS_ROOTS(v){NAS_ROOTS=v},
  get SEP(){return SEP}, set SEP(v){SEP=v},
  get SCANNED(){return SCANNED}, set SCANNED(v){SCANNED=v},
  get COPY_ROWS(){return COPY_ROWS}, set COPY_ROWS(v){COPY_ROWS=v},
  get BLOCKED(){return BLOCKED}, set BLOCKED(v){BLOCKED=v},
  runScan, runCompare, openCopy };`);
const api = fn(...Object.values(sandbox));

let failures = 0;
const check = (name, f) => {
  try { f(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\nrenderer: staged Compare -> Map -> Copy\n');

/*
  The renderer carries its own copy of the both-sides check so it can warn while
  you are still assembling the lists. That duplication is the risk, so pin it to
  the authoritative implementation in src/mapplan.mjs on the same inputs — a
  drift here means the app stops warning about a profile Compare will reject.
*/
const { crossOverlap } = await import('../src/mapplan.mjs');
check('the renderer clash check agrees with mapplan.crossOverlap', () => {
  api.SEP = '\\';   // Windows semantics: case-insensitive
  const cases = [
    [['H:/SD/External Client Projects', 'Z:/Internal UWC Projects'],
     ['Z:/External Client Projects', 'Z:/Internal UWC Projects']],
    [['H:/a'], ['Z:/b']],
    [['Z:/Projects/Sub'], ['Z:/Projects']],
    [['Z:/Projects'], ['Z:/Projects/Sub']],
    [['Z:\\Internal UWC Projects\\'], ['z:/internal uwc projects']],
    [[], ['Z:/a']],
  ];
  for (const [d, n] of cases) {
    api.DRIVE_ROOTS = d; api.NAS_ROOTS = n;
    const mine = api.clashingRoots().pairs.length;
    const theirs = crossOverlap(d, n).length;
    assert.equal(mine, theirs, `disagreed on ${JSON.stringify(d)} vs ${JSON.stringify(n)}`);
  }
});

check('a profile loaded with a NAS path in the Drive list warns immediately', () => {
  api.SEP = '\\';
  api.DRIVE_ROOTS = ['H:/SD/External Client Projects', 'Z:/Internal UWC Projects'];
  api.NAS_ROOTS = ['Z:/External Client Projects', 'Z:/Internal UWC Projects'];
  api.renderPaths();
  const hint = doc.getElementById('setupHint');
  assert.match(hint.className, /\bbad\b/, 'the hint must be flagged, not just reworded');
  assert.match(hint.textContent, /on both sides/);
  assert.match(hint.textContent, /Internal UWC Projects/, 'it must name the offending folder');
  // and the offending chip is marked in each list
  assert.match(doc.getElementById('drivePaths').innerHTML, /chip bad/);
  assert.match(doc.getElementById('nasPaths').innerHTML, /chip bad/);
});

check('clean lists leave the hint unflagged', () => {
  api.SEP = '\\';
  api.DRIVE_ROOTS = ['H:/SD/External Client Projects'];
  api.NAS_ROOTS = ['Z:/External Client Projects'];
  api.renderPaths();
  const hint = doc.getElementById('setupHint');
  assert.doesNotMatch(hint.className, /\bbad\b/);
  assert.match(hint.textContent, /Nothing will be copied/);
  assert.doesNotMatch(doc.getElementById('drivePaths').innerHTML, /chip bad/);
});

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
  // Scan is now a way in as well, so the prompt must name both.
  assert.match(mapBtn.title, /Scan only, or Compare/);
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
  // Wording is free to change; what it must do is send the user to Map.
  assert.match(copyBtn.title, /\bMap\b/);
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

// ── scan without compare ────────────────────────────────────────────────────
console.log('\nscan without compare\n');

const acheck = async (name, f) => {
  try { await f(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

await acheck('Scan needs only a Drive folder; Compare still needs both', () => {
  api.DRIVE_ROOTS = ['H:/SD/Projects']; api.NAS_ROOTS = [];
  api.renderPaths();
  assert.equal(doc.getElementById('btnScan').disabled, false,
    'a source alone must be enough to scan — that is the empty-destination case');
  assert.equal(doc.getElementById('btnCompare').disabled, true,
    'Compare still needs something to compare against');
  assert.match(doc.getElementById('setupHint').textContent, /No NAS folder yet/);
});

await acheck('a scan lights Map without any comparison', async () => {
  api.RESULT = null; api.MAPPED = null; api.SCANNED = false;
  doc.getElementById('btnExport').disabled = true;
  win.__scanResult = {
    type: 'done', scanned: true,
    result: { duplicates: [], conflicts: [], natives: [], errors: [], new: [
      { drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: '' },
      { drivePath: 'a/y.mp4', name: 'y.mp4', size: 20, driveRoot: 'H:/d', proposedNas: '' },
    ], stats: {} },
    droppedRoots: [], nasProbes: [], driveProbes: [],
  };
  await api.runScan();
  assert.equal(api.SCANNED, true);
  assert.equal(mapBtn.disabled, false, 'Map must open after a scan alone');
  assert.match(mapBtn.textContent, /Map 2 new/);
  assert.equal(doc.getElementById('btnExport').disabled, false,
    'a scan must make the manifest exportable');
  assert.equal(copyBtn.disabled, true, 'Copy still waits for a mapped destination');
});

await acheck('a FAILED compare clears the stage instead of leaving the last run lit', async () => {
  // Land a good scan first so there is something stale to leak.
  await api.runScan();
  assert.equal(doc.getElementById('btnExport').disabled, false);

  win.mapper.compare = () => Promise.resolve({ type: 'error', message: 'NAS folders cannot be read' });
  await api.runCompare();

  assert.equal(api.RESULT, null, 'the previous result must not survive a failed compare');
  assert.equal(doc.getElementById('btnExport').disabled, true,
    'Export stayed lit after a failure and silently wrote the PREVIOUS run');
  assert.equal(mapBtn.disabled, true, 'Map must not offer rows with no run behind them');
  assert.equal(copyBtn.disabled, true);
});

await acheck('an unreadable file never reaches the copy plan', async () => {
  api.MAPPED = [
    { drivePath: 'a/good.mp4', name: 'good.mp4', size: 10, driveRoot: 'H:/d',
      driveAbs: 'H:/d/a/good.mp4', proposedNas: 'Z:/N/a/good.mp4' },
    { drivePath: 'a/stub.gvid', name: 'stub.gvid', size: 174, driveRoot: 'H:/d',
      driveAbs: 'H:/d/a/stub.gvid', proposedNas: 'Z:/N/a/stub.gvid' },
  ];
  api.RESULT = { new: api.MAPPED };
  win.__preflight = {
    ready: [api.MAPPED[0]],
    blocked: [{ ...api.MAPPED[1], kind: 'stub',
                reason: 'a Google-native file with no contents — there is nothing to copy' }],
  };
  await api.openCopy();

  assert.equal(api.BLOCKED.length, 1);
  assert.equal(api.COPY_ROWS.length, 1, 'the blocked row must be removed from the plan entirely');
  assert.equal(api.COPY_ROWS[0].name, 'good.mp4');
  assert.equal(doc.getElementById('copyBlocked').hidden, false, 'and it must be reported, not silently dropped');
});

await acheck('a run still works after #emptyState has been destroyed', async () => {
  /*
   * renderTab() and both failure paths replace #main's innerHTML, and
   * #emptyState is a CHILD of #main — so it stops existing as soon as anything
   * has been rendered. Referring to it directly therefore worked exactly once
   * per session; the second run threw before entering its try block and left
   * the window frozen at "Starting…" with every control disabled.
   */
  const real = doc.getElementById;
  doc.getElementById = (id) => (id === 'emptyState' ? null : real(id));
  try {
    win.__scanResult = {
      type: 'done', scanned: true,
      result: { duplicates: [], conflicts: [], natives: [], errors: [], new: [
        { drivePath: 'a/x.mp4', name: 'x.mp4', size: 10, driveRoot: 'H:/d', proposedNas: '' },
      ], stats: {} },
      droppedRoots: [], nasProbes: [], driveProbes: [],
    };
    api.DRIVE_ROOTS = ['H:/d']; api.NAS_ROOTS = ['Z:/n'];
    await api.runScan();
  } finally {
    doc.getElementById = real;
  }

  assert.equal(doc.getElementById('bar').hidden, true, 'the bar must not be left spinning');
  assert.equal(doc.getElementById('btnScan').disabled, false, 'Scan must come back');
  assert.equal(doc.getElementById('btnCompare').disabled, false, 'Compare must come back');
  assert.equal(api.SCANNED, true, 'and the scan itself must still have worked');
});

/*
 * The case the whole change exists for: a file at the destination with the same
 * size but different content. It used to be called identical and skipped, so it
 * never reached the NAS and nothing said so.
 */
check('a same-size impostor at the destination is caught and re-selected', () => {
  const rows = [
    { name: 'Plan.docx', proposedNas: 'Z:/n/Plan.docx', size: 100, md5: 'aaa' },
    { name: 'Real.docx', proposedNas: 'Z:/n/Real.docx', size: 100, md5: 'bbb' },
  ];
  const classified = api.classifyAgainstDest(rows, {
    'z:/n/plan.docx': { size: 100 },
    'z:/n/real.docx': { size: 100 },
  });
  assert.deepEqual(classified.map((r) => r.state), ['identical', 'identical']);
  assert.deepEqual(classified.map((r) => r.selected), [false, false], 'both skipped on size alone');
  assert.deepEqual(classified.map((r) => r.proof), ['size', 'size'], 'marked as presumption');

  const verified = api.applyDestVerdicts(classified, {
    'Z:/n/Plan.docx': 'differs',   // same size, different bytes
    'Z:/n/Real.docx': 'same',
  });
  assert.equal(verified[0].state, 'different', 'the impostor is no longer called identical');
  assert.equal(verified[0].selected, true, 'and it gets copied');
  assert.equal(verified[0].proof, 'md5');
  assert.equal(verified[1].state, 'identical', 'the genuine duplicate stays skipped');
  assert.equal(verified[1].selected, false);
  assert.equal(verified[1].proof, 'md5', 'and is now proven, not assumed');
});

/*
 * The reported symptom: Compare said everything was already on the NAS, so New
 * was 0 and Map was dead. If some of those matches are wrong, verifying has to
 * hand the files back as copyable work — otherwise the check is a read-only
 * opinion and Map stays grey.
 */
check('a duplicate that is not really a duplicate becomes copyable, and lights Map', async () => {
  const realAlert = win.alert;
  win.alert = () => {};
  try {
    api.MAPPING = { nasRoots: [], driveRoots: [], aliases: [], map: [] };
    api.NAS_ROOTS = ['Z:/n'];
    api.RESULT = {
      duplicates: [
        { drivePath: 'P/Impostor.docx', nasPath: 'Z:/n/Impostor.docx', name: 'Impostor.docx',
          size: 100, tier: 'size+name', md5: 'aaa', driveRoot: 'H:/d', driveAbs: 'H:/d/P/Impostor.docx' },
        { drivePath: 'P/Genuine.docx', nasPath: 'Z:/n/Genuine.docx', name: 'Genuine.docx',
          size: 100, tier: 'size+name', md5: 'bbb', driveRoot: 'H:/d', driveAbs: 'H:/d/P/Genuine.docx' },
      ],
      new: [], conflicts: [], natives: [], errors: [], stats: {},
    };
    api.MAPPED = null;
    api.SCANNED = false;
    api.syncStageButtons();
    assert.equal(doc.getElementById('btnMapTop').disabled, true, 'Map starts disabled — nothing new');

    win.__destVerdicts = { verdicts: { 'Z:/n/Impostor.docx': 'differs', 'Z:/n/Genuine.docx': 'same' } };
    await api.verifyDuplicates();

    assert.equal(api.RESULT.duplicates.length, 1, 'the impostor left the duplicates list');
    assert.equal(api.RESULT.duplicates[0].name, 'Genuine.docx');
    assert.equal(api.RESULT.duplicates[0].verified, 'same', 'the genuine one is now proven');

    assert.equal(api.RESULT.new.length, 1, 'and became new work');
    const rescued = api.RESULT.new[0];
    assert.equal(rescued.name, 'Impostor.docx');
    assert.ok(rescued.driveAbs, 'a rescued row must carry its source or it cannot be copied');
    assert.ok(rescued.proposedNas, 'and a destination');
    assert.ok(api.isAbsoluteDest(rescued.proposedNas), 'an absolute one, or the plan skips it');
    assert.equal(doc.getElementById('btnMapTop').disabled, false, 'Map is live again');
  } finally {
    win.alert = realAlert;
  }
});

check('verifying does not disturb matches it could not read', async () => {
  const realAlert = win.alert;
  win.alert = () => {};
  try {
    api.NAS_ROOTS = ['Z:/n'];
    api.RESULT = {
      duplicates: [{ drivePath: 'P/A.docx', nasPath: 'Z:/n/A.docx', name: 'A.docx', size: 1,
                     tier: 'size+name', md5: 'aaa', driveRoot: 'H:/d', driveAbs: 'H:/d/P/A.docx' }],
      new: [], conflicts: [], natives: [], errors: [], stats: {},
    };
    win.__destVerdicts = { verdicts: { 'Z:/n/A.docx': 'unreadable' } };
    await api.verifyDuplicates();
    assert.equal(api.RESULT.duplicates.length, 1, 'still treated as already there');
    assert.equal(api.RESULT.new.length, 0, 'an unreadable NAS file is not evidence of a difference');
    assert.equal(api.RESULT.duplicates[0].verified, 'unreadable', 'but the doubt is recorded');
  } finally {
    win.alert = realAlert;
  }
});

/*
 * Reported directly: "a bit wrong to disable map and copy just because there is
 * no new". A run with 0 new but an updated file and convertible stubs has work
 * to do, and the buttons that do it were both dead.
 */
check('an updated file is copyable even though nothing is new', () => {
  api.CONFLICT_PICKS = {};
  api.MAPPED = null;
  api.SCANNED = false;
  api.RESULT = {
    duplicates: [], new: [], natives: [], errors: [], stats: {},
    conflicts: [{
      drivePath: 'P/Report.docx', nasPath: 'Z:/n/P/Report.docx', name: 'Report.docx',
      driveSize: 331, nasSize: 330, size: 331, reason: 'same name, different size',
      driveRoot: 'H:/d', driveAbs: 'H:/d/P/Report.docx',
      proposedNas: 'Z:/n/P/Report.docx', mappedBy: 'mirror',
    }],
  };

  api.syncStageButtons();
  assert.equal(doc.getElementById('btnMapTop').disabled, true, 'nothing chosen yet, so nothing to do');
  assert.match(doc.getElementById('btnMapTop').title, /Conflicts/,
    'but it must say where the waiting work is, not just "nothing new"');

  api.CONFLICT_PICKS = { 'P/Report.docx': 'alongside' };
  api.syncStageButtons();
  assert.equal(api.actionableRows().length, 1);
  assert.equal(doc.getElementById('btnMapTop').disabled, false, 'Map is live');
  assert.match(doc.getElementById('btnMapTop').textContent, /Map 1 file…/,
    'and it must not call an elected conflict "new"');

  // Copy stays behind Map, as it does for new files — see the gate test above.
  assert.equal(doc.getElementById('btnCopyTop').disabled, true);
  api.MAPPED = api.actionableRows();
  api.syncStageButtons();
  assert.equal(doc.getElementById('btnCopyTop').disabled, false, 'and unlocks once mapped');
});

check('copy alongside never targets the NAS file it conflicts with', () => {
  api.RESULT = {
    duplicates: [], new: [], natives: [], errors: [], stats: {},
    conflicts: [{
      drivePath: 'P/Report.docx', nasPath: 'Z:/n/P/Report.docx', name: 'Report.docx',
      driveSize: 331, nasSize: 330, size: 331, reason: 'same name, different size',
      driveRoot: 'H:/d', driveAbs: 'H:/d/P/Report.docx',
      proposedNas: 'Z:/n/P/Report.docx', mappedBy: 'mirror',
    }],
  };

  api.CONFLICT_PICKS = { 'P/Report.docx': 'alongside' };
  var r = api.electedConflictRows()[0];
  assert.notEqual(r.proposedNas, 'Z:/n/P/Report.docx', 'the default must not overwrite');
  assert.equal(r.proposedNas, 'Z:/n/P/Report (from Drive).docx');
  assert.match(r.mappedBy, /alongside/);
  assert.ok(r.driveAbs, 'and it must be copyable');

  api.CONFLICT_PICKS = { 'P/Report.docx': 'replace' };
  var r2 = api.electedConflictRows()[0];
  assert.equal(r2.proposedNas, 'Z:/n/P/Report.docx', 'replace targets the NAS file, by explicit choice');
  assert.match(r2.mappedBy, /replaces/);
});

check('the alongside name keeps the extension', () => {
  assert.equal(api.alongsideName('Z:/n/a/Report.docx'), 'Z:/n/a/Report (from Drive).docx');
  assert.equal(api.alongsideName('Z:\\n\\a\\Report.tar.gz'), 'Z:\\n\\a\\Report.tar (from Drive).gz');
  assert.equal(api.alongsideName('Z:/n/README'), 'Z:/n/README (from Drive)');
});

check('leaving a conflict alone keeps it out of the plan', () => {
  api.CONFLICT_PICKS = {};
  assert.equal(api.electedConflictRows().length, 0);
  assert.equal(api.actionableRows().length, 0);
});

check('unconverted stubs are named as waiting work, not a dead end', () => {
  api.CONFLICT_PICKS = {};
  api.CONV_ROOTS = [];
  api.MAPPED = null;
  api.SCANNED = false;
  api.RESULT = {
    duplicates: [], new: [], conflicts: [], errors: [], stats: {},
    natives: [
      { drivePath: 'P/A.gdoc', name: 'A.gdoc', kind: 'doc', resolved: false },
      { drivePath: 'P/B.gdoc', name: 'B.gdoc', kind: 'doc', resolved: false },
    ],
  };
  api.syncStageButtons();
  assert.match(doc.getElementById('btnMapTop').title, /2 Google stub/,
    'the tooltip has to point at the stubs rather than claim there is nothing to do');
});

check('a destination that cannot be read is left skipped, and says so', () => {
  const classified = api.classifyAgainstDest(
    [{ name: 'A.bin', proposedNas: 'Z:/n/A.bin', size: 10, md5: 'aaa' }],
    { 'z:/n/a.bin': { size: 10 } }
  );
  const v = api.applyDestVerdicts(classified, { 'Z:/n/A.bin': 'unreadable' });
  assert.equal(v[0].state, 'identical');
  assert.equal(v[0].selected, false, 'an unreadable destination is not a reason to overwrite');
  assert.equal(v[0].proof, 'unreadable', 'and the uncertainty is recorded');
});

check('rows without an md5 are left exactly as the size check found them', () => {
  const classified = api.classifyAgainstDest(
    [{ name: 'A.bin', proposedNas: 'Z:/n/A.bin', size: 10 }],
    { 'z:/n/a.bin': { size: 10 } }
  );
  const v = api.applyDestVerdicts(classified, {});
  assert.equal(v[0].state, 'identical');
  assert.equal(v[0].proof, 'size', 'no manifest md5 means the claim stays a presumption');
});

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
