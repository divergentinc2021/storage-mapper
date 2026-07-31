/**
 * The comparison runs here, in a forked child, so a multi-minute walk over a
 * NAS share cannot freeze the window. Progress is streamed back over IPC.
 *
 * It imports the same src/ modules the CLI uses — there is no second copy of the
 * matching logic to drift out of sync with the tested one.
 */
import { walk, driveMountVerdict, dedupeRoots, probeRoot } from '../src/walk.mjs';
import { loadManifest, emptyManifest } from '../src/manifest.mjs';
import { loadMapping } from '../src/mapping.mjs';
import { match, nasInternalOverlap } from '../src/match.mjs';
import { isNativeExt, classifyNative } from '../src/natives.mjs';
import { crossOverlap } from '../src/mapplan.mjs';
import { fmtBytes } from '../src/report.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const send = (m) => process.send && process.send(m);

/*
 * Scan — the Drive side on its own, no NAS, no matching.
 *
 * For a destination that does not exist yet, a comparison has nothing to
 * compare against: match() would walk an empty tree and report every file as
 * new, which is the same answer this reaches without pretending a comparison
 * happened. Saying so plainly is what lets Map open before any NAS folder has
 * been chosen, and what makes a drive manifest available on first load.
 *
 * The shape it returns is deliberately the same `result` shape match() produces,
 * so every renderer path — counts, tabs, Map, export — reads one structure and
 * needs no "was this a scan or a compare" branch.
 */
async function runScan(msg, send) {
  const dd = dedupeRoots(msg.driveRoots || []);
  const driveRoots = dd.roots;

  const probes = driveRoots.map(probeRoot);
  const bad = probes.filter((p) => !p.exists || !p.readable);
  if (bad.length === probes.length && probes.length) {
    throw new Error(
      'Nothing to scan:\n\n' +
      bad.map((p) => `  • ${p.root} — ${p.error || 'unreadable'}`).join('\n') +
      '\n\nCheck the folder still exists and the drive is connected.'
    );
  }

  send({ type: 'progress', phase: 'drive', text: 'Indexing Google Drive (metadata only)…' });
  const driveFiles = [];
  for (const r of driveRoots) {
    const f = walk(r);
    driveFiles.push(...f);
    send({ type: 'progress', phase: 'drive', text: `${r} — ${f.length} entries` });
  }

  // Mapping rules still apply, so Map opens with the same suggested
  // destinations a comparison would have produced.
  const tmp = mkdtempSync(path.join(tmpdir(), 'storage-mapper-'));
  const cfgPath = path.join(tmp, 'mapping.json');
  writeFileSync(cfgPath, JSON.stringify(msg.mapping || {}));
  const mapping = loadMapping(cfgPath);

  /*
   * Row shapes here are match()'s, field for field — see src/match.mjs. They are
   * duplicated rather than shared because match() cannot produce them without a
   * NAS side, but they must stay identical: the renderer, the copy planner and
   * report.mjs all read these keys, so a rename here breaks three consumers
   * silently. test/run.mjs asserts the two shapes match.
   */
  const errors = [], nu = [], natives = [];
  for (const f of driveFiles) {
    if (f.error) { errors.push(f.error); continue; }
    if (isNativeExt(f.ext)) {
      const n = classifyNative(f.ext, f.abs, f.size);
      natives.push({
        drivePath: f.rel, driveRoot: f.root, name: f.base,
        kind: n.kind, exportAs: n.exportAs || '', docId: n.docId || '', note: n.note,
      });
      continue;
    }
    const dest = mapping.destFor(f.rel);
    nu.push({
      drivePath: f.rel, name: f.base, size: f.size,
      driveRoot: f.root, driveAbs: f.abs,
      proposedNas: dest ? dest.nas : '', mappedBy: dest ? dest.rule : '(unmapped)',
    });
  }

  return {
    type: 'done',
    scanned: true,
    result: {
      duplicates: [], conflicts: [], new: nu, natives, errors,
      stats: {
        driveFiles: driveFiles.length, nasFiles: 0, hashedFiles: 0, hashedBytes: 0,
        manifestRecords: 0, manifestWithMd5: 0,
      },
    },
    overlap: [],
    nasIndex: [],
    droppedRoots: dd.dropped,
    driveProbes: probes,
    nasProbes: (msg.nasRoots || []).map(probeRoot),
    accuracy: 'scan',
    manifestStats: { count: 0, withMd5: 0 },
    driveFiles: driveFiles.filter((f) => !f.error)
      .map((f) => ({ abs: f.abs, base: f.base, size: f.size, ext: f.ext, rel: f.rel, root: f.root })),
  };
}

process.on('message', async (msg) => {
  if (msg.cmd === 'scan') {
    try { send(await runScan(msg, send)); }
    catch (e) { send({ type: 'error', message: e.message }); }
    return;
  }
  if (msg.cmd !== 'compare') return;
  try {
    const raw = msg;
    // Picking a parent and its children walks the children twice and
    // inflates every count, so collapse nested roots before walking.
    const dd = dedupeRoots(raw.driveRoots || []);
    const dn = dedupeRoots(raw.nasRoots || []);
    const driveRoots = dd.roots, nasRoots = dn.roots;
    const droppedRoots = [...dd.dropped, ...dn.dropped];
    const manifestPath = raw.manifestPath, mappingObj = raw.mapping;

    // A folder in BOTH lists compares a tree against itself: everything matches
    // itself and reads as "already on the NAS". Refuse rather than produce a
    // confidently wrong answer.
    const clash = crossOverlap(driveRoots, nasRoots);
    if (clash.length) {
      // The heading must not restate `how`. Two of the three cases are nesting,
      // not equality, and hard-coding "the same folder" here produced the
      // sentence twice in a row for the equality case.
      throw new Error(
        (clash.length === 1
          ? 'A folder appears on both sides:'
          : `${clash.length} folders appear on both sides:`) + '\n\n' +
        clash.map((c) => `  • Google Drive: ${c.drive}\n    NAS:          ${c.nas}\n    ${c.how}`).join('\n\n') +
        '\n\nRemove it from one side. Comparing a folder with itself reports every ' +
        'file as already on the NAS, and mapping it would copy it onto its own source.'
      );
    }

    for (const r of nasRoots) {
      const v = driveMountVerdict(r);
      if (v.drive) {
        throw new Error(
          `"${r}" is a Google Drive mount — ${v.why}. Hashing one would force a full ` +
          `download of every file. Choose it as the Google Drive folder instead.`
        );
      }
    }

    // loadMapping reads a file; write the in-memory table to a temp file so the
    // exact same loader (and its alias-graph logic) is used in both entry points.
    const tmp = mkdtempSync(path.join(tmpdir(), 'storage-mapper-'));
    const cfgPath = path.join(tmp, 'mapping.json');
    writeFileSync(cfgPath, JSON.stringify(mappingObj || {}));
    const mapping = loadMapping(cfgPath);

    /*
     * Probe before walking. walk() turns an unreadable directory into an error
     * record, and match() drops NAS-side errors silently — so an unmounted
     * share, a disconnected drive or a typo produced a clean comparison in
     * which every single file was "new". That is the most dangerous possible
     * output: it reads as success and it proposes copying everything.
     *
     * Genuinely empty is fine and stays fine. Unreachable is refused.
     */
    const nasProbes = nasRoots.map(probeRoot);
    const unreachable = nasProbes.filter((p) => !p.exists || !p.readable);
    if (unreachable.length) {
      throw new Error(
        (unreachable.length === 1 ? 'A NAS folder cannot be read:' : 'NAS folders cannot be read:') +
        '\n\n' + unreachable.map((p) => `  • ${p.root} — ${p.error || 'unreadable'}`).join('\n') +
        '\n\nIf the share is not mounted, every file would be reported as new and ' +
        'the plan would copy your whole Drive. Reconnect it, or remove the folder ' +
        'from the NAS list.'
      );
    }
    const driveProbes = driveRoots.map(probeRoot);

    /*
     * Say where the walk currently is. A root with 200k files took minutes in
     * total silence, which looks the same from outside as a share that has
     * dropped — and is what the idle detector would eventually (wrongly) call
     * a stall.
     */
    const walkTick = (phase) => ({ files, dir }) =>
      send({ type: 'progress', phase, text: `${files.toLocaleString()} files — ${dir}` });

    send({ type: 'progress', phase: 'nas', text: 'Indexing NAS…' });
    const nasFiles = [];
    for (const r of nasRoots) {
      const f = walk(r, { onTick: walkTick('nas') });
      nasFiles.push(...f);
      send({ type: 'progress', phase: 'nas', text: `${r} — ${f.length} entries` });
    }

    send({ type: 'progress', phase: 'drive', text: 'Indexing Google Drive (metadata only)…' });
    const driveFiles = [];
    for (const r of driveRoots) {
      const f = walk(r, { onTick: walkTick('drive') });
      driveFiles.push(...f);
      send({ type: 'progress', phase: 'drive', text: `${r} — ${f.length} entries` });
    }

    const manifest = manifestPath ? loadManifest(manifestPath) : emptyManifest();

    /*
     * The Explorer's Convert output, if the user pointed at it. Walked like any
     * other tree; match() uses it to give native stubs a real file to copy.
     */
    const convertedFiles = [];
    for (const r of dedupeRoots(raw.convertedRoots || []).roots) {
      send({ type: 'progress', phase: 'drive', text: 'Indexing converted files…' });
      const f = walk(r, { onTick: walkTick('drive') });
      convertedFiles.push(...f);
      send({ type: 'progress', phase: 'drive', text: `${r} — ${f.length} converted` });
    }

    send({ type: 'progress', phase: 'match', text: 'Comparing…' });
    const result = await match({
      driveFiles, nasFiles, manifest, mapping,
      convertedFiles, sep: process.platform === 'win32' ? '\\' : '/',
      /*
       * Name the file being hashed. "12500/98000 compared" standing still for
       * ten minutes reads as a dead app; the same number with "hashing
       * ProjectMaster.mov" under it reads as a big file on a slow share, which
       * is what it is.
       */
      onProgress: (p) =>
        send({ type: 'progress', phase: 'match',
               done: p.done, total: p.total, hashed: p.hashed,
               text: `${p.done}/${p.total} compared · ${p.hashed} NAS files hashed` +
                     (p.hashedBytes ? ` (${fmtBytes(p.hashedBytes)})` : '') +
                     (p.hashing ? ` · reading ${p.hashing}…` : '') }),
    });

    const overlap = nasInternalOverlap(nasFiles, mapping);

    // A trimmed NAS index goes back so "find the match myself" can search it
    // without a second walk.
    const nasIndex = nasFiles
      .filter((f) => !f.error)
      .map((f) => ({ abs: f.abs, base: f.base, size: f.size, root: f.root }));

    send({
      type: 'done',
      result: {
        duplicates: result.duplicates, new: result.new, conflicts: result.conflicts,
        natives: result.natives, errors: result.errors, stats: result.stats,
      },
      overlap,
      nasIndex,
      droppedRoots,
      driveProbes,
      nasProbes,
      // Kept so a drive manifest can be exported off a comparison too, without
      // making the user re-walk the same tree.
      driveFiles: driveFiles.filter((f) => !f.error)
        .map((f) => ({ abs: f.abs, base: f.base, size: f.size, ext: f.ext, rel: f.rel, root: f.root })),
      /* 'unusable' is distinct from 'approximate' on purpose: no manifest at all is
         a choice, whereas a manifest that parsed to zero usable rows is a mistake
         that otherwise degrades in complete silence. */
      accuracy: manifest.withMd5 > 0 ? 'exact'
        : manifest.count > 0 ? 'no-md5'
        : (manifestPath ? 'unusable' : 'approximate'),
      manifestStats: { count: manifest.count, withMd5: manifest.withMd5 },
    });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
});
