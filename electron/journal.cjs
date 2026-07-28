/**
 * Run journal — an append-only record of every copy.
 *
 * This is the answer to "can we track back", and deliberately NOT a
 * version-control system. Git stores whole blobs; these are multi-gigabyte video
 * files, and putting them under git (or LFS, or annex) would cost more storage
 * and operational pain than the problem is worth. The NAS already has the right
 * mechanism for point-in-time rollback: QNAP volume snapshots, which are
 * block-level, instant and already have 1.1 TB reserved on this box.
 *
 * What a journal adds that snapshots do not: WHICH files a particular run put
 * there, who ran it, from which machine, and what the engine said about each
 * folder. That is what makes a reversal precise instead of a guess — and because
 * the copy is additive-only, "undo" is exactly "remove the files this run added".
 *
 * JSON Lines: appending cannot corrupt earlier entries, and a partial write only
 * ever costs the last line.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function file(app) {
  return path.join(app.getPath('userData'), 'runs.jsonl');
}

/**
 * @param {object} run  the result returned by copy.run
 * @param {Array} rows  the rows that were actually selected
 */
function append(app, run, rows, extra) {
  const entry = {
    at: new Date().toISOString(),
    by: `${os.userInfo().username}@${os.hostname()}`,
    engine: run.engine,
    dryRun: !!run.dryRun,
    ok: !!run.ok,
    cancelled: !!run.cancelled,
    groups: run.groups,
    failed: run.failed,
    bytes: run.copiedBytes,
    logFile: run.logFile || null,
    verdicts: (run.results || []).map((r) => ({
      dstDir: r.dstDir, files: r.files, ok: r.ok, code: r.code, summary: r.summary,
    })),
    // The file list is the point: it is what a reversal would have to remove.
    files: (rows || []).map((r) => ({
      from: r.drivePath, to: r.proposedNas, bytes: r.size, state: r.state || 'new',
    })),
    ...(extra || {}),
  };
  try {
    fs.appendFileSync(file(app), JSON.stringify(entry) + '\n');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, at: entry.at };
}

function read(app, limit) {
  let raw = '';
  try { raw = fs.readFileSync(file(app), 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const l of lines.slice(-(limit || 50))) {
    try { out.push(JSON.parse(l)); } catch { /* skip a torn last line */ }
  }
  return out.reverse();
}

/**
 * The precise list a reversal would act on: files this run actually added.
 * Returned as data for a human to act on — nothing here deletes anything.
 */
function reversalList(entry) {
  if (!entry || entry.dryRun || !entry.ok) return [];
  return (entry.files || []).filter((f) => f.state === 'new').map((f) => f.to);
}

module.exports = { append, read, reversalList, file };
