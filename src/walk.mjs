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
