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
    // Replace rows never do: rsync runs with --ignore-existing, which would drop
    // them just as silently as /XO does.
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

    let verdict = IS_WIN ? src.classifyRobocopy(code) : src.classifyRsync(code);

    /**
     * Copy one file with Node, no engine involved.
     * `overwrite` is only ever true for a row the user explicitly marked Replace.
     */
    const directCopy = async (name, overwrite, why) => {
      const from = path.join(g.srcDir, name);
      const to = path.join(g.dstDir, name);
      if (opts.dryRun) {
        emit({ type: 'log', line: `would copy (${why}): ${name}` });
        return null;
      }
      try {
        await fsp.mkdir(g.dstDir, { recursive: true });
        await fsp.copyFile(from, to, overwrite ? 0 : fsConstants.COPYFILE_EXCL);
        emit({ type: 'log', line: `${overwrite ? 'REPLACED' : 'copied'} (${why}): ${name}` });
        return null;
      } catch (e) {
        if (!overwrite && e && e.code === 'EEXIST') {
          emit({ type: 'log', line: `already there, left alone: ${name}` });
          return null;
        }
        emit({ type: 'log', line: `FAILED (${why}): ${name} — ${e.code || e.message}` });
        return `${name} — ${e.code || e.message}`;
      }
    };

    const directFailed = [];
    const push = (r) => { if (r) directFailed.push(r); };

    /*
     * A usage error means robocopy parsed nothing and copied nothing, so the
     * whole group can be redone directly with no risk of doubling up. This is
     * the general answer to awkward file names: rather than maintaining a list
     * of characters robocopy dislikes and hoping it is complete, notice that it
     * refused the command and route around it. Whatever the name was, it works.
     */
    if (IS_WIN && code === 16 && g.files.length) {
      emit({ type: 'log', line:
        `robocopy refused this folder (exit 16 — usually a file name it reads as a switch). ` +
        `Copying its ${g.files.length} file(s) directly instead.` });
      for (const name of g.files) {
        if (current.cancelled) break;
        push(await directCopy(name, false, 'fallback'));
      }
      // The engine's verdict no longer describes what happened here.
      verdict = { ok: true, code, summary: `copied directly (robocopy refused the command line)` };
    }

    // Names robocopy will not accept as arguments. Never overwritten.
    for (const name of (IS_WIN ? (g.literal || []) : [])) {
      if (current.cancelled) break;
      push(await directCopy(name, false, 'name starts with "-"'));
    }

    // Explicit per-file Replace. The only path in this app that overwrites.
    for (const name of (g.replace || [])) {
      if (current.cancelled) break;
      push(await directCopy(name, true, 'you chose Replace'));
    }

    if (directFailed.length) {
      verdict = {
        ...verdict,
        ok: false,
        summary: `${verdict.summary}; ${directFailed.length} file(s) could not be copied directly`,
      };
    }

    if (verdict.ok && !opts.dryRun) copiedBytes += g.bytes;
    const fileCount = g.files.length + (g.literal || []).length + (g.replace || []).length;
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
