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

/*
 * "Is this a Google Drive for Desktop mount?"
 *
 * NAME ALONE IS NOT AN ANSWER, and treating it as one broke a real setup: a NAS
 * share at Z:\SHARED DRIVES matched the "Shared drives" pattern, so Compare
 * refused it outright and md5File would have refused to hash anything under it.
 * "Shared drives", "My Drive" and "Shared with me" are ordinary folder names
 * that anyone may use on a NAS; they are only meaningful as Drive markers when
 * the VOLUME they sit on is itself a Drive mount.
 *
 * So the patterns are split. The strong ones name Google explicitly and settle
 * it on their own. The weak ones are folder names that need corroborating: read
 * the volume root and see whether "My Drive" is actually there, which every
 * Drive for Desktop mount has and a NAS share essentially never does.
 */
const DRIVE_MOUNT_STRONG = [
  /[/\\]CloudStorage[/\\]GoogleDrive-/i,
  /^\/Volumes\/GoogleDrive/i,
];
const DRIVE_MOUNT_WEAK = [
  /[/\\]My Drive([/\\]|$)/i,
  /[/\\]Shared drives([/\\]|$)/i,
  /[/\\]Shared with me([/\\]|$)/i,
];

/** The mount a path belongs to: `Z:\`, `\\server\share`, `/Volumes/NAS`, or `/`. */
export function volumeRootOf(p) {
  const s = String(p);
  if (IS_WIN || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) {
    const unc = /^\\\\([^\\/]+)[\\/]([^\\/]+)/.exec(s);
    if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
    const drv = /^([A-Za-z]:)/.exec(s);
    if (drv) return `${drv[1]}\\`;
  }
  const vol = /^(\/Volumes\/[^/]+)/.exec(s);
  if (vol) return vol[1];
  return '/';
}

/*
 * The directory that HOLDS the Drive-looking segment. For H:\Shared drives\X
 * that is H:\ — the mount root, which is where the corroborating "My Drive"
 * would live. Deliberately not volumeRootOf: a Drive mount is not always at a
 * volume root (the test fixture puts one at .../drive/My Drive), and the mount
 * root is the thing that actually defines a Drive mount.
 */
function containerOfMatch(p, re) {
  const m = re.exec(String(p));
  if (!m) return null;
  const head = String(p).slice(0, m.index);
  if (!head) return '/';
  return /^[A-Za-z]:$/.test(head) ? head + '\\' : head;
}

// md5File asks per FILE, so without this every hash would readdir the mount.
const DIR_IS_DRIVE_ROOT = new Map();
export function _resetVolumeCache() { DIR_IS_DRIVE_ROOT.clear(); }

function holdsMyDrive(dir, listRoot) {
  if (DIR_IS_DRIVE_ROOT.has(dir)) return DIR_IS_DRIVE_ROOT.get(dir);
  let verdict;
  try {
    const names = listRoot
      ? listRoot(dir)
      : readdirSync(toLongPath(dir), { withFileTypes: true })
          .filter((e) => e.isDirectory()).map((e) => e.name);
    verdict = names.some((n) => String(n).toLowerCase() === 'my drive');
  } catch {
    /*
     * Unreadable. Assume Drive: this guard exists to stop a full download of
     * somebody's entire Drive, which is far more costly to get wrong than
     * refusing a folder the user can simply re-point.
     */
    verdict = true;
  }
  DIR_IS_DRIVE_ROOT.set(dir, verdict);
  return verdict;
}

export function driveMountVerdict(p, opts = {}) {
  if (DRIVE_MOUNT_STRONG.some((re) => re.test(p))) {
    return { drive: true, why: 'the path names a Google Drive mount' };
  }
  const weak = DRIVE_MOUNT_WEAK.find((re) => re.test(p));
  if (!weak) return { drive: false, why: '' };

  const dir = containerOfMatch(p, weak);
  if (holdsMyDrive(dir, opts.listRoot)) {
    return { drive: true, why: `${dir} contains "My Drive", so it is a Drive mount` };
  }
  return {
    drive: false,
    why: `a folder named like Drive's, but ${dir} has no "My Drive" — treated as ordinary storage`,
  };
}

export function looksLikeDriveMount(p, opts) {
  return driveMountVerdict(p, opts).drive;
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
