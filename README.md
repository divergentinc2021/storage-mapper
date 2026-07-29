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

## Desktop app

```bash
npm install
npm start
```

Pick the Google Drive folder, add one or more NAS folders, optionally load the
Drive manifest CSV, hit **Compare**. Results land in five tabs — Already on NAS,
New, Conflicts, Native stubs, NAS overlap — and **Export reports…** writes the
same CSVs and copy plan the CLI produces.

An accuracy badge states which mode you are in: **Exact** once a manifest with
checksums is loaded, **Approximate** otherwise. It is not decoration — in
approximate mode a renamed-but-identical file is reported as new.

### Remapping when it misses

Rows in **New** carry two actions, because "new" is sometimes wrong:

- **Set destination…** — map that Drive folder to a NAS path. Written as a `map`
  rule.
- **Already on NAS…** — search the NAS for the file it actually duplicates and
  pick it. The app records the two *parent folder names* as the same project, so
  every other file in them matches on the next run. This is how
  `UIH Dental` ≡ `u0004_Custom_Haptic_VR_Dentistry` gets learned once instead of
  file by file.

Rules persist to `mapping.json` in the app's user-data folder and apply on the
next Compare — the UI says so rather than implying the table already reflects it.

The comparison runs in a forked child process, so a long walk over an SMB share
never freezes the window. The renderer has no Node access at all: `contextIsolation`
is on, `nodeIntegration` off, and every capability is an explicit channel in
`electron/preload.cjs`.

### Verifying UI changes

```bash
npm run preview   # then open preview/index.html
```

Builds a browser-runnable copy from the **real** `electron/ui/*` with a mocked
bridge, so the interface can be exercised without packaging, a NAS or a Drive
mount. Same technique as the sibling Drive tool, where it caught two bugs no
server-side check could have.

### Profiles

The profile dropdown in the header remembers a whole setup: your folders **and**
the rules you have taught it. **Save** updates the current one; **⋯** opens
save-as, set-default, delete, import/export and the shared profile.

A profile deliberately has two halves:

| half | what | portable? |
|---|---|---|
| **shared** | aliases and mapping rules | **yes** — the accumulated knowledge |
| **local** | Drive roots, NAS roots, manifest path | **no** — `H:\` is not `H:\` on another PC |

Set one profile as **default (★)** and it loads at startup.

### Shared profiles

Point the app at a profile on the NAS (⋯ → *Choose one…*). Whenever someone
updates it, the next launch shows what changed and offers three answers:

- **Load changes** — merge the new rules into yours
- **Keep mine** — ignore this update (it will not ask again for the same one)
- **Start fresh** — replace your rules with the shared set

**Only the shared half is ever applied.** Your Drive and NAS folder choices are
never overwritten by someone else's drive letters — that would just break the
app on your machine. *Export (rules only…)* is the safe thing to put on the NAS;
*Export with paths…* exists for cloning a setup onto an identical machine.

### Nested folders are collapsed

Choosing `H:\Shared drives` **and** the individual shared drives under it would
walk each of those twice and double every count. Nested roots are collapsed
before walking and the skipped ones are listed above the results.

## After Compare — what to actually do

Compare produces a **plan**, not a copy. The workflow is:

1. **Read the five tabs.** *Already on NAS* is the number that matters — it is
   what you would otherwise have duplicated.
2. **Fix what it got wrong.** In *New*, use **Already on NAS…** for things it
   missed, and **Set destination… → Browse…** for anything unmapped.
3. **Compare again.** Rules only take effect on a re-run.
4. **Export reports…** — writes the CSVs plus `copy-plan.bat` / `copy-plan.sh`.
5. **Run the copy plan yourself** from a terminal on the machine that can see
   both `H:` and `Z:`. It logs beside itself as `storage-mapper-copy.log`.
6. **Compare once more to verify.** Everything you copied should now appear under
   *Already on NAS*. That round trip is the proof the copy landed — not the
   absence of errors.
7. **Then, and only then**, deal with the Drive side: export the natives, and use
   Google Drive Storage Explorer to trash what is now safely on the NAS.

### Why the app does not press the button

`robocopy` is restartable, resumable, long-path safe and logs everything. A copy
engine written here would be strictly worse, and this is in some cases the only
copy of the studio's work. The plan is deliberately additive — `/XO` and
`--ignore-existing`, never `/MIR`, never `--delete` — so the worst a bad run can
do is copy something twice.

### Destinations must be absolute

`Z:\Projects\…` or `\\UIZ-NAS\Projects\…`, not `Projects\…`. A relative
destination would be created next to wherever the plan is run instead of on the
NAS. The dialog now refuses to save one, **Browse…** picks a real folder, and any
row that still lacks an absolute destination is written into the plan as a
commented skip with the reason — never as a command that would misfire.

## Copy to NAS

The **New** tab has a **Copy to NAS…** button once rows have absolute
destinations. **Dry run** first — it passes `/L`, so robocopy reports exactly
what it would do and writes nothing.

### Why not PowerShell

The destinations include `Preclinical Dental Education VR & Haptics`. `&` is a
command separator in `cmd.exe` and a special character in PowerShell, so going
through a shell means quoting it correctly forever. `robocopy.exe` is spawned
**directly with an argument array** — no shell exists in the pipeline, so
ampersands, spaces and brackets are safe by construction. Same speed, one fewer
way to fail.

### Reading the result honestly

**Robocopy's exit code is a bitmask and non-zero is usually success** — exit 1
means "files were copied". Treating non-zero as failure would report every good
copy as broken; treating any code as fine would hide a real one.

| code | meaning |
|---|---|
| 0 | nothing to do, destination already current |
| 1–7 | **success** (1 copied · 2 extra files present · 4 mismatches) |
| 8 | **FAILED** — some files could not be copied |
| 16 | **FAILED** — serious error, nothing copied |

The app reports success only for `< 8`, and names which folder failed and why.

### What it cannot do

`/MIR`, `/PURGE`, `/MOV` and `--delete` are never emitted, and `/XO` stops a
newer file on the NAS being replaced by an older one from Drive. **The copy can
only add.** Groups run one at a time — parallel jobs over a single SMB share
contend for the same link, finish no sooner, and make a partial failure much
harder to attribute.

After a successful copy, run **Compare** again: everything you copied should move
into *Already on NAS*. That round trip is the proof it landed — not the absence
of errors in the log.

## The staged flow: Compare → Map → Copy

Each stage unlocks the next, so you cannot copy something you have not said where
to put.

**Compare** finds what is new. **Map** then assigns a destination to *all* of them
in one decision — per-row mapping was fine for three files and useless at 126:

- **Confirm** — put them under the NAS folder you compared against
- **Choose a different folder…** — pick any other destination

Either way each file keeps the folder structure it has in Drive. It is **not**
merged into existing sub-folders: in the real data the trees do not line up
(Drive `Shoot_…/Pictures` vs NAS `360 Footage/Shoot_…_SRC/Pictures/Processed`),
and guessing which existing folder a file belongs in is exactly the silent
decision that creates a mess. Nothing existing is touched; file them afterwards.

**Copy** then shows every file against what is already at its destination:

| state | meaning | selected by default |
|---|---|---|
| **new** | nothing there | **yes** |
| **identical** | same name *and* same byte count | no — skipped |
| **different** | same name, different size | no — overwriting is the one irreversible move |

*Select only new* / *all* / *none*, then **Dry run** or **Copy**.

## Tracking back

**Not git.** These are multi-gigabyte video files; git (or LFS, or annex) would
cost more storage and operational pain than the problem is worth.

Two mechanisms instead, at different levels:

- **Volume rollback → QNAP snapshots.** Block-level, instant, space-efficient, and
  already provisioned on this NAS (1.1 TB reserved, currently unused). Take one
  before a large copy and the whole volume can be rolled back.
- **Per-run detail → the copy journal.** Every run — including dry runs and
  failures — is appended to `runs.jsonl`: what was copied, by whom, from which
  machine, and what the engine said per folder. **⋯ → Copy history…**

Snapshots answer *"put the volume back"*. The journal answers *"which files did
that particular run add"* — and because the copy is additive-only, that list
**is** the reversal.

## Releasing

Everything up to v0.6.0 was built on a laptop and uploaded by hand, which is why
a release that was never tagged left no trace either way. It is a workflow now:
`.github/workflows/release.yml`, triggered by pushing a `v*` tag.

```bash
# 1. bump the version FIRST — the workflow fails the build if it disagrees
npm version 0.6.1 --no-git-tag-version
git commit -am "v0.6.1 — what changed"
git push

# 2. tag; the push is what triggers the build
git tag v0.6.1 && git push origin v0.6.1
```

The workflow runs the tests, refuses to continue if the tag and `package.json`
version disagree, builds the NSIS installer, publishes it, and then prunes older
releases.

**Cleanup deletes the release and its installer but keeps the git tag.** Tags cost
nothing and are what lets you check out and rebuild an old version — deleting them
would throw that away for no space saving. It keeps the most recent release only;
change the count with the `keep` input, and run it on its own from the Actions tab
(**Release → Run workflow**) without cutting a release.

`npm run build:win` still works for a local build; it just does not produce a
release.
