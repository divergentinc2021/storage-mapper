# storage-mapper

Plans a Google Drive → QNAP migration **without duplicating anything**.

It answers the three questions no off-the-shelf sync tool can, and does nothing
else — it never copies, moves or deletes. Its output is a plan you review.

1. **Which Drive files are already on the NAS**, even renamed or filed under a
   different naming convention.
2. **Which are Google-native stubs** that cannot be copied at all.
3. **Where the genuinely new ones should land** in an existing project taxonomy.

## Why this exists

A folder-comparison tool (FreeFileSync, robocopy, Synkron) compares two trees
that are supposed to be the same. That is the wrong shape for this job:

- The NAS already held **two generations of the same projects** under different
  names — `u0004_Custom_Haptic_VR_Dentistry` and
  `Preclinical Dental Education VR & Haptics` are one project. No diff tool
  knows that; this one is told.
- **Google Drive for Desktop does not put documents on disk.** A Doc, Sheet or
  Slide appears as a few-hundred-byte `.gdoc`/`.gsheet`/`.gslides` JSON stub
  holding a URL. Copy it and you have archived a dead link. It looks like a real
  file in Explorer, which is why this is the most-missed step in a Drive
  migration.
- **You must not hash the Drive mount.** In Stream mode the bytes are not local;
  reading a file makes Drive download it. Hashing a whole mount pulls the entire
  Drive down and can fill the disk.

Use FreeFileSync for what it is good at — comparing two NAS trees by content.
Use this for the parts it cannot do.

## The hashing policy (the whole design)

| Side | Checksums from | Cost |
|---|---|---|
| Drive | the **API manifest** (`md5Checksum` is returned in the file listing) | free — no download |
| NAS | computed locally, **only** for files whose size collides with a Drive file | small |

A byte-identical copy must have an identical size, so size is a free
pre-filter. That turns "hash 9 TB" into "hash the handful of real candidates" —
the fixture run hashes 4 files out of the whole tree.

Two guards enforce it: `md5File()` refuses any path that looks like a Drive
mount, and passing one as `--nas` exits with an error rather than downloading
your Drive.

## Usage

```bash
cp config/mapping.example.json config/mapping.json   # then edit
node src/index.mjs --config config/mapping.json --manifest manifest.csv --out out
```

| Flag | Meaning |
|---|---|
| `--config` | mapping table: `nasRoots`, `driveRoots`, `aliases`, `map` |
| `--manifest` | Drive API manifest CSV **with an `md5` column** — strongly recommended |
| `--nas` / `--drive` | extra roots, repeatable |
| `--out` | output directory (default `out`) |

Without `--manifest` it falls back to size+name matching, and renamed-but-
identical files are reported as new. Get md5 into the manifest.

### Output

| File | Meaning |
|---|---|
| `duplicates.csv` | already on the NAS, with the exact path and match tier |
| `new.csv` | genuinely new, with the proposed destination |
| `natives.csv` | stubs — must be exported, cannot be copied |
| `conflicts.csv` | same name, different content: needs a human |
| `nas-internal-overlap.csv` | the same file in two NAS trees |
| `copy-plan.bat` / `.sh` | copies **only** approved new files |
| `summary.json` | counts and byte totals |

The copy plan uses `robocopy /XO` and `rsync --ignore-existing` — never `/MIR`,
never `--delete`. Running it cannot remove anything from the NAS. Files with no
mapping rule are emitted as comments, not silently dropped.

## Match tiers

| Tier | Meaning |
|---|---|
| `md5` | byte-identical. Survives renaming — the case name-matching misses |
| `size+name` | strong for media, used when no md5 is available |
| `size only (weak)` | one candidate, no md5, no name match. Verify before acting |
| *conflict* | equal name **and** size but a different hash — never treated as a duplicate |

## Tests

```bash
npm test
```

Builds a miniature Drive mount and NAS covering every tier, plus the cases a
naive compare gets wrong: a renamed-but-identical file, a same-name/same-size
version clash, three stub types, and cross-tree overlap. It also asserts the
Drive mount was never hashed and that the guard refuses a Drive path as `--nas`.

The suite is **mutation-tested**: disabling the md5 tier, treating a hash
mismatch as a duplicate, or letting natives reach the copy plan each make it
fail. A test that cannot fail is not verification.

## Where it runs

Windows is the natural host — `Z:` is already mapped and `robocopy` is present
and long-path safe. It is dependency-free Node and runs the same on macOS
against an SMB mount. On Windows, paths are prefixed `\\?\` internally so
`MAX_PATH` does not silently truncate deep Drive trees.

## What it does not do

- Export natives. That needs the Drive API or `rclone --drive-export-formats`;
  `natives.csv` lists exactly what to export and to what.
- Copy anything. Review the plan and run it yourself.
- Decide conflicts. It surfaces them; a human picks.
