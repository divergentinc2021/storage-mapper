/**
 * The comparison runs here, in a forked child, so a multi-minute walk over a
 * NAS share cannot freeze the window. Progress is streamed back over IPC.
 *
 * It imports the same src/ modules the CLI uses — there is no second copy of the
 * matching logic to drift out of sync with the tested one.
 */
import { walk, looksLikeDriveMount } from '../src/walk.mjs';
import { loadManifest, emptyManifest } from '../src/manifest.mjs';
import { loadMapping } from '../src/mapping.mjs';
import { match, nasInternalOverlap } from '../src/match.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const send = (m) => process.send && process.send(m);

process.on('message', async (msg) => {
  if (msg.cmd !== 'compare') return;
  try {
    const { driveRoots, nasRoots, manifestPath, mapping: mappingObj } = msg;

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
      accuracy: manifest.withMd5 > 0 ? 'exact' : (manifest.count > 0 ? 'no-md5' : 'approximate'),
      manifestStats: { count: manifest.count, withMd5: manifest.withMd5 },
    });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
});
