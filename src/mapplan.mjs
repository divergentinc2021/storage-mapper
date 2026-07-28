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
