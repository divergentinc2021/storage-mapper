/**
 * Copy-engine plumbing: argument building and, above all, result classification.
 *
 * ROBOCOPY'S EXIT CODES ARE A BITMASK AND NON-ZERO IS NOT AN ERROR.
 * This is the single most-misread thing about robocopy, and getting it wrong
 * would make the app report a perfectly good copy as failed (exit 1 = "files
 * were copied", the normal success case) or, worse, a partial failure as fine.
 *
 *   bit 0 (1)  files were copied
 *   bit 1 (2)  extra files/dirs found in the destination
 *   bit 2 (4)  mismatched files/dirs
 *   bit 3 (8)  SOME FILES COULD NOT BE COPIED  <- failure
 *   bit 4 (16) serious error, nothing copied   <- failure
 *
 * So 0..7 is success and >= 8 is failure.
 *
 * Kept in src/ (not electron/) so it is plain testable Node with no Electron.
 */

export const ROBOCOPY_BITS = [
  [1, 'files copied'],
  [2, 'extra files or folders in the destination'],
  [4, 'mismatched files or folders'],
  [8, 'some files could not be copied'],
  [16, 'serious error — nothing was copied'],
];

export function classifyRobocopy(code) {
  const c = Number(code);
  if (!Number.isFinite(c) || c < 0) {
    return { ok: false, code: c, summary: 'robocopy did not return an exit code', bits: [] };
  }
  const bits = ROBOCOPY_BITS.filter(([b]) => (c & b) === b).map(([, label]) => label);
  // >= 8 sets bit 3 or bit 4: a real failure. Everything below is success.
  const ok = c < 8;
  let summary;
  if (c === 0) summary = 'nothing to copy — the destination was already up to date';
  else if (ok) summary = 'copied successfully';
  else if (c >= 16) summary = 'FAILED — serious error, nothing was copied';
  else summary = 'FAILED — some files could not be copied';
  return { ok, code: c, summary, bits };
}

/** rsync is a normal process: 0 is success, everything else is not. */
export function classifyRsync(code) {
  const c = Number(code);
  return {
    ok: c === 0, code: c, bits: [],
    summary: c === 0 ? 'copied successfully' : `FAILED — rsync exited ${c}`,
  };
}

/**
 * Arguments for one directory group. No shell is involved anywhere: these go
 * straight to spawn() as argv, so a folder called "VR & Haptics" needs no
 * quoting and cannot be split on the ampersand.
 *
 * Deliberately absent: /MIR, /PURGE, /MOV, /MOVE — every one of those can delete
 * from the destination. This tool must only ever add.
 */
export function robocopyArgs({ srcDir, dstDir, files, dryRun, threads = 8, logFile }) {
  const args = [srcDir, dstDir, ...files];
  args.push('/XO');            // never overwrite a newer file already on the NAS
  args.push('/R:2', '/W:5');   // 2 retries, 5s apart — do not hang on a dropped share
  args.push('/NP');            // no per-file percentage spam
  args.push('/NDL');           // no directory listing
  if (threads > 1) args.push(`/MT:${threads}`);
  if (dryRun) args.push('/L'); // list only: touches nothing
  if (logFile) args.push(`/LOG+:${logFile}`, '/TEE');
  return args;
}

export function rsyncArgs({ srcDir, dstDir, files, literal = [], dryRun }) {
  const args = ['-a', '--ignore-existing'];
  if (dryRun) args.push('--dry-run');
  args.push('--out-format=%n');
  /*
   * literal is folded back in here. The split exists only because robocopy
   * takes bare file names; rsync is given a full path, so "…/-X wing.png"
   * begins with the source directory and is never mistaken for a switch.
   */
  for (const f of [...files, ...literal]) args.push(`${srcDir}/${f}`);
  args.push(`${dstDir}/`);
  return args;
}

/**
 * Group the approved rows into one command per source/destination directory
 * pair. Only rows that are safe to act on survive; everything else is returned
 * with a reason so the UI can say why rather than silently dropping it.
 */
/**
 * A name robocopy will not accept as a file argument.
 *
 * robocopy parses any argument beginning with "-" as a switch, and rejects the
 * whole command:
 *
 *     ERROR : Invalid Parameter #3 : "-X wing_Normal_v003.png"
 *
 * It exits 16 having copied NOTHING, so one such file takes its entire folder
 * down with it — 47 files reported as failed because 12 of them began with a
 * hyphen. There is no escaping form that fixes it: ".\name" and "/IF name" are
 * rejected the same way, and the wildcard forms that ARE accepted ("*name",
 * "?ame") can match neighbouring files, which would put something on the NAS
 * that the plan never listed. These are copied directly instead.
 */
export function needsLiteralCopy(name) {
  return String(name).startsWith('-');
}

export function planGroups(rows, isAbsoluteDest, sep) {
  const groups = new Map();
  const skipped = [];
  const dirname = (p) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i <= 0 ? p : p.slice(0, i);
  };
  for (const r of rows) {
    if (!r.proposedNas) { skipped.push({ row: r, why: 'no mapping rule' }); continue; }
    if (!isAbsoluteDest(r.proposedNas)) { skipped.push({ row: r, why: 'destination is not an absolute path' }); continue; }
    if (!r.driveRoot) { skipped.push({ row: r, why: 'source root unknown' }); continue; }
    const srcDir = dirname(`${r.driveRoot}${sep}${r.drivePath.split('/').join(sep)}`);
    const dstDir = dirname(r.proposedNas.split('/').join(sep));
    const key = `${srcDir}|${dstDir}`;
    if (!groups.has(key)) groups.set(key, { srcDir, dstDir, files: [], literal: [], bytes: 0 });
    const g = groups.get(key);
    // Kept out of the argv entirely rather than escaped — see needsLiteralCopy.
    if (needsLiteralCopy(r.name)) g.literal.push(r.name);
    else g.files.push(r.name);
    g.bytes += Number(r.size) || 0;
  }
  return { groups: [...groups.values()], skipped };
}
