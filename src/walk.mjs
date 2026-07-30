/**
 * Filesystem indexing, plus the two guards that keep this safe to run.
 *
 * GUARD 1 — never hash a Drive for Desktop mount. In Stream mode the file
 * contents are not on disk; reading a file forces Drive to download it. Hashing
 * a whole mount would pull the entire Drive down and can fill the disk. We index
 * Drive by metadata only, and take its checksums from the API manifest instead,
 * where they are free.
 *
 * GUARD 2 — Windows MAX_PATH. Deep Drive folders plus long project names blow
 * past 260 characters and silently break naive walkers. Paths are prefixed with
 * \\?\ on win32 before any fs call.
 */
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/** Opt into the Win32 extended-length path syntax so >260 char paths work. */
export function toLongPath(p) {
  if (!IS_WIN) return p;
  if (p.startsWith('\\\\?\\')) return p;
  const abs = path.resolve(p);
  return abs.startsWith('\\\\') ? `\\\\?\\UNC\\${abs.slice(2)}` : `\\\\?\\${abs}`;
}

/** Heuristics for "this path is a Google Drive for Desktop mount". */
const DRIVE_MOUNT_HINTS = [
  /[/\\]My Drive([/\\]|$)/i,
  /[/\\]Shared drives([/\\]|$)/i,
  /[/\\]Shared with me([/\\]|$)/i,
  /[/\\]CloudStorage[/\\]GoogleDrive-/i,
  /^\/Volumes\/GoogleDrive/i,
];

export function looksLikeDriveMount(p) {
  return DRIVE_MOUNT_HINTS.some((re) => re.test(p));
}

/**
 * What state is this destination in — populated, genuinely empty, or not there?
 *
 * The three have to be told apart before anything is allowed to skip Compare.
 * match() treats an empty NAS side as "every file is new", and walk() turns an
 * unreadable directory into an error record that match() then drops silently —
 * so a mistyped, unmounted or offline NAS root produces the same clean
 * "everything is new" as a fresh empty folder. That is a safe-looking answer to
 * a question that was never actually asked, and it is the failure this returns
 * enough information to refuse.
 *
 * Cheap on purpose: one readdir, no recursion, so it can run on every path edit.
 */
export function probeRoot(root) {
  const out = { root, exists: false, readable: false, empty: false, entries: 0, error: '' };
  let st;
  try {
    st = statSync(toLongPath(root));
  } catch (e) {
    out.error = e.code === 'ENOENT' ? 'does not exist' : (e.code || e.message);
    return out;
  }
  out.exists = true;
  if (!st.isDirectory()) { out.error = 'not a folder'; return out; }
  try {
    // Same exclusions the walk uses. A NAS share holding nothing but @eaDir
    // thumbnails or a #recycle bin is empty for every purpose this app has.
    const ents = readdirSync(toLongPath(root), { withFileTypes: true })
      .filter((e) => !SKIP_NAMES.has(e.name) && !(e.isDirectory() && SKIP_DIRS.has(e.name)));
    out.readable = true;
    out.entries = ents.length;
    out.empty = ents.length === 0;
  } catch (e) {
    out.error = e.code || e.message;
  }
  return out;
}

/**
 * Drop roots that sit inside another chosen root.
 *
 * Picking "H:\Shared drives" AND "H:\Shared drives\UIZ - PROJECTS" walks the
 * second one twice, so every file in it appears twice in the index and every
 * count is inflated. Easy to do by accident in the folder picker, and silent.
 *
 * @returns {{roots: string[], dropped: {root:string, insideOf:string}[]}}
 */
export function dedupeRoots(roots) {
  const norm = (p) => {
    let s = path.resolve(p).split(path.sep).join('/');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s.replace(/\/+$/, '');
  };
  const seen = new Map();
  for (const r of roots) {
    const k = norm(r);
    if (!seen.has(k)) seen.set(k, r); // exact duplicates collapse here
  }
  const keys = [...seen.keys()];
  const kept = [], dropped = [];
  for (const k of keys) {
    const parent = keys.find((o) => o !== k && k.startsWith(o + '/'));
    if (parent) dropped.push({ root: seen.get(k), insideOf: seen.get(parent) });
    else kept.push(seen.get(k));
  }
  // An exact duplicate of a kept root is also a drop worth reporting.
  const exactDupes = roots.length - seen.size;
  for (let i = 0; i < exactDupes; i++) dropped.push({ root: '(duplicate entry)', insideOf: '' });
  return { roots: kept, dropped };
}

/** Junk that should never count as content on either side. */
const SKIP_NAMES = new Set([
  '.DS_Store', 'desktop.ini', 'Thumbs.db', '.localized', 'Icon\r',
  '@Recycle', '@Recently-Snapshot', '@eaDir', '.@__thumb', '#recycle',
]);

const SKIP_DIRS = new Set(['@Recycle', '@Recently-Snapshot', '@eaDir', '#recycle', '.git']);

/**
 * Walk a root and return file records. Metadata only — nothing is read.
 * @param {string} root
 * @param {{onDir?: (rel:string)=>void, maxDepth?: number}} opts
 */
export function walk(root, opts = {}) {
  const out = [];
  const maxDepth = opts.maxDepth ?? Infinity;
  const rootResolved = path.resolve(root);

  const stack = [{ dir: rootResolved, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = readdirSync(toLongPath(dir), { withFileTypes: true });
    } catch (e) {
      out.push({ error: `unreadable: ${dir} (${e.code || e.message})` });
      continue;
    }
    for (const ent of entries) {
      if (SKIP_NAMES.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth + 1 <= maxDepth) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue; // skip symlinks/sockets/etc
      let st;
      try {
        st = statSync(toLongPath(abs));
      } catch {
        continue;
      }
      const rel = path.relative(rootResolved, abs);
      out.push({
        abs,
        rel: rel.split(path.sep).join('/'),
        root: rootResolved,
        base: ent.name,
        baseLower: ent.name.toLowerCase(),
        ext: path.extname(ent.name).toLowerCase(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return out;
}

/**
 * md5 of a local file. Refuses anything under a Drive mount — see GUARD 1.
 * Streamed so a 12 GB video does not land in memory on a small machine.
 */
export function md5File(abs) {
  if (looksLikeDriveMount(abs)) {
    throw new Error(
      `refusing to hash a Google Drive mount (would force a full download): ${abs}`
    );
  }
  return new Promise((resolve, reject) => {
    const h = createHash('md5');
    const s = createReadStream(toLongPath(abs));
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
