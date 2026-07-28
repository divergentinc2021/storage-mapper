/**
 * The cross-naming problem.
 *
 * The NAS holds the same projects twice under two naming conventions — an older
 * code-based tree (`u0004_Custom_Haptic_VR_Dentistry`) and the current
 * descriptive one (`Preclinical Dental Education VR & Haptics`). A folder
 * comparison tool cannot know those are the same project. This module carries
 * that knowledge: explicit alias pairs, plus a project-code heuristic, plus the
 * table that says where each Drive folder should land.
 */
import { readFileSync } from 'node:fs';

/** `ird0001`, `u0004`, `tr0003` … — the old taxonomy's join key. */
const CODE_RE = /\b([a-z]{1,4}\d{3,4})\b/i;

export function projectCode(name) {
  const m = CODE_RE.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Fold case, punctuation and separators so cosmetic renames still match. */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/, '')      // drop a trailing extension
    .replace(/[_\-\s]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .trim();
}

export function loadMapping(file) {
  const cfg = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const aliasPairs = (cfg.aliases || []).map((p) => p.map(normalizeName));

  // Undirected alias graph → canonical group id per name.
  const group = new Map();
  let next = 0;
  for (const [a, b] of aliasPairs) {
    const ga = group.get(a), gb = group.get(b);
    if (ga === undefined && gb === undefined) { group.set(a, next); group.set(b, next); next++; }
    else if (ga === undefined) group.set(a, gb);
    else if (gb === undefined) group.set(b, ga);
    else if (ga !== gb) for (const [k, v] of group) if (v === gb) group.set(k, ga);
  }

  const map = (cfg.map || [])
    // `drive` is a relative prefix inside the mount, so trimming slashes is right.
    // `nas` is a DESTINATION and must stay absolute: trimming its leading slash
    // turned "/Volumes/NAS/..." into "Volumes/NAS/..." and would have stripped the
    // leading "\\" off a UNC path, so the copy plan silently pointed at a relative
    // folder next to wherever it was run.
    .map((m) => ({ drive: trimSlashes(m.drive), nas: normalizeDest(m.nas), note: m.note || '' }))
    .sort((a, b) => b.drive.length - a.drive.length); // longest prefix wins

  return {
    nasRoots: cfg.nasRoots || [],
    driveRoots: cfg.driveRoots || [],
    map,
    /** Do these two folder names refer to the same project? */
    sameProject(a, b) {
      const na = normalizeName(a), nb = normalizeName(b);
      if (na && na === nb) return 'name';
      const ga = group.get(na), gb = group.get(nb);
      if (ga !== undefined && ga === gb) return 'alias';
      const ca = projectCode(a), cb = projectCode(b);
      if (ca && ca === cb) return 'code';
      return null;
    },
    /** Where should this Drive-relative path land on the NAS? */
    destFor(driveRel) {
      const p = trimSlashes(driveRel);
      for (const m of map) {
        if (p === m.drive || p.startsWith(m.drive + '/')) {
          const tail = p.slice(m.drive.length).replace(/^\//, '');
          return { nas: tail ? `${m.nas}/${tail}` : m.nas, rule: m.drive };
        }
      }
      return null;
    },
  };
}

function trimSlashes(s) {
  return String(s || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** Destinations keep their root: drive letter, UNC prefix or leading slash. */
function normalizeDest(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (/^\\\\/.test(v)) return v.replace(/[\\/]+$/, '');       // \\NAS\share
  return v.replace(/\\/g, '/').replace(/\/+$/, '');           // C:/... or /mnt/...
}
