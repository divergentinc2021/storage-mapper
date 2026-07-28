/**
 * Turning a comparison into a destination for every new file, in one step.
 *
 * Per-row mapping was fine for a demo and useless at 126 files. This assigns
 * them all at once, from one decision.
 *
 * Two modes:
 *   mirror — land under the NAS root that was compared against, keeping each
 *            file's path relative to its Drive root.
 *   custom — same, but under a folder the user picks.
 *
 * Note what mirror does NOT do: it does not try to merge a file into an existing
 * differently-named subfolder. In the real data the trees do not align (Drive
 * "Shoot_1_.../Pictures" vs NAS "360 Footage/Shoot_1_..._SRC/Pictures/Processed"),
 * and guessing which existing folder a new file belongs in is exactly the kind of
 * silent decision that creates a mess. New material lands in a predictable place,
 * nothing existing is touched, and a human can file it afterwards.
 */

/** Join with the platform separator, tolerating either separator on input. */
export function joinDest(root, rel, sep) {
  const r = String(root).replace(/[\\/]+$/, '');
  const t = String(rel).split(/[\\/]+/).filter(Boolean).join(sep);
  return t ? `${r}${sep}${t}` : r;
}

/**
 * Assign proposedNas to every new row.
 * @param {Array} rows result.new
 * @param {{mode:'mirror'|'custom', nasRoot:string, sep:string}} opts
 * @returns {{rows:Array, changed:number, examples:Array}}
 */
export function assignDestinations(rows, opts) {
  const sep = opts.sep || '/';
  const root = opts.nasRoot;
  if (!root) return { rows, changed: 0, examples: [] };

  let changed = 0;
  const out = rows.map((r) => {
    const dest = joinDest(root, r.drivePath, sep);
    if (dest !== r.proposedNas) changed++;
    return {
      ...r,
      proposedNas: dest,
      mappedBy: opts.mode === 'mirror' ? 'compared destination' : 'chosen destination',
    };
  });
  return {
    rows: out,
    changed,
    examples: out.slice(0, 5).map((r) => ({ from: r.drivePath, to: r.proposedNas })),
  };
}

/**
 * Classify each mapped row against what is already at its destination.
 *
 * `existing` is a map of lowercased destination path -> {size}. Anything absent
 * simply is not there.
 *
 *   new       nothing at the destination
 *   identical same name AND same byte count -> skip by default
 *   different same name, different size -> a version clash; skipped by default
 *             because overwriting the NAS copy is the one irreversible move here
 */
export function classifyAgainstDestination(rows, existing) {
  const get = (p) => existing[String(p).toLowerCase().split('\\').join('/')];
  return rows.map((r) => {
    const hit = get(r.proposedNas);
    if (!hit) return { ...r, state: 'new', existingSize: null, selected: true };
    if (Number(hit.size) === Number(r.size)) {
      return { ...r, state: 'identical', existingSize: hit.size, selected: false };
    }
    return { ...r, state: 'different', existingSize: hit.size, selected: false };
  });
}

export function summarise(rows) {
  const s = { new: 0, identical: 0, different: 0, selected: 0, selectedBytes: 0, bytesNew: 0 };
  for (const r of rows) {
    s[r.state]++;
    if (r.selected) { s.selected++; s.selectedBytes += Number(r.size) || 0; }
    if (r.state === 'new') s.bytesNew += Number(r.size) || 0;
  }
  return s;
}

/** Normalise a path for comparison across the two lists. */
function norm(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * A path that appears as BOTH a Drive root and a NAS root — or where one
 * contains the other — is a configuration error, not a preference.
 *
 * It compares a tree against itself: every file matches itself and is reported
 * as "already on the NAS", and if it were ever mapped the copy would target its
 * own source. Seen for real: "Z:\Internal UWC Projects" was pasted into the
 * Google Drive list alongside the NAS list.
 */
export function crossOverlap(driveRoots, nasRoots) {
  const bad = [];
  for (const d of driveRoots) {
    for (const n of nasRoots) {
      const nd = norm(d), nn = norm(n);
      if (nd === nn) bad.push({ drive: d, nas: n, how: 'the same folder is in both lists' });
      else if (nd.startsWith(nn + '/')) bad.push({ drive: d, nas: n, how: 'the Drive folder is inside the NAS folder' });
      else if (nn.startsWith(nd + '/')) bad.push({ drive: d, nas: n, how: 'the NAS folder is inside the Drive folder' });
    }
  }
  return bad;
}

/** Tokens for loose name matching: case, separators and punctuation dropped. */
function tokens(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function score(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * Propose one destination per Drive root, by folder-name similarity.
 *
 * With several sources a single shared destination is almost always wrong -- it
 * would flatten "External Client Projects", "Internal UIZ Projects" and
 * "Meeting_Minutes_Clients" into one folder. Each source gets its own, and the
 * UI shows the arrows so a wrong pairing is visible before anything is copied.
 */
export function suggestPairs(driveRoots, nasRoots) {
  const used = new Set();
  return driveRoots.map((d) => {
    let best = null, bestScore = 0;
    for (const n of nasRoots) {
      if (used.has(n)) continue;
      const s = score(base(d), base(n));
      if (s > bestScore) { bestScore = s; best = n; }
    }
    // Below a half-match the "suggestion" is noise; leave it for a human.
    if (best && bestScore >= 0.5) { used.add(best); return { drive: d, nas: best, score: bestScore, auto: true }; }
    return { drive: d, nas: null, score: 0, auto: false };
  });
}

/** Assign each row a destination under the pair belonging to ITS drive root. */
export function assignByPairs(rows, pairs, sep) {
  const byRoot = new Map(pairs.filter((p) => p.nas).map((p) => [norm(p.drive), p.nas]));
  let mapped = 0, unmapped = 0;
  const out = rows.map((r) => {
    const nas = byRoot.get(norm(r.driveRoot));
    if (!nas) { unmapped++; return { ...r, proposedNas: '', mappedBy: '(source not mapped)' }; }
    mapped++;
    return { ...r, proposedNas: joinDest(nas, r.drivePath, sep), mappedBy: `${base(r.driveRoot)} → ${base(nas)}` };
  });
  return { rows: out, mapped, unmapped };
}

/** Per-source counts and byte totals, for the mapping screen. */
export function perSource(rows, pairs) {
  return pairs.map((p) => {
    const mine = rows.filter((r) => norm(r.driveRoot) === norm(p.drive));
    return {
      ...p,
      files: mine.length,
      bytes: mine.reduce((a, r) => a + (Number(r.size) || 0), 0),
    };
  });
}
