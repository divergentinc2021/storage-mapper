/**
 * The matcher.
 *
 * Hashing policy is the whole design. The Drive side is never hashed — its
 * checksums come from the API manifest for free. On the NAS side we hash only
 * files whose SIZE collides with some Drive file, because a byte-identical copy
 * must have an identical size. Everything else is decided on metadata. That
 * turns "hash 9 TB" into "hash the handful of genuine candidates".
 *
 * Verdicts:
 *   duplicate — already on the NAS (md5, or size+name where no md5 is available)
 *   conflict  — same name, different content: a human has to choose
 *   new       — not on the NAS
 *   native    — a .gdoc/.gsheet stub; cannot be copied at all, must be exported
 */
import { md5File } from './walk.mjs';
import { classifyNative, isNativeExt } from './natives.mjs';
import { indexConverted, resolveConverted, substitutionRow } from './converted.mjs';

export async function match({
  driveFiles, nasFiles, manifest, mapping, onProgress,
  convertedFiles = [], sep = '/',
}) {
  /*
   * Files produced by the Explorer's Convert step. When one exists for a native
   * stub, the stub stops being a dead end: the converted bytes are copied to
   * where the ORIGINAL belonged, so the NAS gets Plan.docx beside its project
   * rather than in a parallel _Converted tree.
   */
  const convIndex = indexConverted(convertedFiles);
  // ---- NAS indexes ---------------------------------------------------------
  const nasBySize = new Map();
  const nasByBase = new Map();
  for (const f of nasFiles) {
    if (f.error) continue;
    if (!nasBySize.has(f.size)) nasBySize.set(f.size, []);
    nasBySize.get(f.size).push(f);
    if (!nasByBase.has(f.baseLower)) nasByBase.set(f.baseLower, []);
    nasByBase.get(f.baseLower).push(f);
  }

  // Manifest join key: name+size. The API path and the mount-relative path are
  // rooted differently, so name+size is the reliable bridge between them.
  const manByNameSize = new Map();
  for (const rec of manifest.byId.values()) {
    const k = `${String(rec.name).toLowerCase()}|${rec.size}`;
    if (!manByNameSize.has(k)) manByNameSize.set(k, []);
    manByNameSize.get(k).push(rec);
  }

  const hashCache = new Map();
  let hashed = 0, hashedBytes = 0;

  /*
   * Progress is TIME-based, not every-Nth-file.
   *
   * It used to fire every 500 Drive files. Hashing happens between those ticks
   * and runs at NAS speed, so a single 40 GB candidate could hold the bar
   * still for many minutes. Worse, the run stays silent without stopping: the
   * main process treats any message as proof of life, so a comparison that is
   * grinding through gigabytes looks exactly like one that has died, and the
   * five-minute stall detector never fires because the next batch of 500 always
   * arrives eventually. Reported as the comparison hanging.
   *
   * Now nothing goes quiet for more than a second, and the text says what is
   * being hashed, so a slow run is visibly slow rather than apparently dead.
   */
  let done = 0, lastTick = 0, nowHashing = '';
  const TICK_MS = 1000;
  const tick = (force) => {
    if (!onProgress) return;
    const t = Date.now();
    if (!force && t - lastTick < TICK_MS) return;
    lastTick = t;
    onProgress({
      done, total: driveFiles.length, hashed, hashedBytes, hashing: nowHashing,
    });
  };

  const hashOf = async (f) => {
    if (hashCache.has(f.abs)) return hashCache.get(f.abs);
    let h = null;
    // Announce BEFORE the read, not after: the whole point is to say what the
    // run is stuck on while it is stuck on it.
    nowHashing = f.base;
    tick(true);
    try {
      h = await md5File(f.abs);
      hashed++; hashedBytes += f.size;
    } catch (e) {
      h = null; // unreadable or refused (Drive mount) — fall back to metadata
    }
    nowHashing = '';
    hashCache.set(f.abs, h);
    return h;
  };

  const out = { duplicates: [], conflicts: [], new: [], natives: [], errors: [] };

  for (const f of driveFiles) {
    if (f.error) { out.errors.push(f.error); continue; }
    done++;
    tick(false);

    // ---- natives: never copyable ------------------------------------------
    if (isNativeExt(f.ext)) {
      const n = classifyNative(f.ext, f.abs, f.size);

      // A converted equivalent turns an uncopyable stub into a real copy.
      const conv = convIndex.size ? resolveConverted(f, convIndex) : null;
      const row = conv ? substitutionRow(f, conv, (rel) => mapping.destFor(rel), sep) : null;
      if (row) {
        out.new.push(row);
        out.natives.push({
          drivePath: f.rel, driveRoot: f.root, name: f.base,
          kind: n.kind, exportAs: n.exportAs || '', docId: n.docId || '',
          note: 'converted — ' + conv.base + ' will be copied in its place',
          resolved: true, convertedAs: conv.base,
        });
        continue;
      }

      out.natives.push({
        drivePath: f.rel, driveRoot: f.root, name: f.base,
        kind: n.kind, exportAs: n.exportAs || '', docId: n.docId || '', note: n.note,
        resolved: false,
      });
      continue;
    }

    const dest = mapping.destFor(f.rel);
    const driveMd5 = pickMd5(manByNameSize, f);
    const candidates = nasBySize.get(f.size) || [];

    let hit = null, tier = null;
    if (candidates.length) {
      if (driveMd5) {
        /*
         * Same-name candidates first. Every candidate here already has the
         * right size, and the loop stops at the first md5 that matches — so
         * whichever is tried first is usually the only one read. A copy almost
         * always kept its name, and reading it first turns "hash every file on
         * the NAS that happens to be this size" into "hash one". Unordered,
         * a common size (an empty file, a stock asset) meant hashing the whole
         * bucket per Drive file, which is where the gigabytes went.
         *
         * Correctness is untouched: the same set is still searched, and the
         * verdict is still decided by the hash.
         */
        const ordered = candidates.length > 1
          ? candidates.slice().sort((a, b) =>
              (b.baseLower === f.baseLower) - (a.baseLower === f.baseLower))
          : candidates;
        for (const c of ordered) {
          if (await hashOf(c) === driveMd5) { hit = c; tier = 'md5'; break; }
        }
      }
      if (!hit) {
        const byName = candidates.find((c) => c.baseLower === f.baseLower);
        if (byName) { hit = byName; tier = driveMd5 ? 'size+name (md5 differed)' : 'size+name'; }
      }
      if (!hit && candidates.length === 1 && !driveMd5) {
        hit = candidates[0]; tier = 'size only (weak)';
      }
    }

    if (hit && tier === 'size+name (md5 differed)') {
      // Same name and size but the content hash disagrees — do not call this a
      // duplicate; it is exactly the case a human must look at.
      out.conflicts.push({
        drivePath: f.rel, nasPath: hit.abs, name: f.base,
        driveSize: f.size, nasSize: hit.size, reason: 'md5 differs at equal size+name',
      });
      continue;
    }

    if (hit) {
      out.duplicates.push({
        drivePath: f.rel, nasPath: hit.abs, name: f.base,
        size: f.size, tier, md5: driveMd5 || '',
      });
      continue;
    }

    // No size match. A same-name file at a different size is a version clash.
    const sameName = nasByBase.get(f.baseLower);
    if (sameName && sameName.length) {
      out.conflicts.push({
        drivePath: f.rel, nasPath: sameName[0].abs, name: f.base,
        driveSize: f.size, nasSize: sameName[0].size, reason: 'same name, different size',
      });
      continue;
    }

    out.new.push({
      drivePath: f.rel, name: f.base, size: f.size,
      // The root is needed to rebuild an absolute source path in the copy plan.
      driveRoot: f.root, driveAbs: f.abs,
      proposedNas: dest ? dest.nas : '', mappedBy: dest ? dest.rule : '(unmapped)',
    });
  }

  out.stats = {
    driveFiles: driveFiles.length,
    nasFiles: nasFiles.length,
    hashedFiles: hashed,
    hashedBytes,
    manifestRecords: manifest.count,
    manifestWithMd5: manifest.withMd5,
  };
  return out;
}

function pickMd5(index, f) {
  const recs = index.get(`${f.baseLower}|${f.size}`);
  if (!recs || !recs.length) return '';
  const withMd5 = recs.find((r) => r.md5);
  return withMd5 ? withMd5.md5 : '';
}

/**
 * NAS-internal overlap, on metadata alone — the old code-named tree against the
 * current descriptive one. A hint, not a verdict: use FreeFileSync's
 * compare-by-content for the authoritative answer before deleting anything.
 */
export function nasInternalOverlap(nasFiles, mapping) {
  const byKey = new Map();
  for (const f of nasFiles) {
    if (f.error) continue;
    const k = `${f.baseLower}|${f.size}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  const rows = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const roots = new Set(group.map((g) => g.root));
    if (roots.size < 2) continue; // same root = a real second copy, not cross-tree
    rows.push({
      name: group[0].base,
      size: group[0].size,
      copies: group.length,
      paths: group.map((g) => g.abs).join(' | '),
    });
  }
  return rows.sort((a, b) => b.size - a.size);
}
