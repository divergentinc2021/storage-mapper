/**
 * The copy runner.
 *
 * Spawns robocopy (Windows) or rsync (elsewhere) directly with an argv array —
 * NO shell. That is not a style preference: the real destinations include
 * "Preclinical Dental Education VR & Haptics", and `&` is a command separator in
 * cmd.exe and a special character in PowerShell. With no shell in the pipeline
 * there is nothing to quote and nothing to get wrong.
 *
 * Groups run one at a time. Parallel jobs over one SMB share contend for the
 * same link and finish no sooner, while making the log unreadable and a partial
 * failure much harder to attribute.
 *
 * Nothing here can delete: /MIR, /PURGE and /MOV are never emitted, and rsync is
 * called without --delete.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');

const IS_WIN = process.platform === 'win32';

let current = null;   // { child, cancelled }

function isBusy() { return !!current; }

function cancel() {
  if (current && current.child) {
    current.cancelled = true;
    try { current.child.kill(); } catch { /* already gone */ }
  }
}

/**
 * @param {object} opts {rows, dryRun, threads, logFile}
 * @param {(evt:object)=>void} emit progress/log/result events
 */
async function run(opts, emit) {
  if (isBusy()) return { ok: false, error: 'a copy is already running' };

  const src = await import('../src/robocopy.mjs');
  const { isAbsoluteDest } = await import('../src/report.mjs');
  const sep = IS_WIN ? '\\' : '/';
  const { groups, skipped } = src.planGroups(opts.rows || [], isAbsoluteDest, sep);

  const logFile = opts.logFile ||
    path.join(os.tmpdir(), `storage-mapper-copy-${Date.now()}.log`);

  const results = [];
  let copiedBytes = 0;

  current = { child: null, cancelled: false };

  for (let i = 0; i < groups.length; i++) {
    if (current.cancelled) break;
    const g = groups[i];
    emit({
      type: 'group-start', index: i, total: groups.length,
      srcDir: g.srcDir, dstDir: g.dstDir, files: g.files.length, bytes: g.bytes,
    });

    const bin = IS_WIN ? 'robocopy' : 'rsync';
    const args = IS_WIN
      ? src.robocopyArgs({ ...g, dryRun: opts.dryRun, threads: opts.threads ?? 8, logFile })
      : src.rsyncArgs({ ...g, dryRun: opts.dryRun });

    /*
     * A folder can be nothing but leading-hyphen names. Spawning robocopy with
     * no files would copy the WHOLE directory, which is the one thing a planned
     * copy must never do.
     */
    // On non-Windows the literal names go through rsync like everything else.
    const engineFiles = IS_WIN ? g.files.length : g.files.length + (g.literal || []).length;
    const code = engineFiles === 0 ? 0 : await new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, { windowsHide: true });
      } catch (e) {
        emit({ type: 'log', line: `could not start ${bin}: ${e.message}` });
        return resolve(IS_WIN ? 16 : 1);
      }
      current.child = child;
      const onData = (b) => {
        String(b).split(/\r?\n/).forEach((line) => {
          if (line.trim()) emit({ type: 'log', line: line.trim() });
        });
      };
      child.stdout && child.stdout.on('data', onData);
      child.stderr && child.stderr.on('data', onData);
      child.on('error', (e) => {
        emit({ type: 'log', line: `${bin}: ${e.message}` });
        resolve(IS_WIN ? 16 : 1);
      });
      child.on('close', (c) => resolve(c === null ? (IS_WIN ? 16 : 1) : c));
    });
    current.child = null;

    const verdict = IS_WIN ? src.classifyRobocopy(code) : src.classifyRsync(code);

    /*
     * The names robocopy refuses to be given, copied one at a time. Never
     * overwrites — matching /XO's promise the conservative way, since we cannot
     * hand these to the engine that implements it.
     */
    const literalFailed = [];
    for (const name of (IS_WIN ? (g.literal || []) : [])) {
      if (current.cancelled) break;
      const from = path.join(g.srcDir, name);
      const to = path.join(g.dstDir, name);
      try {
        if (opts.dryRun) {
          emit({ type: 'log', line: `would copy (direct): ${name}` });
          continue;
        }
        await fsp.mkdir(g.dstDir, { recursive: true });
        // COPYFILE_EXCL: fails if the destination exists, so nothing is replaced.
        await fsp.copyFile(from, to, fsConstants.COPYFILE_EXCL);
        emit({ type: 'log', line: `copied (direct, name starts with "-"): ${name}` });
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          emit({ type: 'log', line: `already there, left alone: ${name}` });
          continue;
        }
        literalFailed.push(`${name} — ${e.code || e.message}`);
        emit({ type: 'log', line: `FAILED (direct): ${name} — ${e.code || e.message}` });
      }
    }
    if (literalFailed.length) {
      verdict.ok = false;
      verdict.summary = `${verdict.summary}; ${literalFailed.length} file(s) whose name ` +
        `starts with "-" could not be copied directly`;
    }

    if (verdict.ok && !opts.dryRun) copiedBytes += g.bytes;
    const fileCount = g.files.length + (g.literal || []).length;
    results.push({ ...verdict, srcDir: g.srcDir, dstDir: g.dstDir, files: fileCount, bytes: g.bytes });
    emit({ type: 'group-done', index: i, total: groups.length, verdict });
  }

  const cancelled = current.cancelled;
  current = null;

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0 && !cancelled,
    cancelled,
    dryRun: !!opts.dryRun,
    groups: results.length,
    totalGroups: groups.length,
    failed: failed.length,
    copiedBytes,
    skipped: skipped.map((s) => ({ path: s.row.drivePath, why: s.why })),
    results,
    logFile: IS_WIN ? logFile : null,
    engine: bin(),
  };
}

function bin() { return IS_WIN ? 'robocopy' : 'rsync'; }

module.exports = { run, cancel, isBusy, engine: bin, IS_WIN };
