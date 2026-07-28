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

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
