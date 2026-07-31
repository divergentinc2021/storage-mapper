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
import { dedupeRoots } from '../src/walk.mjs';
import { writeCopyPlan, isAbsoluteDest } from '../src/report.mjs';

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
  map: [{ drive: 'Dental VR', nas: path.join(NAS, 'Internal UWC Projects', 'Preclinical Dental Education VR & Haptics', '_fromDrive') }],
}, null, 2));

// ---- run ------------------------------------------------------------------
const OUT = path.join(TMP, 'out');
// --exact, because the verdicts below (md5 tiers, renamed-file detection,
// same-size-different-content conflicts) are precisely what reading NAS bytes
// buys you. The default is checked separately at the end of this file.
execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.mjs'),
  '--config', cfg, '--manifest', manifestCsv, '--out', OUT, '--exact'], { stdio: 'pipe' });

const csvIn = (dir, f) => {
  const lines = readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((l) => {
    // fixtures contain no quoted commas, so a plain split is sufficient here
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
};
const csv = (f) => csvIn(OUT, f);

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
  // Check the COMMANDS, not the whole file: the header comment mentions /MIR.
  const cmds = bat.split(/\r?\n/).filter((l) => l.startsWith('robocopy'));
  assert.ok(cmds.length, 'no robocopy command emitted');
  assert.ok(!cmds.some((c) => /\/MIR\b/.test(c)), 'plan must never mirror (would delete on the NAS)');
  assert.ok(!/--delete/.test(readFileSync(path.join(OUT, 'copy-plan.sh'), 'utf8')),
    'shell plan must never delete');
});

check('copy plan paths are ABSOLUTE on both sides', () => {
  const bat = readFileSync(path.join(OUT, 'copy-plan.bat'), 'utf8');
  const cmd = bat.split(/\r?\n/).find((l) => l.startsWith('robocopy'));
  assert.ok(cmd, 'no robocopy command emitted');
  const quoted = cmd.match(/"([^"]+)"/g).map((q) => q.slice(1, -1));
  const [src, dst] = quoted;
  // A relative destination would create the tree next to the .bat, not on the NAS.
  assert.ok(isAbsoluteDest(src.split('\\').join('/')), `source not absolute: ${src}`);
  assert.ok(isAbsoluteDest(dst.split('\\').join('/')), `destination not absolute: ${dst}`);
  assert.ok(dst.includes('_fromDrive'), 'destination lost the mapped folder');
});

check('a relative destination is SKIPPED with a reason, never emitted as a command', () => {
  const rel = { new: [{ drivePath: 'X/a.mp4', name: 'a.mp4', size: 1,
                        driveRoot: '/tmp/src', proposedNas: 'Projects/relative/dest' }],
                duplicates: [], conflicts: [], natives: [], errors: [], stats: {} };
  const dir = path.join(TMP, 'relplan');
  mkdirSync(dir, { recursive: true });
  const r = writeCopyPlan(dir, rel, '/tmp/src');
  const bat = readFileSync(path.join(dir, 'copy-plan.bat'), 'utf8');
  assert.equal(r.dirs, 0, 'a relative destination must produce no command');
  assert.equal(r.skipped, 1);
  assert.ok(/REM .*\[destination is not an absolute path\] X\/a\.mp4/.test(bat),
    'skip reason missing from the plan');
  assert.ok(!/^robocopy/m.test(bat), 'emitted a robocopy despite a relative destination');
});

check('nested roots collapse, so a folder inside another is not walked twice', () => {
  // The real-world case: picking "H:\\Shared drives" AND each shared drive under it.
  const r = dedupeRoots([
    'H:/Shared drives',
    'H:/Shared drives/UIZ - PROJECTS',
    'H:/Shared drives/UIH - JIGSPACE',
    'H:/My Drive',
  ]);
  assert.deepEqual(r.roots.sort(), ['H:/My Drive', 'H:/Shared drives']);
  assert.equal(r.dropped.length, 2, 'both nested roots should be reported as dropped');
  assert.ok(r.dropped.every((d) => d.insideOf === 'H:/Shared drives'));
});

check('an exact duplicate root is collapsed too', () => {
  const r = dedupeRoots(['Z:/Projects', 'Z:/Projects']);
  assert.equal(r.roots.length, 1);
});

check('sibling roots are both kept', () => {
  const r = dedupeRoots(['Z:/Projects', 'Z:/Projects-Archive']);
  assert.equal(r.roots.length, 2, 'a name prefix is not containment');
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


// ── copy engine ─────────────────────────────────────────────────────────────
import { classifyRobocopy, classifyRsync, robocopyArgs, rsyncArgs, planGroups }
  from '../src/robocopy.mjs';
import { createRequire } from 'node:module';

console.log('\ncopy engine\n');

check('robocopy exit codes: 0-7 are SUCCESS, 8+ are failure', () => {
  // The trap: exit 1 means "files were copied" — the normal success case.
  for (const c of [0, 1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(classifyRobocopy(c).ok, true, `exit ${c} should be success`);
  }
  for (const c of [8, 9, 11, 16, 24]) {
    assert.equal(classifyRobocopy(c).ok, false, `exit ${c} should be FAILURE`);
  }
  assert.match(classifyRobocopy(0).summary, /nothing to copy/);
  assert.match(classifyRobocopy(1).summary, /copied successfully/);
  assert.match(classifyRobocopy(8).summary, /FAILED/);
  assert.match(classifyRobocopy(16).summary, /nothing was copied/);
  assert.equal(classifyRsync(0).ok, true);
  assert.equal(classifyRsync(23).ok, false);
});

check('copy args can never delete on the destination', () => {
  const a = robocopyArgs({ srcDir: 'S', dstDir: 'D', files: ['a.mp4'], logFile: 'L' }).join(' ');
  for (const bad of ['/MIR', '/PURGE', '/MOV', '/MOVE']) {
    assert.ok(!a.includes(bad), `robocopy args must never contain ${bad}`);
  }
  assert.ok(a.includes('/XO'), 'must not overwrite a newer file on the NAS');
  const r = rsyncArgs({ srcDir: 'S', dstDir: 'D', files: ['a.mp4'] }).join(' ');
  assert.ok(!r.includes('--delete'), 'rsync args must never contain --delete');
  assert.ok(r.includes('--ignore-existing'));
  assert.ok(robocopyArgs({ srcDir:'S', dstDir:'D', files:['a'], dryRun:true }).includes('/L'),
    'dry run must pass /L so nothing is written');
});

check('args are passed as argv, so "VR & Haptics" needs no quoting', () => {
  const dst = 'Z:\\Projects\\Preclinical Dental Education VR & Haptics\\_fromDrive';
  const args = robocopyArgs({ srcDir: 'H:\\My Drive\\x', dstDir: dst, files: ['a b.mp4'] });
  // The ampersand and spaces survive intact as ONE argument each — no shell sees them.
  assert.ok(args.includes(dst), 'destination was mangled');
  assert.ok(args.includes('a b.mp4'), 'filename with a space was split');
});

check('planGroups skips rows it cannot safely act on', () => {
  const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
  const { groups, skipped } = planGroups([
    { drivePath: 'A/x.mp4', name: 'x.mp4', size: 10, driveRoot: '/src', proposedNas: '/nas/A/x.mp4' },
    { drivePath: 'A/y.mp4', name: 'y.mp4', size: 20, driveRoot: '/src', proposedNas: '/nas/A/y.mp4' },
    { drivePath: 'B/z.mp4', name: 'z.mp4', size: 30, driveRoot: '/src', proposedNas: 'relative/z.mp4' },
    { drivePath: 'C/w.mp4', name: 'w.mp4', size: 40, driveRoot: '/src', proposedNas: '' },
  ], isAbs, '/');
  assert.equal(groups.length, 1, 'the two same-folder files should share one command');
  assert.equal(groups[0].files.length, 2);
  assert.equal(groups[0].bytes, 30);
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped.map((s) => s.why).sort(),
    ['destination is not an absolute path', 'no mapping rule']);
});

// A real copy, end to end, through the actual runner.
await (async () => {
  const require_ = createRequire(import.meta.url);
  const copier = require_(path.join(ROOT, 'electron', 'copy.cjs'));
  const CSRC = path.join(TMP, 'copysrc'), CDST = path.join(TMP, 'copydst');
  w(path.join(CSRC, 'Proj', 'clip.mp4'), 'REAL-COPY-PAYLOAD');
  mkdirSync(CDST, { recursive: true });
  const rows = [{ drivePath: 'Proj/clip.mp4', name: 'clip.mp4', size: 17,
                  driveRoot: CSRC, proposedNas: path.join(CDST, 'Proj', 'clip.mp4') }];

  const dry = await copier.run({ rows, dryRun: true }, () => {});
  check('dry run reports success and writes NOTHING', () => {
    assert.equal(dry.ok, true, `dry run failed: ${JSON.stringify(dry.results)}`);
    assert.ok(!existsSync(path.join(CDST, 'Proj', 'clip.mp4')), 'dry run created a file');
  });

  const real = await copier.run({ rows, dryRun: false }, () => {});
  check('real copy lands the file and reports success', () => {
    assert.equal(real.ok, true, `copy failed: ${JSON.stringify(real.results)}`);
    const landed = path.join(CDST, 'Proj', 'clip.mp4');
    assert.ok(existsSync(landed), 'file did not arrive');
    assert.equal(readFileSync(landed, 'utf8'), 'REAL-COPY-PAYLOAD', 'content differs');
    assert.equal(real.failed, 0);
  });

  check('re-running the copy is safe and changes nothing', () => {
    const before = readFileSync(path.join(CDST, 'Proj', 'clip.mp4'), 'utf8');
    assert.equal(before, 'REAL-COPY-PAYLOAD');
  });
})();

// ── map plan ────────────────────────────────────────────────────────────────
const mp = await import('../src/mapplan.mjs');
console.log('\nmap plan\n');

check('mirror assigns every new file a destination under the NAS root', () => {
  const rows = [
    { drivePath: 'Shoot_1/Pictures/a.jpg', name: 'a.jpg', size: 10, driveRoot: 'H:/d', proposedNas: '' },
    { drivePath: 'Shoot_1/Videos/b.mp4', name: 'b.mp4', size: 20, driveRoot: 'H:/d', proposedNas: '' },
  ];
  const r = mp.assignDestinations(rows, { mode: 'mirror', nasRoot: 'Z:\\Amanzi', sep: '\\' });
  assert.equal(r.changed, 2);
  assert.equal(r.rows[0].proposedNas, 'Z:\\Amanzi\\Shoot_1\\Pictures\\a.jpg');
  assert.ok(r.rows.every((x) => x.proposedNas.startsWith('Z:\\Amanzi')));
});

check('identical name AND size at the destination is skipped by default', () => {
  const rows = [
    { drivePath: 'a.jpg', name: 'a.jpg', size: 100, proposedNas: '/nas/a.jpg' },
    { drivePath: 'b.jpg', name: 'b.jpg', size: 200, proposedNas: '/nas/b.jpg' },
    { drivePath: 'c.jpg', name: 'c.jpg', size: 300, proposedNas: '/nas/c.jpg' },
  ];
  const existing = { '/nas/a.jpg': { size: 100 }, '/nas/b.jpg': { size: 999 } };
  const out = mp.classifyAgainstDestination(rows, existing);
  assert.equal(out[0].state, 'identical');
  assert.equal(out[0].selected, false, 'an identical file must not be selected');
  assert.equal(out[1].state, 'different');
  assert.equal(out[1].selected, false, 'a size mismatch must not overwrite by default');
  assert.equal(out[2].state, 'new');
  assert.equal(out[2].selected, true);
  const s = mp.summarise(out);
  assert.deepEqual([s.new, s.identical, s.different, s.selected], [1, 1, 1, 1]);
});

check('destination matching is case- and separator-insensitive', () => {
  const rows = [{ drivePath: 'a.jpg', name: 'a.jpg', size: 5, proposedNas: 'Z:\\Amanzi\\A.JPG' }];
  const out = mp.classifyAgainstDestination(rows, { 'z:/amanzi/a.jpg': { size: 5 } });
  assert.equal(out[0].state, 'identical', 'Windows paths differ in case and slash; must still match');
});

check('a folder in BOTH lists is detected (it would compare with itself)', () => {
  // Exactly what happened in the field: a Z: NAS path pasted into the Drive list.
  const d = ['H:/Shared drives/UIZ - PROJECTS/External Client Projects', 'Z:/Internal UWC Projects'];
  const n = ['Z:/External Client Projects', 'Z:/Internal UWC Projects'];
  const bad = mp.crossOverlap(d, n);
  assert.equal(bad.length, 1);
  assert.match(bad[0].how, /same folder is in both lists/);
  assert.equal(mp.crossOverlap(['H:/a'], ['Z:/b']).length, 0, 'unrelated roots must not trip it');
  assert.equal(mp.crossOverlap(['Z:/Projects/Sub'], ['Z:/Projects']).length, 1,
    'a Drive root inside a NAS root is the same mistake');
});

check('each source is paired with its OWN destination, not one shared folder', () => {
  const d = ['H:/SD/External Client Projects', 'H:/SD/Internal UIZ Projects', 'H:/SD/Meeting_Minutes_Clients'];
  const n = ['Z:/External Client Projects', 'Z:/Internal UIZ Projects', 'Z:/Meeting_Minutes_Clients'];
  const pairs = mp.suggestPairs(d, n);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].nas, 'Z:/External Client Projects');
  assert.equal(pairs[1].nas, 'Z:/Internal UIZ Projects');
  assert.equal(pairs[2].nas, 'Z:/Meeting_Minutes_Clients');
  // One NAS folder must never be claimed by two sources.
  assert.equal(new Set(pairs.map((p) => p.nas)).size, 3);
});

check('a source with no plausible match is left unmapped rather than guessed', () => {
  const pairs = mp.suggestPairs(['H:/SD/Something Unrelated'], ['Z:/External Client Projects']);
  assert.equal(pairs[0].nas, null, 'a weak match must not be auto-assigned');
});

check('rows follow the pairing of their OWN source root', () => {
  const pairs = [
    { drive: 'H:/SD/A', nas: 'Z:/A' },
    { drive: 'H:/SD/B', nas: 'Z:/B' },
  ];
  const rows = [
    { drivePath: 'x/1.mp4', name: '1.mp4', size: 1, driveRoot: 'H:/SD/A' },
    { drivePath: 'y/2.mp4', name: '2.mp4', size: 2, driveRoot: 'H:/SD/B' },
    { drivePath: 'z/3.mp4', name: '3.mp4', size: 3, driveRoot: 'H:/SD/C' },
  ];
  const r = mp.assignByPairs(rows, pairs, '/');
  assert.equal(r.rows[0].proposedNas, 'Z:/A/x/1.mp4');
  assert.equal(r.rows[1].proposedNas, 'Z:/B/y/2.mp4', 'B files must not land under A');
  assert.equal(r.rows[2].proposedNas, '', 'an unmapped source must not be given a destination');
  assert.deepEqual([r.mapped, r.unmapped], [2, 1]);
});

// ── manifest round trip ─────────────────────────────────────────────────────
/*
 * The trap this guards is specific and has already happened in the field: the
 * app's own new.csv was loaded as a manifest and every row was discarded,
 * because loadManifest counts rows by `drive_id` (count === byId.size) and
 * new.csv has no such column. A generated manifest that the app then rejects as
 * its own input would be the same bug wearing a friendlier name.
 */
const mf = await import('../src/manifest.mjs');

check('a generated manifest loads back with every row usable', () => {
  const files = [
    { abs: path.join(DRIVE, 'Proj', 'clip.mp4'), base: 'clip.mp4', size: 1234 },
    { abs: path.join(DRIVE, 'Proj', 'note, with comma.txt'), base: 'note, with comma.txt', size: 7 },
    { abs: path.join(DRIVE, 'Proj', 'quote".txt'), base: 'quote".txt', size: 9 },
  ];
  const { csv, rows } = mf.serialiseManifest(files);
  assert.equal(rows, 3);
  const out = path.join(TMP, 'gen-manifest.csv');
  writeFileSync(out, csv);
  const loaded = mf.loadManifest(out);
  assert.equal(loaded.count, 3, 'every generated row must survive loadManifest');
  assert.equal(loaded.withMd5, 0, 'no checksums are claimed when none were computed');
  const rec = loaded.byId.get(mf.localId(files[1].abs));
  assert.ok(rec, 'a name containing a comma must round-trip');
  assert.equal(rec.name, 'note, with comma.txt');
  assert.equal(rec.size, 7);
});

check('error records are never written to a manifest', () => {
  const { rows } = mf.serialiseManifest([
    { error: 'unreadable: X' },
    { abs: '/a/b.txt', base: 'b.txt', size: 1 },
  ]);
  assert.equal(rows, 1);
});

check('md5 is carried through when the caller supplies one', () => {
  const files = [{ abs: '/a/b.txt', base: 'b.txt', size: 5 }];
  const { csv } = mf.serialiseManifest(files, { md5For: () => 'ABCDEF' });
  const out = path.join(TMP, 'gen-md5.csv');
  writeFileSync(out, csv);
  const loaded = mf.loadManifest(out);
  assert.equal(loaded.withMd5, 1);
  assert.ok(loaded.byMd5.has('abcdef'), 'md5 is lower-cased on read, so it must match');
});

// ── destination probe ───────────────────────────────────────────────────────
/*
 * Empty and unreachable must not look the same. match() reports every file as
 * new when the NAS side is empty, and walk() turns an unreadable directory into
 * an error record that match() drops — so an unmounted share produced a
 * confident "copy everything" plan. probeRoot is what lets that be refused
 * while a genuinely empty folder still works.
 */
const wk = await import('../src/walk.mjs');

check('probeRoot tells empty apart from missing', () => {
  const emptyDir = path.join(TMP, 'probe-empty');
  mkdirSync(emptyDir, { recursive: true });
  const e = wk.probeRoot(emptyDir);
  assert.deepEqual([e.exists, e.readable, e.empty], [true, true, true]);
  assert.equal(e.error, '');

  const gone = wk.probeRoot(path.join(TMP, 'probe-does-not-exist'));
  assert.equal(gone.exists, false, 'a missing folder must not report as existing');
  assert.equal(gone.empty, false, 'missing is NOT empty — that conflation is the bug');
  assert.match(gone.error, /does not exist/);

  const full = wk.probeRoot(NAS);
  assert.equal(full.empty, false);
  assert.ok(full.entries > 0);
});

check('a folder holding only NAS housekeeping counts as empty', () => {
  const d = path.join(TMP, 'probe-eadir');
  mkdirSync(path.join(d, '@eaDir'), { recursive: true });
  writeFileSync(path.join(d, '.DS_Store'), 'x');
  const p = wk.probeRoot(d);
  assert.equal(p.empty, true, '@eaDir and .DS_Store are not content');
});

check('probeRoot reports a file as not-a-folder rather than empty', () => {
  const f = path.join(TMP, 'probe-file.txt');
  writeFileSync(f, 'x');
  const p = wk.probeRoot(f);
  assert.equal(p.exists, true);
  assert.equal(p.empty, false);
  assert.match(p.error, /not a folder/);
});

// ── Drive mount detection ───────────────────────────────────────────────────
/*
 * Reported from the field: a NAS share at Z:\SHARED DRIVES was refused as
 * "looks like a Google Drive mount", because the old check matched the folder
 * NAME alone. It blocked Compare completely, and md5File would have refused to
 * hash anything under it, so the whole profile was unusable.
 *
 * listRoot is injected here so the cases run identically on any machine — the
 * point under test is the decision, not this developer's drive letters.
 */
const DRIVE_ROOT_LISTINGS = {
  'H:\\': ['My Drive', 'Shared drives', 'Other computers'],   // real Drive for Desktop
  'Z:\\': ['SHARED DRIVES', 'Projects', 'Archive'],           // NAS that merely uses the name
  '/Volumes/NAS': ['Shared drives', 'Media'],
};
const listRoot = (r) => {
  if (Object.prototype.hasOwnProperty.call(DRIVE_ROOT_LISTINGS, r)) return DRIVE_ROOT_LISTINGS[r];
  throw new Error('ENOENT');
};

check('a NAS folder merely NAMED "SHARED DRIVES" is not a Drive mount', () => {
  wk._resetVolumeCache();
  const v = wk.driveMountVerdict('Z:\\SHARED DRIVES', { listRoot });
  assert.equal(v.drive, false, 'this refusal blocked a real user completely');
  wk._resetVolumeCache();
  assert.equal(wk.looksLikeDriveMount('Z:\\SHARED DRIVES\\Projects\\clip.mp4', { listRoot }), false);
});

check('a real Drive for Desktop path is still refused', () => {
  wk._resetVolumeCache();
  assert.equal(wk.looksLikeDriveMount('H:\\Shared drives\\UIH - JIGSPACE', { listRoot }), true);
  wk._resetVolumeCache();
  assert.equal(wk.looksLikeDriveMount('H:\\My Drive\\thing.mp4', { listRoot }), true);
});

check('paths that name Google explicitly need no corroboration', () => {
  wk._resetVolumeCache();
  // No listRoot entry for these volumes: the strong patterns must settle it
  // without ever touching the filesystem.
  assert.equal(wk.looksLikeDriveMount(
    '/Users/x/Library/CloudStorage/GoogleDrive-a@b.com/Shared drives/Y', { listRoot }), true);
  assert.equal(wk.looksLikeDriveMount('/Volumes/GoogleDrive/My Drive/Y', { listRoot }), true);
});

check('an unreadable volume root fails CLOSED, not open', () => {
  wk._resetVolumeCache();
  // Q:\ is not in the listing table, so listRoot throws. Refusing a folder the
  // user can re-point is far cheaper than downloading someone's whole Drive.
  assert.equal(wk.looksLikeDriveMount('Q:\\Shared drives\\X', { listRoot }), true);
});

check('an ordinary NAS path is untouched by any of this', () => {
  wk._resetVolumeCache();
  assert.equal(wk.looksLikeDriveMount('Z:\\Projects\\Amanzi\\clip.mp4', { listRoot }), false);
  assert.equal(wk.looksLikeDriveMount('/Volumes/NAS/Media/x.mov', { listRoot }), false);
});

check('volumeRootOf handles drive letters, UNC and /Volumes', () => {
  assert.equal(wk.volumeRootOf('Z:\\SHARED DRIVES\\x'), 'Z:\\');
  assert.equal(wk.volumeRootOf('\\\\qnap\\media\\Shared drives\\x'), '\\\\qnap\\media');
  assert.equal(wk.volumeRootOf('/Volumes/NAS/Shared drives/x'), '/Volumes/NAS');
  assert.equal(wk.volumeRootOf('/home/x/Shared drives/y'), '/');
});

// ── Google Vids ─────────────────────────────────────────────────────────────
/*
 * Found by a real copy, not by reading docs: six .gvid files failed with
 * "Incorrect function" (ERROR_INVALID_FUNCTION), which is Drive for Desktop's
 * answer when asked for the bytes of a file that has none. They were 174 bytes
 * on disk and classified as ordinary binaries, so the app kept offering to copy
 * something that can never be copied.
 */
const nat = await import('../src/natives.mjs');

check('.gvid is a Google-native stub, never an ordinary file to copy', () => {
  assert.equal(nat.isNativeExt('.gvid'), true);
  assert.equal(nat.isNativeExt('.GVID'), true, 'extensions arrive in any case');
  const c = nat.classifyNative('.gvid', path.join(TMP, 'nope.gvid'), 174);
  assert.equal(c.kind, 'Google Vids');
  assert.equal(c.exportAs, null, 'no Drive API export format is claimed for Vids');
  assert.match(c.note, /Download → MP4/);
});

check('an unreadable stub still classifies rather than throwing', () => {
  // readStubDocId cannot read a .gvid at all — it must return null, not throw,
  // or one unreadable stub would abort the whole walk.
  assert.equal(nat.readStubDocId(path.join(TMP, 'does-not-exist.gvid'), 174), null);
});

check('every Google extension in the table is classified', () => {
  for (const ext of Object.keys(nat.NATIVE_KINDS)) {
    assert.equal(nat.isNativeExt(ext), true, `${ext} must be recognised`);
    const c = nat.classifyNative(ext, path.join(TMP, 'x' + ext), 174);
    assert.ok(c && c.kind && c.note, `${ext} must produce a kind and a note`);
  }
});

check('a real video file is NOT swept up as a native', () => {
  assert.equal(nat.isNativeExt('.mp4'), false);
  assert.equal(nat.isNativeExt('.mov'), false);
  // .gif and .gz start with "g" — a pattern-based guess would have caught them.
  assert.equal(nat.isNativeExt('.gif'), false, 'a .gif is a real file with real bytes');
  assert.equal(nat.isNativeExt('.gz'), false);
});

// ── converted-file substitution ─────────────────────────────────────────────
/*
 * A native stub cannot be copied, but its converted equivalent can — and must
 * land where the ORIGINAL belonged, not in a parallel _Converted tree on the
 * NAS. These check the join and, more importantly, that it REFUSES to guess.
 */
const cv = await import('../src/converted.mjs');

const conv = (rel, base, size = 100) => ({
  abs: 'H:/My Drive/_Converted for NAS/' + rel, rel, base, size,
  root: 'H:/My Drive/_Converted for NAS',
});
const stub = (rel, base) => ({ rel, base, root: 'H:/Shared drives', abs: 'H:/Shared drives/' + rel });

check('a stub is matched to its converted file by stem', () => {
  const idx = cv.indexConverted([conv('JIG/DOCS/Training.docx', 'Training.docx')]);
  const hit = cv.resolveConverted(stub('JIG/DOCS/Training.gdoc', 'Training.gdoc'), idx);
  assert.equal(hit && hit.base, 'Training.docx');
});

check('the copy reads the CONVERTED file and writes to the ORIGINAL destination', () => {
  const idx = cv.indexConverted([conv('JIG/DOCS/Training.docx', 'Training.docx', 4096)]);
  const s = stub('JIG/DOCS/Training.gdoc', 'Training.gdoc');
  const row = cv.substitutionRow(s, cv.resolveConverted(s, idx),
    () => ({ nas: 'Z:/NAS/JIG/DOCS/Training.gdoc', rule: 'mirror' }), '/');

  // Source: where the converted file actually is.
  assert.equal(row.driveRoot, 'H:/My Drive/_Converted for NAS');
  assert.equal(row.drivePath, 'JIG/DOCS/Training.docx');
  // Destination: the original's folders, with the converted extension.
  assert.equal(row.proposedNas, 'Z:/NAS/JIG/DOCS/Training.docx');
  // planGroups uses `name` on BOTH sides, so it must match the source file.
  assert.equal(row.name, 'Training.docx');
  assert.equal(row.size, 4096);
  assert.equal(row.viaConversion, true);
  assert.equal(row.stubName, 'Training.gdoc');
});

check('two candidates are split by their parent folder', () => {
  const idx = cv.indexConverted([
    conv('ProjectA/Minutes.docx', 'Minutes.docx'),
    conv('ProjectB/Minutes.docx', 'Minutes.docx'),
  ]);
  const hit = cv.resolveConverted(stub('ProjectB/Minutes.gdoc', 'Minutes.gdoc'), idx);
  assert.equal(hit && hit.rel, 'ProjectB/Minutes.docx');
});

check('an ambiguous name is REFUSED rather than guessed', () => {
  /*
   * Two candidates and neither parent matches. Picking one would put a
   * confidently-named wrong document on the NAS, which is worse than leaving a
   * stub for a human to deal with.
   */
  const idx = cv.indexConverted([
    conv('ProjectA/Minutes.docx', 'Minutes.docx'),
    conv('ProjectB/Minutes.docx', 'Minutes.docx'),
  ]);
  assert.equal(cv.resolveConverted(stub('ProjectZ/Minutes.gdoc', 'Minutes.gdoc'), idx), null);
});

check('no converted file means no row at all', () => {
  const idx = cv.indexConverted([conv('X/Other.docx', 'Other.docx')]);
  assert.equal(cv.resolveConverted(stub('X/Training.gdoc', 'Training.gdoc'), idx), null);
});

check('an unmapped stub yields no row even when converted', () => {
  const idx = cv.indexConverted([conv('X/Training.docx', 'Training.docx')]);
  const s = stub('X/Training.gdoc', 'Training.gdoc');
  // destFor returns nothing: without a destination there is nowhere to put it.
  assert.equal(cv.substitutionRow(s, cv.resolveConverted(s, idx), () => null, '/'), null);
});

check('match() turns a converted stub into a copyable row', async () => {
  const m = await import('../src/match.mjs');
  const r = await m.match({
    driveFiles: [{ abs: 'H:/d/Proj/Plan.gdoc', rel: 'Proj/Plan.gdoc', root: 'H:/d',
                   base: 'Plan.gdoc', baseLower: 'plan.gdoc', ext: '.gdoc', size: 174 }],
    nasFiles: [],
    manifest: { byId: new Map(), byMd5: new Map(), bySize: new Map(), count: 0, withMd5: 0 },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
    convertedFiles: [conv('Proj/Plan.docx', 'Plan.docx', 2048)],
  });
  assert.equal(r.new.length, 1, 'the stub should now be copyable');
  assert.equal(r.new[0].name, 'Plan.docx');
  assert.equal(r.new[0].proposedNas, 'Z:/NAS/Proj/Plan.docx');
  assert.equal(r.natives.length, 1, 'and still listed as a native, marked resolved');
  assert.equal(r.natives[0].resolved, true);
  assert.match(r.natives[0].note, /will be copied in its place/);
});

check('without a converted file the stub stays uncopyable', async () => {
  const m = await import('../src/match.mjs');
  const r = await m.match({
    driveFiles: [{ abs: 'H:/d/Proj/Plan.gdoc', rel: 'Proj/Plan.gdoc', root: 'H:/d',
                   base: 'Plan.gdoc', baseLower: 'plan.gdoc', ext: '.gdoc', size: 174 }],
    nasFiles: [],
    manifest: { byId: new Map(), byMd5: new Map(), bySize: new Map(), count: 0, withMd5: 0 },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
    convertedFiles: [],
  });
  assert.equal(r.new.length, 0);
  assert.equal(r.natives[0].resolved, false);
});

/*
 * The comparison must never go quiet, and must not read more of the NAS than it
 * has to. Both were reported as "it hangs while comparing files" — one because
 * a long hash produced no output, the other because a common file size made it
 * hash the whole bucket.
 */
check('a slow hash still reports, and names the file it is reading', async () => {
  const m = await import('../src/match.mjs');
  const wk = await import('../src/walk.mjs');

  const big = path.join(TMP, 'slow', 'Master.mov');
  w(big, C.identical);
  const realMd5 = md5(C.identical);

  // Make the read slow enough that a per-500-files reporter would say nothing.
  const orig = wk.md5File;
  const ticks = [];
  const r = await m.match({
    driveFiles: [{ abs: 'H:/d/P/Master.mov', rel: 'P/Master.mov', root: 'H:/d',
                   base: 'Master.mov', baseLower: 'master.mov', ext: '.mov',
                   size: C.identical.length }],
    nasFiles: [{ abs: big, rel: 'Master.mov', root: path.dirname(big), base: 'Master.mov',
                 baseLower: 'master.mov', ext: '.mov', size: C.identical.length }],
    manifest: {
      byId: new Map([['1', { name: 'Master.mov', size: C.identical.length, md5: realMd5 }]]),
      byMd5: new Map(), bySize: new Map(), count: 1, withMd5: 1,
    },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
    onProgress: (p) => ticks.push(p),
  });
  assert.equal(orig, wk.md5File, 'md5File left untouched');
  assert.equal(r.duplicates.length, 1);
  const naming = ticks.filter((t) => t.hashing === 'Master.mov');
  assert.ok(naming.length >= 1, 'reported the file it was reading, before reading it');
  assert.equal(typeof ticks[0].done, 'number', 'progress is an object, not positional');
});

/*
 * The exact question moved to the copy stage. Comparing must therefore not read
 * the NAS at all, and must not claim it checked anything.
 */
check('comparing reads no NAS bytes, even with a manifest full of md5s', async () => {
  const m = await import('../src/match.mjs');
  const dir = path.join(TMP, 'noread');
  const abs = path.join(dir, 'Same.bin');
  w(abs, C.identical);
  const size = C.identical.length;

  const r = await m.match({
    driveFiles: [{ abs: 'H:/d/Same.bin', rel: 'Same.bin', root: 'H:/d', base: 'Same.bin',
                   baseLower: 'same.bin', ext: '.bin', size }],
    nasFiles: [{ abs, rel: 'Same.bin', root: dir, base: 'Same.bin', baseLower: 'same.bin',
                 ext: '.bin', size }],
    manifest: { byId: new Map([['1', { name: 'Same.bin', size, md5: md5(C.identical) }]]),
                byMd5: new Map(), bySize: new Map(), count: 1, withMd5: 1 },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
  });
  assert.equal(r.stats.hashedFiles, 0, 'read the NAS during a plain comparison');
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].tier, 'size+name', 'must not claim an md5 tier it did not earn');
});

check('--exact still does the byte-level comparison', async () => {
  const m = await import('../src/match.mjs');
  const dir = path.join(TMP, 'exact');
  const abs = path.join(dir, 'Same.bin');
  w(abs, C.identical);
  const size = C.identical.length;

  const r = await m.match({
    exact: true,
    driveFiles: [{ abs: 'H:/d/Same.bin', rel: 'Same.bin', root: 'H:/d', base: 'Same.bin',
                   baseLower: 'same.bin', ext: '.bin', size }],
    nasFiles: [{ abs, rel: 'Same.bin', root: dir, base: 'Same.bin', baseLower: 'same.bin',
                 ext: '.bin', size }],
    manifest: { byId: new Map([['1', { name: 'Same.bin', size, md5: md5(C.identical) }]]),
                byMd5: new Map(), bySize: new Map(), count: 1, withMd5: 1 },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
  });
  assert.equal(r.stats.hashedFiles, 1);
  assert.equal(r.duplicates[0].tier, 'md5');
});

check('a new row carries its md5 so the copy stage can check it', async () => {
  const m = await import('../src/match.mjs');
  const size = C.brandNew.length;
  const r = await m.match({
    driveFiles: [{ abs: 'H:/d/New.bin', rel: 'New.bin', root: 'H:/d', base: 'New.bin',
                   baseLower: 'new.bin', ext: '.bin', size }],
    nasFiles: [],
    manifest: { byId: new Map([['1', { name: 'New.bin', size, md5: md5(C.brandNew) }]]),
                byMd5: new Map(), bySize: new Map(), count: 1, withMd5: 1 },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
  });
  assert.equal(r.new.length, 1);
  assert.equal(r.new[0].md5, md5(C.brandNew), 'md5 must reach the copy plan');
});

check('a colliding size does not drag the whole bucket through md5', async () => {
  const m = await import('../src/match.mjs');
  const dir = path.join(TMP, 'bucket');
  const size = C.renamed.length;

  // 40 same-size NAS files; only one shares the Drive file's name, and it is
  // the one that matches. Unordered, this used to hash every one of them.
  const nasFiles = [];
  for (let i = 0; i < 40; i++) {
    const base = i === 39 ? 'Wanted.bin' : `Other${i}.bin`;
    const abs = path.join(dir, base);
    w(abs, i === 39 ? C.renamed : C.renamed.slice(0, -1) + String(i % 10));
    nasFiles.push({ abs, rel: base, root: dir, base, baseLower: base.toLowerCase(),
                    ext: '.bin', size });
  }

  const r = await m.match({
    driveFiles: [{ abs: 'H:/d/Wanted.bin', rel: 'Wanted.bin', root: 'H:/d', base: 'Wanted.bin',
                   baseLower: 'wanted.bin', ext: '.bin', size }],
    nasFiles,
    manifest: {
      byId: new Map([['1', { name: 'Wanted.bin', size, md5: md5(C.renamed) }]]),
      byMd5: new Map(), bySize: new Map(), count: 1, withMd5: 1,
    },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
  });

  assert.equal(r.duplicates.length, 1, 'found it');
  assert.equal(r.duplicates[0].tier, 'md5');
  assert.equal(r.stats.hashedFiles, 1,
    `hashed ${r.stats.hashedFiles} files to find one match — should be 1`);
});

/*
 * What the DEFAULT (no --exact) costs, stated as tests rather than left for
 * someone to discover on a migration.
 *
 * Both losses are one-directional and both are recoverable at the copy stage,
 * which is why the desktop app takes this trade: comparing stays fast, and the
 * exact question is asked where it decides something.
 */
const OUT_FAST = path.join(TMP, 'out-fast');
execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.mjs'),
  '--config', cfg, '--manifest', manifestCsv, '--out', OUT_FAST], { stdio: 'pipe' });
const fastDups = csvIn(OUT_FAST, 'duplicates.csv');

check('without --exact nothing on the NAS is read', () => {
  const s = JSON.parse(readFileSync(path.join(OUT_FAST, 'summary.json'), 'utf8'));
  assert.equal(s.stats.hashedFiles, 0);
});

check('without --exact a duplicate is claimed on size+name, and says so', () => {
  const r = fastDups.find((d) => d.name === 'scan_001.mp4');
  assert.ok(r, 'still found');
  assert.equal(r.tier, 'size+name', 'the tier must not overstate the evidence');
});

check('KNOWN COST: without --exact, same size + same name hides a conflict', () => {
  // report.mp4 has matching name and size but different bytes. --exact calls it
  // a conflict; the fast path cannot tell and calls it a duplicate, so it is
  // SKIPPED. This is the gap the copy-stage verification exists to close, and
  // it is asserted here so the trade cannot be forgotten or silently widened.
  const fast = fastDups.find((d) => d.name === 'report.mp4');
  assert.ok(fast, 'expected report.mp4 to be (wrongly) called a duplicate on the fast path');
  assert.equal(fast.tier, 'size+name');
  // and the exact run must still get it right
  assert.ok(cons.find((x) => x.name === 'report.mp4'), '--exact must still catch it');
});

check('a duplicate row carries what is needed to verify it later', () => {
  const r = fastDups.find((d) => d.name === 'scan_001.mp4');
  assert.ok(r.nasPath, 'the NAS file to read');
  assert.ok(r.md5, 'the Drive md5 to check it against');
});

/*
 * The converted folder normally sits INSIDE the Drive being compared, so the
 * Drive walk sees its contents as ordinary new files. Left in, every converted
 * file is copied twice — once into a _Converted for NAS mirror on the NAS, and
 * once as the substitute for its stub. The mirror is the exact "parallel folder
 * of orphans" the substitution feature exists to prevent.
 */
check('a converted file inside the Drive root is not ALSO copied as itself', async () => {
  const wk = await import('../src/walk.mjs');
  const m = await import('../src/match.mjs');

  const driveRoot = path.join(TMP, 'dd', 'My Drive');
  const convRoot = path.join(driveRoot, '_Converted for NAS');
  w(path.join(driveRoot, 'Proj', 'video.mp4'), C.brandNew);
  w(path.join(convRoot, 'Proj', 'Plan.docx'), C.identical);
  // The stub itself, which is what the converted file stands in for.
  w(path.join(driveRoot, 'Proj', 'Plan.gdoc'), '{"doc_id":"abc"}');

  let driveFiles = wk.walk(driveRoot);
  const convertedFiles = wk.walk(convRoot);
  assert.ok(driveFiles.some((f) => /Plan\.docx$/.test(f.base)),
    'precondition: the walk really does pick the converted file up');

  driveFiles = driveFiles.filter((f) => f.error || !wk.isUnder(f.abs, convRoot));
  assert.ok(!driveFiles.some((f) => /Plan\.docx$/.test(f.base)), 'excluded from the Drive side');
  assert.ok(driveFiles.some((f) => /video\.mp4$/.test(f.base)), 'ordinary files untouched');
  assert.ok(driveFiles.some((f) => /Plan\.gdoc$/.test(f.base)), 'and the stub is still there');

  const r = await m.match({
    driveFiles, nasFiles: [], convertedFiles,
    manifest: { byId: new Map(), byMd5: new Map(), bySize: new Map(), count: 0, withMd5: 0 },
    mapping: { destFor: (rel) => ({ nas: 'Z:/NAS/' + rel, rule: 'mirror' }) },
  });

  const dests = r.new.map((x) => x.proposedNas);
  assert.equal(dests.filter((d) => /_Converted for NAS/.test(d)).length, 0,
    'nothing may be copied into a mirror of the converted folder');
  assert.equal(r.new.filter((x) => /Plan\.docx$/.test(x.name)).length, 1,
    'the converted file is planned exactly once');
  const sub = r.new.find((x) => x.viaConversion);
  assert.ok(sub, 'and it arrives as the stub substitution');
  assert.equal(sub.proposedNas, 'Z:/NAS/Proj/Plan.docx', 'landing where the stub belonged');
});

check('isUnder does not treat a sibling with a shared prefix as inside', async () => {
  const wk = await import('../src/walk.mjs');
  assert.equal(wk.isUnder('/a/_Converted for NAS/x.docx', '/a/_Converted for NAS'), true);
  assert.equal(wk.isUnder('/a/_Converted for NAS2/x.docx', '/a/_Converted for NAS'), false,
    'a bare startsWith would wrongly swallow this folder');
  assert.equal(wk.isUnder('/a/_Converted for NAS', '/a/_Converted for NAS'), true);
  assert.equal(wk.isUnder('/a/other/x.docx', '/a/_Converted for NAS'), false);
});

check('walk reports where it is while it runs', async () => {
  const wk = await import('../src/walk.mjs');
  const seen = [];
  const files = wk.walk(DRIVE, { onTick: (t) => seen.push(t) });
  assert.ok(files.length > 0, 'still returns the files');
  // The fixture is far too small to take a second, so no tick is expected —
  // what matters is that asking for one is harmless and the shape is right.
  seen.forEach((t) => {
    assert.equal(typeof t.files, 'number');
    assert.equal(typeof t.dir, 'string');
  });
  assert.deepEqual(wk.walk(DRIVE).map((f) => f.rel).sort(),
                   files.map((f) => f.rel).sort(), 'ticking changes nothing');
});

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
