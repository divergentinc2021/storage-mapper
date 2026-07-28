/**
 * Fixture test. Builds a miniature Drive mount and NAS, runs the real CLI, and
 * asserts the verdict for every file.
 *
 * The cases that matter are the ones a naive folder-compare gets wrong:
 *   - a file RENAMED between Drive and NAS but byte-identical  → duplicate (md5)
 *   - a file with the same name and size but different content → conflict
 *   - a .gdoc stub                                             → native, never copied
 *   - the same project under an old code name on a second NAS root → overlap
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = path.join(HERE, '.tmp');
const md5 = (s) => createHash('md5').update(s).digest('hex');

rmSync(TMP, { recursive: true, force: true });

// "Drive for Desktop" mount — the path deliberately contains "My Drive" so the
// safety guard is exercised for real.
const DRIVE = path.join(TMP, 'drive', 'My Drive');
const NAS = path.join(TMP, 'nas', 'Projects');
const NAS_OLD = path.join(TMP, 'nas', 'Resources', 'Projects');

const w = (p, content) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, content); };

// ---- content -------------------------------------------------------------
const C = {
  identical: 'IDENTICAL-CONTENT-' + 'x'.repeat(500),
  renamed:   'RENAMED-BUT-SAME-' + 'y'.repeat(700),
  brandNew:  'BRAND-NEW-FILE-' + 'z'.repeat(300),
  driveVer:  'VERSION-A-' + 'q'.repeat(400),
  nasVer:    'VERSION-B-' + 'r'.repeat(400), // same length as driveVer on purpose
  shared:    'SHARED-ACROSS-NAS-ROOTS-' + 'w'.repeat(600),
};
assert.equal(C.driveVer.length, C.nasVer.length, 'version clash fixture must be equal-size');

// Drive side
w(path.join(DRIVE, 'Dental VR', 'scan_001.mp4'), C.identical);   // dup, same name
w(path.join(DRIVE, 'Dental VR', 'take_final.mov'), C.renamed);   // dup, RENAMED
w(path.join(DRIVE, 'Dental VR', 'newclip.mp4'), C.brandNew);     // new
w(path.join(DRIVE, 'Dental VR', 'report.mp4'), C.driveVer);      // conflict
w(path.join(DRIVE, 'Dental VR', 'Budget.gsheet'),
  JSON.stringify({ url: 'https://docs.google.com/open?id=SHEET123', doc_id: 'SHEET123' }));
w(path.join(DRIVE, 'Dental VR', 'Notes.gdoc'),
  JSON.stringify({ url: 'https://docs.google.com/open?id=DOC456', doc_id: 'DOC456' }));
w(path.join(DRIVE, 'Dental VR', 'Signup.gform'),
  JSON.stringify({ url: 'https://docs.google.com/open?id=FORM789', doc_id: 'FORM789' }));

// NAS side — note the renamed file lives under a DIFFERENT name
w(path.join(NAS, 'Internal UWC Projects', 'Preclinical Dental Education VR & Haptics', 'scan_001.mp4'), C.identical);
w(path.join(NAS, 'Internal UWC Projects', 'Preclinical Dental Education VR & Haptics', 'TAKE_FINAL_v2.mov'), C.renamed);
w(path.join(NAS, 'Internal UWC Projects', 'Preclinical Dental Education VR & Haptics', 'report.mp4'), C.nasVer);
w(path.join(NAS, 'Internal UWC Projects', 'Preclinical Dental Education VR & Haptics', 'shared_asset.psd'), C.shared);
// second, older NAS tree under the code name → NAS-internal overlap
w(path.join(NAS_OLD, 'u0004_Custom_Haptic_VR_Dentistry', 'shared_asset.psd'), C.shared);

// ---- Drive API manifest (md5 comes from the API, free) --------------------
const manifestRows = [
  ['drive_id', 'name', 'path', 'class', 'mime', 'bytes', 'days_inactive', 'action', 'export_as', 'md5'],
  ['id1', 'scan_001.mp4', 'My Drive/Dental VR/scan_001.mp4', 'binary-dead', 'video/mp4', C.identical.length, '900', 'move-to-nas-then-trash', '', md5(C.identical)],
  ['id2', 'take_final.mov', 'My Drive/Dental VR/take_final.mov', 'binary-dead', 'video/quicktime', C.renamed.length, '900', 'move-to-nas-then-trash', '', md5(C.renamed)],
  ['id3', 'newclip.mp4', 'My Drive/Dental VR/newclip.mp4', 'binary-dead', 'video/mp4', C.brandNew.length, '900', 'move-to-nas-then-trash', '', md5(C.brandNew)],
  ['id4', 'report.mp4', 'My Drive/Dental VR/report.mp4', 'binary-dead', 'video/mp4', C.driveVer.length, '900', 'move-to-nas-then-trash', '', md5(C.driveVer)],
];
const manifestCsv = path.join(TMP, 'manifest.csv');
w(manifestCsv, manifestRows.map((r) => r.join(',')).join('\n') + '\n');

const cfg = path.join(TMP, 'mapping.json');
w(cfg, JSON.stringify({
  nasRoots: [NAS, NAS_OLD],
  driveRoots: [DRIVE],
  aliases: [['u0004_Custom_Haptic_VR_Dentistry', 'Preclinical Dental Education VR & Haptics']],
  map: [{ drive: 'Dental VR', nas: 'Projects/Internal UWC Projects/Preclinical Dental Education VR & Haptics/_fromDrive' }],
}, null, 2));

// ---- run ------------------------------------------------------------------
const OUT = path.join(TMP, 'out');
execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.mjs'),
  '--config', cfg, '--manifest', manifestCsv, '--out', OUT], { stdio: 'pipe' });

const csv = (f) => {
  const lines = readFileSync(path.join(OUT, f), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((l) => {
    // fixtures contain no quoted commas, so a plain split is sufficient here
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
};

const dups = csv('duplicates.csv');
const news = csv('new.csv');
const nats = csv('natives.csv');
const cons = csv('conflicts.csv');
const over = csv('nas-internal-overlap.csv');
const summary = JSON.parse(readFileSync(path.join(OUT, 'summary.json'), 'utf8'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\nstorage-mapper fixture test\n');

check('identical file is a duplicate', () => {
  const r = dups.find((d) => d.name === 'scan_001.mp4');
  assert.ok(r, 'scan_001.mp4 not reported as duplicate');
  assert.equal(r.tier, 'md5');
});

check('RENAMED-but-identical file is a duplicate (the case name-matching misses)', () => {
  const r = dups.find((d) => d.drivePath.endsWith('take_final.mov'));
  assert.ok(r, 'renamed duplicate was not detected');
  assert.equal(r.tier, 'md5');
  assert.ok(r.nasPath.includes('TAKE_FINAL_v2.mov'), `matched wrong NAS file: ${r.nasPath}`);
});

check('same name + same size but different content is a CONFLICT, not a duplicate', () => {
  assert.ok(!dups.find((d) => d.name === 'report.mp4'), 'report.mp4 wrongly called a duplicate');
  const c = cons.find((x) => x.name === 'report.mp4');
  assert.ok(c, 'report.mp4 not reported as a conflict');
});

check('brand new file is new, with a mapped destination', () => {
  const r = news.find((n) => n.name === 'newclip.mp4');
  assert.ok(r, 'newclip.mp4 missing from new.csv');
  assert.ok(r.proposedNas.includes('_fromDrive'), `no mapped destination: ${r.proposedNas}`);
});

check('native stubs are classified, never copied', () => {
  assert.equal(nats.length, 3, `expected 3 natives, got ${nats.length}`);
  const sheet = nats.find((n) => n.name === 'Budget.gsheet');
  assert.equal(sheet.exportAs, 'xlsx');
  assert.equal(sheet.docId, 'SHEET123');
  const form = nats.find((n) => n.name === 'Signup.gform');
  assert.equal(form.exportAs, '', 'Forms have no export path and must say so');
  for (const n of nats) {
    assert.ok(!news.find((x) => x.name === n.name), `${n.name} leaked into new.csv`);
    assert.ok(!dups.find((x) => x.name === n.name), `${n.name} leaked into duplicates.csv`);
  }
});

check('NAS-internal overlap across the two trees is reported', () => {
  const r = over.find((o) => o.name === 'shared_asset.psd');
  assert.ok(r, 'cross-root overlap not detected');
  assert.equal(Number(r.copies), 2);
});

check('Drive mount was never hashed (only NAS size-collision candidates)', () => {
  assert.ok(summary.stats.hashedFiles <= 4,
    `hashed ${summary.stats.hashedFiles} files; should only hash size-collision candidates`);
  assert.ok(summary.stats.hashedBytes < 10_000, 'hashed far more bytes than the fixtures contain');
});

check('a copy plan was produced and copies only new files', () => {
  const bat = readFileSync(path.join(OUT, 'copy-plan.bat'), 'utf8');
  assert.ok(bat.includes('newclip.mp4'), 'plan omits the new file');
  assert.ok(!bat.includes('scan_001.mp4'), 'plan would re-copy a duplicate');
  assert.ok(!bat.includes('Budget.gsheet'), 'plan would copy a native stub');
  assert.ok(!/\/MIR\b/.test(bat), 'plan must never mirror (would delete on the NAS)');
});

// The guard: passing a Drive mount as a NAS root must be refused outright.
check('refuses a Drive mount passed as --nas', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.mjs'),
      '--nas', DRIVE, '--drive', DRIVE, '--out', path.join(TMP, 'out2')], { stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.equal(code, 2, 'should exit 2 rather than hash a Drive mount');
  assert.ok(!existsSync(path.join(TMP, 'out2')), 'should not have produced output');
});

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
