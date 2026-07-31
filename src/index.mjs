#!/usr/bin/env node
/**
 * storage-mapper — compare a Google Drive for Desktop mount against the QNAP
 * and emit a decision per file.
 *
 * It answers the three questions no off-the-shelf sync tool can:
 *   1. which Drive files are ALREADY on the NAS, under a different name or tree
 *   2. which are Google-native stubs that cannot be copied at all
 *   3. where the genuinely-new ones should land in the existing project taxonomy
 *
 * It never copies, moves or deletes. Its output is a plan you review and run.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { walk, looksLikeDriveMount, dedupeRoots } from './walk.mjs';
import { loadManifest, emptyManifest } from './manifest.mjs';
import { loadMapping } from './mapping.mjs';
import { match, nasInternalOverlap } from './match.mjs';
import { writeAll, writeCopyPlan, fmtBytes } from './report.mjs';

function parseArgs(argv) {
  const a = { nas: [], drive: [], out: 'out', manifest: null, config: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--nas') a.nas.push(v());
    else if (k === '--drive') a.drive.push(v());
    else if (k === '--manifest') a.manifest = v();
    else if (k === '--config') a.config = v();
    else if (k === '--out') a.out = v();
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

const HELP = `
storage-mapper — plan a Google Drive → QNAP migration without duplicating anything

  node src/index.mjs --config config/mapping.json [options]

  --config <file>    mapping table: nasRoots, driveRoots, aliases, map
  --nas <dir>        extra NAS root (repeatable; adds to config.nasRoots)
  --drive <dir>      extra Drive-mount root (repeatable; adds to config.driveRoots)
  --manifest <csv>   Drive API manifest with an md5 column (strongly recommended)
  --out <dir>        output directory (default: out)

Nothing is copied, moved or deleted. Output is duplicates.csv, new.csv,
natives.csv, conflicts.csv, nas-internal-overlap.csv, summary.json and a
copy-plan you review before running.

Without --manifest, matching falls back to size+name, which is weaker: identical
files that were renamed will be reported as new. Get md5 into the manifest.
`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.config && !args.nas.length && !args.drive.length)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const mapping = loadMapping(args.config);
  const ddN = dedupeRoots([...mapping.nasRoots, ...args.nas]);
  const ddD = dedupeRoots([...mapping.driveRoots, ...args.drive]);
  const nasRoots = ddN.roots, driveRoots = ddD.roots;
  [...ddN.dropped, ...ddD.dropped].forEach(function (d) {
    console.warn(`NOTE: skipping "${d.root}" — already covered by "${d.insideOf}"`);
  });

  if (!nasRoots.length || !driveRoots.length) {
    console.error('Need at least one --nas root and one --drive root.');
    process.exit(1);
  }

  // Guard: a Drive mount passed as a NAS root would be hashed, which in Stream
  // mode downloads the entire Drive. Refuse rather than warn.
  for (const r of nasRoots) {
    if (looksLikeDriveMount(r)) {
      console.error(`\nERROR: --nas "${r}" looks like a Google Drive mount.`);
      console.error('Hashing a Drive mount forces a full download of every file.');
      console.error('Pass the Drive path with --drive instead.\n');
      process.exit(2);
    }
  }
  for (const r of [...nasRoots, ...driveRoots]) {
    if (!existsSync(r)) {
      console.error(`ERROR: path does not exist: ${r}`);
      process.exit(2);
    }
  }

  const manifest = args.manifest ? loadManifest(args.manifest) : emptyManifest();
  if (!args.manifest) {
    console.warn('WARNING: no --manifest. Falling back to size+name matching;');
    console.warn('         renamed-but-identical files will be reported as new.\n');
  } else if (manifest.withMd5 === 0) {
    console.warn(`WARNING: manifest has ${manifest.count} rows but no md5 column.`);
    console.warn('         Extend the dashboard CSV export with md5Checksum.\n');
  }

  console.log('Indexing NAS (metadata only)…');
  const nasFiles = [];
  for (const r of nasRoots) {
    const files = walk(r);
    console.log(`  ${r}  →  ${files.filter((f) => !f.error).length} files`);
    nasFiles.push(...files);
  }

  console.log('Indexing Drive mount (metadata only — contents are never read)…');
  const driveFiles = [];
  for (const r of driveRoots) {
    const files = walk(r);
    console.log(`  ${r}  →  ${files.filter((f) => !f.error).length} files`);
    driveFiles.push(...files);
  }

  console.log('\nMatching…');
  const result = await match({
    driveFiles, nasFiles, manifest, mapping,
    // Padded, or the tail of a longer previous line survives the carriage return.
    onProgress: (p) => process.stdout.write(
      ('\r  ' + `${p.done}/${p.total} compared, ${p.hashed} NAS files hashed` +
       (p.hashing ? ` — hashing ${p.hashing}` : '')).padEnd(78).slice(0, 78)),
  });
  process.stdout.write('\r'.padEnd(60) + '\r');

  const overlap = nasInternalOverlap(nasFiles, mapping);
  const summary = writeAll(args.out, result, overlap);
  const plan = writeCopyPlan(args.out, result, driveRoots[0]);

  console.log(`
Already on the NAS   ${String(summary.counts.duplicates).padStart(7)}   ${fmtBytes(summary.bytes.duplicates)}
Genuinely new        ${String(summary.counts.new).padStart(7)}   ${fmtBytes(summary.bytes.new)}${summary.unmappedNew ? `   (${summary.unmappedNew} unmapped)` : ''}
Native stubs         ${String(summary.counts.natives).padStart(7)}   cannot be copied — must be exported
Conflicts            ${String(summary.counts.conflicts).padStart(7)}   need a human decision
NAS-internal overlap ${String(summary.counts.nasInternalOverlap).padStart(7)}   ${fmtBytes(summary.bytes.nasInternalOverlap)} recoverable

Hashed ${result.stats.hashedFiles} NAS files (${fmtBytes(result.stats.hashedBytes)}) — size-collision candidates only.
Wrote ${path.resolve(args.out)}/  (${plan.dirs} copy groups)

Nothing was copied. Review new.csv and copy-plan before running anything.`);
}

main().catch((e) => {
  console.error('\nstorage-mapper failed:', e.message);
  process.exit(1);
});
