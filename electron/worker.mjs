/**
 * The comparison runs here, in a forked child, so a multi-minute walk over a
 * NAS share cannot freeze the window. Progress is streamed back over IPC.
 *
 * It imports the same src/ modules the CLI uses — there is no second copy of the
 * matching logic to drift out of sync with the tested one.
 */
import { walk, looksLikeDriveMount, dedupeRoots } from '../src/walk.mjs';
import { loadManifest, emptyManifest } from '../src/manifest.mjs';
import { loadMapping } from '../src/mapping.mjs';
import { match, nasInternalOverlap } from '../src/match.mjs';
import { crossOverlap } from '../src/mapplan.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const send = (m) => process.send && process.send(m);

process.on('message', async (msg) => {
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
      if (looksLikeDriveMount(r)) {
        throw new Error(
          `"${r}" looks like a Google Drive mount. Hashing one would force a full ` +
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

    send({ type: 'progress', phase: 'nas', text: 'Indexing NAS…' });
    const nasFiles = [];
    for (const r of nasRoots) {
      const f = walk(r);
      nasFiles.push(...f);
      send({ type: 'progress', phase: 'nas', text: `${r} — ${f.length} entries` });
    }

    send({ type: 'progress', phase: 'drive', text: 'Indexing Google Drive (metadata only)…' });
    const driveFiles = [];
    for (const r of driveRoots) {
      const f = walk(r);
      driveFiles.push(...f);
      send({ type: 'progress', phase: 'drive', text: `${r} — ${f.length} entries` });
    }

    const manifest = manifestPath ? loadManifest(manifestPath) : emptyManifest();

    send({ type: 'progress', phase: 'match', text: 'Comparing…' });
    const result = await match({
      driveFiles, nasFiles, manifest, mapping,
      onProgress: (done, total, hashed) =>
        send({ type: 'progress', phase: 'match', done, total, hashed,
               text: `${done}/${total} compared · ${hashed} NAS files hashed` }),
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
