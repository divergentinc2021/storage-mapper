/**
 * Converted-file substitution.
 *
 * A Google-native stub has no bytes, so it can never be copied. The Storage
 * Explorer's Convert step produces a real file for it — but that file lands in
 * `My Drive/_Converted for NAS/<mirrored path>`, which is nowhere near where the
 * original sat. Copy that tree straight across and the NAS ends up with a
 * parallel folder of orphans instead of documents beside the projects they
 * belong to.
 *
 * So the two are joined here: a stub is matched to its converted equivalent, and
 * the copy is planned to take the CONVERTED file's bytes to the ORIGINAL's
 * destination. `Plan.gdoc` under `UIH - JIGSPACE/DOCUMENTS` becomes
 * `Plan.docx` under `UIH - JIGSPACE/DOCUMENTS` on the NAS, sourced from
 * wherever the converted copy actually lives.
 *
 * Matching is by BASE NAME, because that is the only thing the two sides
 * reliably share. The Explorer names a conversion `<original name>.<ext>` and
 * mirrors the DRIVE folder chain, which is not the same as the local mount path
 * — shared drives are rooted differently on disk than they are in the API. Path
 * matching would look more precise and would be wrong more often.
 */
import path from 'node:path';

/** Strip the native extension: 'Plan.gdoc' -> 'Plan'. */
export function stemOf(name) {
  return String(name).replace(/\.[^.]*$/, '');
}

/**
 * Index converted files by stem.
 *
 * Several folders can hold a 'Report.docx', so each stem keeps every candidate
 * and the parent folder name decides between them at lookup time.
 */
export function indexConverted(files) {
  const byStem = new Map();
  for (const f of files) {
    if (!f || f.error) continue;
    const stem = stemOf(f.base);
    if (!stem) continue;
    const key = stem.toLowerCase();
    if (!byStem.has(key)) byStem.set(key, []);
    byStem.get(key).push(f);
  }
  return byStem;
}

const parentOf = (rel) => {
  const parts = String(rel).split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2].toLowerCase() : '';
};

/**
 * The converted file for a native stub, or null.
 *
 * With one candidate it is taken. With several, the one whose parent folder
 * matches the stub's parent wins; failing that it is AMBIGUOUS and nothing is
 * returned — guessing which 'Minutes.docx' belongs to which project would put
 * the wrong document on the NAS under a confident name, which is worse than
 * leaving it for a human.
 */
export function resolveConverted(stub, byStem) {
  const cands = byStem.get(stemOf(stub.base).toLowerCase());
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0];

  const want = parentOf(stub.rel);
  const sameParent = cands.filter((c) => parentOf(c.rel) === want);
  return sameParent.length === 1 ? sameParent[0] : null;
}

/**
 * A copy row that reads the converted file and writes it where the ORIGINAL
 * belongs.
 *
 * planGroups builds the source directory from driveRoot + drivePath and the
 * destination from proposedNas, using `name` on both sides — so the row carries
 * the CONVERTED file's location as its source and the original's mapped path,
 * extension swapped, as its destination. Same filename at both ends, which is
 * what that grouping requires.
 */
export function substitutionRow(stub, conv, destFor, sep = '/') {
  const dest = destFor(stub.rel);
  if (!dest || !dest.nas) return null;

  // The destination keeps the original's folders and takes the new extension.
  const nasDir = dest.nas.split(/[\\/]/).slice(0, -1).join(sep);
  const proposedNas = (nasDir ? nasDir + sep : '') + conv.base;

  return {
    drivePath: conv.rel,          // source side: where the converted file is
    driveRoot: conv.root,
    driveAbs: conv.abs,
    name: conv.base,
    size: conv.size,
    proposedNas,                  // destination side: where the original belonged
    mappedBy: dest.rule + ' (converted)',
    viaConversion: true,
    stubPath: stub.rel,
    stubName: stub.base,
  };
}
