/*
  Renderer. Talks to Node only through window.mapper (see preload.cjs).

  Single script, everything top level — the partials in the sibling Drive tool
  taught the lesson that a helper hidden inside an IIFE becomes a silently dead
  button, so there are no IIFEs here either.
*/

var MAPPING = { nasRoots: [], driveRoots: [], aliases: [], map: [] };
var DRIVE_ROOTS = [];
var NAS_ROOTS = [];
/* Optional: the Explorer's Convert output. Lets a native stub be copied as its
   converted equivalent, to where the ORIGINAL belonged. */
var CONV_ROOTS = [];
var MANIFEST = null;
var RESULT = null;
var DROPPED = [];
var OVERLAP = [];
var TAB = 'duplicates';
var REMAP = null;              // { mode, row, selected }
var MAX_ROWS = 1000;           // render cap; the CSV export always has everything
var PROFILE = null;            // the full profile: shared knowledge + local paths
var PROFILE_FILE = null;
var PENDING_SHARED = null;
var MAPPED = null;             // rows with destinations assigned, after the Map step
var COPY_ROWS = [];            // mapped rows classified against the destination
var SEP = '/';                 // platform separator, learned from appInfo

var $ = function (id) { return document.getElementById(id); };

/**
 * Electron does NOT implement window.prompt — Chromium there answers
 * "prompt() is and will not be supported" and returns undefined. Both profile
 * save paths asked for a name that way, so the guard below them skipped the
 * write and the first save silently did nothing every single time. Never use
 * window.prompt in this app; use this.
 */
function askText(title, hint, value) {
  return new Promise(function (resolve) {
    var dlg = $('askDlg'), input = $('askInput');
    $('askTitle').textContent = title;
    $('askHint').textContent = hint || '';
    input.value = value || '';
    var done = function (v) {
      $('askOk').removeEventListener('click', ok);
      $('askCancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', key);
      dlg.close();
      resolve(v);
    };
    var ok = function () { done(input.value.trim() || null); };
    var cancel = function () { done(null); };
    var key = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    $('askOk').addEventListener('click', ok);
    $('askCancel').addEventListener('click', cancel);
    input.addEventListener('keydown', key);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  var u = ['KB', 'MB', 'GB', 'TB', 'PB'], i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function parentOf(p) {
  var parts = String(p || '').split('/');
  parts.pop();
  return parts.join('/');
}
function baseOf(p) {
  var parts = String(p || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

// ── feature sheet ───────────────────────────────────────────────────────────
/*
  Shown once per version. `since` drives the NEW badge automatically, so the list
  is the single place a feature is described and there is no separate changelog
  to forget to update.
*/
var APP_VERSION = '';
var FEATURES = [
  { group: 'Compare', items: [
    { ico: '=', t: 'Already on NAS',
      d: 'Finds Drive files the NAS already holds — including ones RENAMED between the two, matched on checksum rather than name.' },
    { ico: '+', t: 'New, with a destination',
      d: 'What is genuinely missing, mapped into your existing project taxonomy.' },
    { ico: '!', t: 'Conflicts',
      d: 'Same name and size but different content. Never silently treated as a duplicate.' },
    { ico: 'G', t: 'Google-native stubs',
      d: 'Docs, Sheets and Slides are link stubs on disk, not documents. Flagged as export-only — copying one archives a dead link.' },
    { ico: '~', t: 'NAS-internal overlap',
      d: 'The same file already sitting in two of your NAS trees.' },
  ]},
  { group: 'Accuracy', items: [
    { ico: '#', t: 'Exact mode with a Drive manifest',
      d: 'Checksums come from the Drive API for free. Without the manifest, matching falls back to size + name and a renamed copy looks new.' },
    { ico: 'x', t: 'The Drive mount is never hashed',
      d: 'In Stream mode reading a file downloads it. Only NAS files whose size collides with a Drive file are hashed.' },
    { ico: 'v', t: 'Nested folders collapsed', since: '0.3.0',
      d: 'Choosing a folder and one inside it used to walk the inner one twice and double every count.' },
    { ico: '#', t: 'The accuracy badge no longer guesses', since: '0.6.2',
      d: 'Loading a profile claimed "Exact — md5 from Drive API" whenever a manifest path was stored, without opening the file. It now reads "Manifest set — not read yet" until Compare has actually parsed it.' },
    { ico: '!', t: 'An unusable manifest says so, loudly', since: '0.6.2',
      d: 'A CSV that parses to zero usable rows used to drop to size+name in silence. It is now flagged red with the columns it needs. Feeding this app its own new.csv report does exactly that: no bytes, md5 or drive_id column, so every row is discarded.' },
  ]},
  { group: 'Teaching it', items: [
    { ico: 'L', t: 'Already on NAS…',
      d: 'Link a file to the one it really duplicates; the two parent folders are recorded as the same project, so the rest follow.' },
    { ico: 'D', t: 'Set destination… with Browse', since: '0.3.1',
      d: 'Pick a real folder. Relative paths are refused — they would be created next to the plan instead of on the NAS.' },
    { ico: 'P', t: 'Profiles', since: '0.3.0',
      d: 'Save a whole setup and mark one default. Folders stay local; rules are portable.' },
    { ico: 'S', t: 'Shared team profile', since: '0.3.0',
      d: 'Point at a profile on the NAS. When a colleague updates it you get a diff and choose: load, keep yours, or start fresh.' },
  ]},
  { group: 'Copying', items: [
    { ico: '>', t: 'Copy to NAS', since: '0.4.0',
      d: 'Runs robocopy (rsync off Windows) from the app, in the background, with per-folder progress.' },
    { ico: 'T', t: 'Dry run first', since: '0.4.0',
      d: 'Passes /L so robocopy reports exactly what it would do and writes nothing.' },
    { ico: 'OK', t: 'An honest verdict', since: '0.4.0',
      d: 'Robocopy exit codes are a bitmask where non-zero is usually success (1 = files copied). Success is under 8; failures name the folder and reason.' },
    { ico: 'V', t: 'Copy button on every tab', since: '0.4.1',
      d: 'It used to live only on the New tab, which made the feature look missing from anywhere else.' },
    { ico: '#', t: 'Version shown in the header', since: '0.4.1',
      d: 'So "the feature is missing" and "you are on an older build" stop looking identical.' },
    { ico: 'M', t: 'Map, then Copy', since: '0.5.0',
      d: 'One decision assigns a destination to every new file. Copy stays locked until you have.' },
    { ico: 'R', t: 'Copy review', since: '0.5.0',
      d: 'Incoming against existing. Same name and byte count is skipped; a size mismatch is never overwritten by default.' },
    { ico: 'H', t: 'Copy history', since: '0.5.0',
      d: 'Every run journalled — what, by whom, and the engine verdict per folder. Volume rollback is QNAP snapshots; this is the per-run detail.' },
    { ico: '⇄', t: 'Per-source mapping with arrows', since: '0.6.0',
      d: 'Each Google Drive folder is paired with its OWN NAS folder and the arrows are shown. One shared destination would have flattened separate project trees into a single folder.' },
    { ico: '⚠', t: 'Same folder in both lists is refused', since: '0.6.0',
      d: 'A path in the Drive AND NAS lists compares a tree with itself — everything reads as already on the NAS. Compare now stops and says which one.' },
    { ico: '!', t: 'Profile saving fixed', since: '0.5.1',
      d: 'Electron does not implement window.prompt, so asking for a profile name returned nothing and the save was silently skipped. It now uses a real dialog and confirms the file it wrote.' },
    { ico: '⚠', t: 'Both-sides folder flagged as you load it', since: '0.6.1',
      d: 'A folder listed as both Drive and NAS is now outlined in red the moment the lists are drawn, so a profile saved with the mistake says so on load instead of failing several clicks later at Compare.' },
    { ico: '¶', t: 'Comparison errors are readable', since: '0.6.1',
      d: 'The failure message was laid out with newlines and bullets, then dropped into centred HTML where they collapsed into one run-on line. It also restated its own heading. Both fixed.' },
    { ico: '⚙', t: 'Releases are built by CI', since: '0.6.1',
      d: 'Pushing a v* tag builds, tests, refuses to continue if the tag and package.json disagree, publishes, and prunes older releases while keeping their git tags. Every build up to 0.6.0 was made on a laptop by hand.' },
  ]},
];

function renderSplash() {
  var cur = APP_VERSION;
  $('splashVer').textContent = 'v' + cur;
  var newCount = 0;
  var html = FEATURES.map(function (g) {
    return '<div class="fgroup"><h3>' + esc(g.group) + '</h3>' + g.items.map(function (f) {
      var isNew = f.since && f.since === cur;
      if (isNew) newCount++;
      return '<div class="frow"><span class="ico">' + esc(f.ico) + '</span>' +
        '<span class="txt"><b>' + esc(f.t) + '</b> — <small>' + esc(f.d) + '</small></span>' +
        (isNew ? '<span class="newtag">NEW</span>' : '') + '</div>';
    }).join('') + '</div>';
  }).join('');

  $('splashBody').innerHTML =
    '<div class="safetybar"><b>It cannot delete anything.</b> Compare only reads. The copy adds ' +
    'files and never overwrites a newer one — <code>/MIR</code>, <code>/PURGE</code> and ' +
    '<code>--delete</code> are never used.</div>' +
    (newCount ? '<div class="note"><b>' + newCount + ' new in v' + esc(cur) + '</b> — marked below.</div>' : '') +
    html;
}

function openSplash() { renderSplash(); $('splashDlg').showModal(); }

// ── profiles ────────────────────────────────────────────────────────────────
/*
  A profile has two halves and they are treated very differently:

    shared — aliases and mapping rules. Portable, and the part worth sharing:
             the accumulated knowledge of which folders are the same project.
    local  — drive roots, NAS roots, manifest. Absolute paths, machine-bound.
             H:\ on one PC is not H:\ on another and is nothing on a Mac.

  So applying a shared profile merges the knowledge and never touches your paths.
*/
function blankProfile(name) {
  return {
    schema: 1, name: name || 'Default', updatedAt: null, updatedBy: null,
    shared: { aliases: [], map: [] },
    local: { driveRoots: [], nasRoots: [], manifestPath: null },
  };
}

function profileFromUi() {
  var p = PROFILE || blankProfile();
  p.local = { driveRoots: DRIVE_ROOTS.slice(), nasRoots: NAS_ROOTS.slice(), manifestPath: MANIFEST };
  p.shared = { aliases: MAPPING.aliases || [], map: MAPPING.map || [] };
  return p;
}

function applyProfileToUi(p) {
  PROFILE = p || blankProfile();
  MAPPING = {
    aliases: (PROFILE.shared && PROFILE.shared.aliases) || [],
    map: (PROFILE.shared && PROFILE.shared.map) || [],
    nasRoots: [], driveRoots: [],
  };
  DRIVE_ROOTS = ((PROFILE.local && PROFILE.local.driveRoots) || []).slice();
  NAS_ROOTS = ((PROFILE.local && PROFILE.local.nasRoots) || []).slice();
  MANIFEST = (PROFILE.local && PROFILE.local.manifestPath) || null;
  // NOT 'exact'. A stored manifest path says a file was chosen once, not that it
  // is usable — and claiming exact here is how a run that silently matched on
  // size+name displayed "Exact — md5 from Drive API" the whole way through.
  // Only Compare can know, because only Compare parses the file.
  if (MANIFEST) setAccuracy('pending', null, MANIFEST);
  else setAccuracy('approximate', null);
  renderPaths();
}

async function refreshProfileList() {
  var list = await window.mapper.profilesList();
  var sel = $('profileSel');
  sel.innerHTML = '<option value="">(unsaved)</option>' + list.map(function (p) {
    return '<option value="' + esc(p.file) + '"' + (p.file === PROFILE_FILE ? ' selected' : '') +
      '>' + esc(p.name) + (p.isDefault ? ' ★' : '') + '</option>';
  }).join('');
  return list;
}

async function saveProfile(name) {
  var p = profileFromUi();
  if (name) p.name = name;
  var r = await window.mapper.profilesSave(p);
  PROFILE = r.profile; PROFILE_FILE = r.file;
  await refreshProfileList();
  return r;
}

/** Merge only the portable half. Local paths are deliberately untouched. */
function mergeShared(incoming) {
  var key = function (x) { return JSON.stringify(x); };
  var have = new Set((MAPPING.aliases || []).map(key));
  (incoming.aliases || []).forEach(function (x) {
    if (!have.has(key(x))) { MAPPING.aliases.push(x); have.add(key(x)); }
  });
  var haveMap = new Set((MAPPING.map || []).map(function (m) { return m.drive + '=>' + m.nas; }));
  (incoming.map || []).forEach(function (m) {
    if (!haveMap.has(m.drive + '=>' + m.nas)) { MAPPING.map.push(m); }
  });
}

function showSharedDialog(sh) {
  PENDING_SHARED = sh;
  $('sharedHint').innerHTML =
    '<b>' + esc(sh.name || 'Shared profile') + '</b> was updated ' +
    esc(sh.updatedAt ? new Date(sh.updatedAt).toLocaleString() : '') +
    (sh.updatedBy ? ' by ' + esc(sh.updatedBy) : '') + '.';
  var rows = []
    .concat((sh.added.aliases || []).map(function (a) {
      return '<div class="row">alias &nbsp;<b>' + esc(a[0]) + '</b> ≡ <b>' + esc(a[1]) + '</b></div>';
    }))
    .concat((sh.added.map || []).map(function (m) {
      return '<div class="row">rule &nbsp;<b>' + esc(m.drive) + '</b><small>→ ' + esc(m.nas) + '</small></div>';
    }));
  $('sharedDiff').innerHTML = rows.length ? rows.join('')
    : '<div class="empty">No new rules — only formatting or ordering changed.</div>';
  $('sharedDlg').showModal();
}

async function sharedDecision(mode) {
  var sh = PENDING_SHARED;
  $('sharedDlg').close();
  if (!sh) return;
  if (mode === 'apply') mergeShared(sh.incoming);
  else if (mode === 'fresh') { MAPPING.aliases = (sh.incoming.aliases || []).slice(); MAPPING.map = (sh.incoming.map || []).slice(); }
  // 'keep' leaves MAPPING alone.
  // Either way record the hash, so the same update is not offered again.
  await window.mapper.profilesSharedApplied(sh.hash, sh.incoming);
  PENDING_SHARED = null;
  if (mode !== 'keep') {
    $('main').insertAdjacentHTML('afterbegin',
      '<div class="note"><b>Shared rules ' + (mode === 'fresh' ? 'replaced yours' : 'merged') +
      '.</b> Hit Compare to apply them. Save the profile to keep them.</div>');
  }
}

async function openProfileMenu() {
  var list = await refreshProfileList();
  var settings = await window.mapper.profilesSettings();
  $('profHint').innerHTML =
    'Profiles remember your folders <i>and</i> the rules you have taught it. ' +
    'A <b>shared profile</b> lives on the NAS so the team gets each other\'s rules.';
  var shared = settings.sharedProfilePath
    ? '<div class="note">Watching <b>' + esc(settings.sharedProfilePath) + '</b> for updates. ' +
      '<button class="btn sm" id="pmUnshare">Stop watching</button></div>'
    : '<div class="note">No shared profile configured. ' +
      '<button class="btn sm" id="pmShare">Choose one…</button></div>';
  $('profBody').innerHTML =
    (list.length ? list.map(function (p) {
      return '<div class="profrow"><span class="nm">' + esc(p.name) +
        (p.isDefault ? ' <span class="star" title="loads at startup">★</span>' : '') +
        '<small>' + p.counts.aliases + ' aliases · ' + p.counts.map + ' rules · ' +
        p.counts.driveRoots + ' Drive · ' + p.counts.nasRoots + ' NAS · ' +
        esc(p.updatedBy || '') + '</small></span>' +
        '<button class="btn sm" data-act="load" data-f="' + esc(p.file) + '">Load</button>' +
        '<button class="btn sm" data-act="default" data-f="' + esc(p.file) + '">Set default</button>' +
        '<button class="btn sm" data-act="del" data-f="' + esc(p.file) + '">Delete</button></div>';
    }).join('') : '<div class="empty">No saved profiles yet.</div>') +
    shared +
    '<div class="dlgfoot" style="justify-content:flex-start;margin-top:10px">' +
      '<button class="btn" id="pmSaveAs">Save as…</button>' +
      '<button class="btn" id="pmExport">Export (rules only)…</button>' +
      '<button class="btn" id="pmExportAll">Export with paths…</button>' +
      '<button class="btn" id="pmImport">Import…</button>' +
      '<button class="btn" id="pmHistory">Copy history…</button>' +
    '</div>';

  $('profBody').querySelectorAll('button[data-act]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var f = b.dataset.f;
      if (b.dataset.act === 'load') { applyProfileToUi(await window.mapper.profilesLoad(f)); PROFILE_FILE = f; $('profDlg').close(); }
      else if (b.dataset.act === 'default') { await window.mapper.profilesSetDefault(f); openProfileMenu(); }
      else if (b.dataset.act === 'del') { await window.mapper.profilesDelete(f); if (PROFILE_FILE === f) PROFILE_FILE = null; openProfileMenu(); }
      await refreshProfileList();
    });
  });
  var on = function (id, fn) { var el = $(id) || document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('pmSaveAs', async function () {
    var n = await askText('Save profile as', 'A name for this set of folders and rules.',
      (PROFILE && PROFILE.name) || 'Default');
    if (n) { await saveProfile(n); openProfileMenu(); }
  });
  on('pmExport', async function () { await window.mapper.profilesExport(profileFromUi(), false); });
  on('pmExportAll', async function () { await window.mapper.profilesExport(profileFromUi(), true); });
  on('pmImport', async function () {
    var r = await window.mapper.profilesImport();
    if (r && r.ok) {
      // Merge the rules; do not import someone else's drive letters silently.
      mergeShared(r.profile.shared || {});
      $('profDlg').close();
      $('main').insertAdjacentHTML('afterbegin',
        '<div class="note"><b>Imported rules from ' + esc(r.profile.name || 'profile') +
        '.</b> Folder paths were not imported — they are specific to each machine.</div>');
    }
  });
  on('pmShare', async function () {
    var r = await window.mapper.profilesSetShared('pick');
    if (r && r.ok) { $('profDlg').close(); if (r.shared && r.shared.status === 'updated') showSharedDialog(r.shared); }
  });
  on('pmUnshare', async function () { await window.mapper.profilesSetShared(null); openProfileMenu(); });
  on('pmHistory', async function () {
    var runs = await window.mapper.journalRead(50);
    $('profTitle').textContent = 'Copy history';
    $('profHint').innerHTML =
      'Every run is recorded — what was copied, by whom, and what the engine said. ' +
      'For rolling a whole volume back, use a <b>QNAP snapshot</b>; this list is what ' +
      'makes reversing one specific run precise.';
    $('profBody').innerHTML = runs.length ? runs.map(function (r) {
      var when = new Date(r.at).toLocaleString();
      return '<div class="profrow"><span class="nm">' +
        (r.dryRun ? '<span class="statetag identical">dry run</span> ' : '') +
        '<b>' + (r.ok ? '✓' : '✗') + ' ' + esc(when) + '</b> — ' +
        (r.files || []).length + ' file(s), ' + fmtBytes(r.bytes || 0) +
        '<small>' + esc(r.by || '') + ' · ' + esc(r.engine || '') +
        (r.failed ? ' · ' + r.failed + ' folder(s) failed' : '') + '</small></span></div>';
    }).join('') : '<div class="empty">No copies have been run yet.</div>';
    $('profDlg').showModal();
  });

  $('profDlg').showModal();
}

// ── setup ───────────────────────────────────────────────────────────────────
/*
  Pre-flight mirror of crossOverlap() in src/mapplan.mjs.

  Deliberately duplicated rather than reached over IPC: this runs on every
  keystroke-free redraw of the two lists and only ever changes a hint. The worker
  copy stays AUTHORITATIVE — this one warns, it does not block, so if the two
  ever drift the worst case is a missing or spurious hint and Compare still
  refuses correctly. Keep the normalisation identical: forward slashes, no
  trailing slash, lowercased (Windows paths differ only in case all the time).
*/
function normRoot(p) {
  var s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return SEP === '\\' ? s.toLowerCase() : s;
}
function clashingRoots() {
  var out = { drive: {}, nas: {}, pairs: [] };
  DRIVE_ROOTS.forEach(function (d, di) {
    NAS_ROOTS.forEach(function (n, ni) {
      var nd = normRoot(d), nn = normRoot(n), how = null;
      if (nd === nn) how = 'the same folder is on both sides';
      else if (nd.indexOf(nn + '/') === 0) how = 'the Drive folder is inside the NAS folder';
      else if (nn.indexOf(nd + '/') === 0) how = 'the NAS folder is inside the Drive folder';
      if (how) { out.drive[di] = 1; out.nas[ni] = 1; out.pairs.push({ drive: d, nas: n, how: how }); }
    });
  });
  return out;
}

function renderPaths() {
  var clash = clashingRoots();
  var draw = function (el, list, kind, flagged) {
    el.innerHTML = list.map(function (p, i) {
      return '<span class="chip' + (flagged[i] ? ' bad' : '') + '">' +
        '<code title="' + esc(p) + (flagged[i] ? ' — also on the other side' : '') + '">' +
        esc(p) + '</code>' +
        '<button data-kind="' + kind + '" data-i="' + i + '" title="Remove">×</button></span>';
    }).join('');
  };
  draw($('drivePaths'), DRIVE_ROOTS, 'drive', clash.drive);
  draw($('nasPaths'), NAS_ROOTS, 'nas', clash.nas);
  draw($('convPaths'), CONV_ROOTS, 'conv', []);
  document.querySelectorAll('.paths .chip button').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = Number(b.dataset.i);
      if (b.dataset.kind === 'drive') DRIVE_ROOTS.splice(i, 1);
      else if (b.dataset.kind === 'conv') CONV_ROOTS.splice(i, 1);
      else NAS_ROOTS.splice(i, 1);
      renderPaths();
    });
  });
  $('btnCompare').disabled = !(DRIVE_ROOTS.length && NAS_ROOTS.length);
  // Scan needs only a source. That is the whole point of it.
  $('btnScan').disabled = !DRIVE_ROOTS.length;

  // Say it here, at the moment the lists are drawn, rather than only when
  // Compare fails several clicks later. Loading a saved profile redraws through
  // this path, so a profile that was saved with the mistake announces it on load.
  var hint = $('setupHint');
  if (clash.pairs.length) {
    hint.className = 'hint bad';
    hint.textContent = (clash.pairs.length === 1 ? 'One folder is' : clash.pairs.length + ' folders are') +
      ' on both sides — ' + clash.pairs[0].how + ': ' + clash.pairs[0].drive +
      '. Compare will refuse until it is removed from one side.';
  } else {
    hint.className = 'hint';
    hint.textContent = DRIVE_ROOTS.length && NAS_ROOTS.length
      ? 'Nothing will be copied — Compare only produces a plan.'
      : DRIVE_ROOTS.length
        ? 'No NAS folder yet — Scan only will index the Drive side so you can map and export a manifest.'
        : 'Choose a Google Drive folder. A NAS folder is only needed to compare.';
  }
}

function setAccuracy(mode, stats, path) {
  var badge = $('accBadge'), text = $('accText');
  if (mode === 'exact') {
    badge.className = 'badge exact';
    badge.textContent = 'Exact — md5 from Drive API';
    text.textContent = stats
      ? stats.withMd5.toLocaleString() + ' of ' + stats.count.toLocaleString() +
        ' manifest rows carry a checksum. Renamed copies will still be detected.'
      : 'Checksums loaded.';
  } else if (mode === 'pending') {
    // A path is set but nothing has parsed it yet. Say exactly that.
    badge.className = 'badge approx';
    badge.textContent = 'Manifest set — not read yet';
    text.textContent = (path || '') + ' — run Compare to check it.';
  } else if (mode === 'unusable') {
    /*
      The file parsed but yielded nothing this tool can match on. Loud, because
      the failure is invisible otherwise: matching silently drops to size+name,
      and size+name matches a template or a generated artefact across unrelated
      projects. Seen in the field: storage-mapper's OWN new.csv report was loaded
      as the manifest — its columns are drivePath,name,size,... so `bytes`, `md5`
      and `drive_id` were all absent and every row was discarded.
    */
    badge.className = 'badge bad';
    badge.textContent = 'Manifest unusable — falling back to size + name';
    text.innerHTML = 'Read <b>0</b> usable rows from ' + esc(path || 'the CSV') +
      '. Needs the <code>bytes</code> and <code>md5</code> columns — export ' +
      '<b>studiodrive-manifest.csv</b> from Storage Explorer (<i>Export manifest CSV</i>), ' +
      'not a report this app wrote.';
  } else if (mode === 'no-md5') {
    badge.className = 'badge approx';
    badge.textContent = 'Approximate — manifest has no md5 column';
    text.textContent = 'Re-export the CSV from Storage Explorer; it now includes md5.';
  } else {
    badge.className = 'badge approx';
    badge.textContent = 'Approximate — size + name';
    text.textContent = 'No manifest loaded. Renamed-but-identical files will look new.';
  }
}

// ── compare ─────────────────────────────────────────────────────────────────
/*
 * #emptyState is a CHILD of #main, and both renderTab() and the two failure
 * paths replace #main's innerHTML wholesale — so the element stops existing the
 * moment anything has been rendered.
 *
 * Referring to it directly therefore worked exactly once per session. The
 * second run threw "Cannot set properties of null" on the FOURTH line of
 * runScan, before the try block, which left the window in the state the first
 * three lines had just put it in: bar showing "Starting…", Scan and Compare
 * both disabled, no error anywhere. Reported as "scan only broke", and it did —
 * reliably, after any successful comparison.
 */
function hideEmptyState() {
  var e = $('emptyState');
  if (e) e.hidden = true;
}

async function runCompare() {
  $('btnCompare').disabled = true;
  $('bar').hidden = false;
  $('barFill').style.width = '5%';
  $('barText').textContent = 'Starting…';
  hideEmptyState();

  MAPPING.driveRoots = [];
  MAPPING.nasRoots = [];

  // Same `finally` contract as runScan — see the note there.
  var res;
  try {
    res = await window.mapper.compare({
      driveRoots: DRIVE_ROOTS, nasRoots: NAS_ROOTS, convertedRoots: CONV_ROOTS,
      manifestPath: MANIFEST, mapping: MAPPING,
    });
  } catch (e) {
    res = { type: 'error', message: 'The comparison could not be started.\n\n' + (e && e.message || e) };
  } finally {
    $('bar').hidden = true;
    renderPaths();
  }

  if (res.type === 'error') {
    // pre-wrap, because these messages are laid out with newlines and indented
    // bullets. Dropped into centred HTML they collapsed into one run-on line and
    // the per-folder detail became unreadable.
    $('main').innerHTML = '<div class="empty"><b>Comparison failed</b>' +
      '<pre class="errmsg">' + esc(res.message) + '</pre></div>';
    /*
      Reset the stage. These used to be left alone on the failure path, so after
      a compare that failed the buttons still pointed at the PREVIOUS run: Export
      stayed lit and quietly wrote the older result's CSVs, and Map still offered
      rows that no longer had a comparison behind them. Stale-but-lit is worse
      than dark, because nothing on screen says which run you are looking at.
    */
    RESULT = null; MAPPED = null; OVERLAP = []; SCANNED = false; CONFLICT_PICKS = {};
    $('btnExport').disabled = true;
    syncStageButtons();
    return;
  }

  RESULT = res.result;
  CONFLICT_PICKS = {};   // choices belong to the run that raised the conflicts
  OVERLAP = res.overlap || [];
  SCANNED = false;
  setAccuracy(res.accuracy, res.manifestStats, MANIFEST);
  DROPPED = res.droppedRoots || [];
  $('btnExport').disabled = false;
  MAPPED = null;
  renderCounts();
  syncStageButtons();
  renderTab();
}

var SCANNED = false;

/**
 * Index the Drive side alone — for a destination that does not exist yet.
 *
 * Everything comes back as "new", which is not a shortcut: it is the same answer
 * a comparison against an empty folder produces, arrived at without walking a
 * tree that is not there. Map and the manifest export both open from here.
 */
/*
 * The bar and the two buttons are restored in a `finally`.
 *
 * They used to be restored on the line after the await, which meant ANY failure
 * of that promise — a rejected invoke, a worker that never answers, an
 * exception in main — left the window in the state it was put into before the
 * call: progress bar frozen at "Starting…", Scan and Compare both disabled, and
 * nothing on screen saying why. Unrecoverable without restarting the app, and
 * indistinguishable from "still working". Reported from the field exactly so.
 */
async function runScan() {
  $('btnScan').disabled = true;
  $('btnCompare').disabled = true;
  $('bar').hidden = false;
  $('barFill').style.width = '5%';
  $('barText').textContent = 'Starting…';
  hideEmptyState();

  MAPPING.driveRoots = [];
  MAPPING.nasRoots = [];

  var res;
  try {
    res = await window.mapper.scan({
      driveRoots: DRIVE_ROOTS, nasRoots: NAS_ROOTS, mapping: MAPPING,
    });
  } catch (e) {
    res = { type: 'error', message: 'The scan could not be started.\n\n' + (e && e.message || e) };
  } finally {
    $('bar').hidden = true;
    renderPaths();   // re-enables whichever buttons the current roots allow
  }

  if (res.type === 'error') {
    $('main').innerHTML = '<div class="empty"><b>Scan failed</b>' +
      '<pre class="errmsg">' + esc(res.message) + '</pre></div>';
    RESULT = null; MAPPED = null; SCANNED = false; CONFLICT_PICKS = {};
    $('btnExport').disabled = true;
    syncStageButtons();
    return;
  }

  RESULT = res.result;
  CONFLICT_PICKS = {};   // choices belong to the run that raised the conflicts
  OVERLAP = [];
  SCANNED = true;
  DROPPED = res.droppedRoots || [];
  MAPPED = null;
  setAccuracy('scan', null, MANIFEST);
  $('btnExport').disabled = false;
  renderCounts();
  syncStageButtons();
  renderTab();
  noteScan(res);
}

/*
 * Say plainly that this was not a comparison.
 *
 * A scan cannot know whether a file is already at the destination, so calling
 * everything "new" is only honest while the user remembers no comparison
 * happened. If a NAS folder IS set and does have content, say so — that is the
 * case where scanning is the wrong tool and Compare is right there.
 */
function noteScan(res) {
  var probes = res.nasProbes || [];
  var populated = probes.filter(function (p) { return p.exists && p.readable && !p.empty; });
  var msg = '<div class="warn"><b>Scanned, not compared.</b> Every file is listed as new ' +
    'because nothing was checked against a destination.';
  if (populated.length) {
    msg += ' <b>' + populated.length + ' NAS folder(s) already contain files</b> — run ' +
      '<i>Compare</i> instead, or copies you already made will be listed again.';
  } else if (probes.length) {
    msg += ' The NAS folder(s) you chose are empty, so this matches what a comparison would say.';
  }
  msg += '</div>';
  $('main').insertAdjacentHTML('afterbegin', msg);
}

/**
 * The Copy button lives in the header so it is reachable from every tab. It was
 * originally only on the New tab, which made it look like the feature did not
 * exist unless you happened to be standing on the right tab.
 */
function syncCopyButton() { syncStageButtons(); }

function renderCounts() {
  if (!RESULT) return;
  $('nDup').textContent = RESULT.duplicates.length.toLocaleString();
  $('nNew').textContent = RESULT.new.length.toLocaleString();
  $('nCon').textContent = RESULT.conflicts.length.toLocaleString();
  $('nNat').textContent = RESULT.natives.length.toLocaleString();
  $('nOver').textContent = OVERLAP.length.toLocaleString();
}

// ── tables ──────────────────────────────────────────────────────────────────
function table(head, rows, rowFn) {
  if (!rows.length) return '<div class="empty">Nothing in this category.</div>';
  var shown = rows.slice(0, MAX_ROWS);
  var more = rows.length > MAX_ROWS
    ? '<div class="empty">Showing the first ' + MAX_ROWS.toLocaleString() + ' of ' +
      rows.length.toLocaleString() + '. Export the reports for the full list.</div>'
    : '';
  return '<table><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
    '</tr></thead><tbody>' + shown.map(rowFn).join('') + '</tbody></table>' + more;
}

function droppedNote() {
  if (!DROPPED.length) return '';
  return '<div class="warn"><b>' + DROPPED.length + ' folder(s) skipped as already covered.</b> ' +
    'Choosing a folder <i>and</i> one inside it would walk the inner one twice and ' +
    'double every count.<br>' +
    DROPPED.map(function (d) {
      return '· <code>' + esc(d.root) + '</code>' + (d.insideOf ? ' is inside <code>' + esc(d.insideOf) + '</code>' : '');
    }).join('<br>') + '</div>';
}

/**
 * Check the skip decisions.
 *
 * A duplicate that turns out to be a different file is not a duplicate: it was
 * never on the NAS, so it moves into the new list and becomes copyable. That is
 * the point of doing this at all — a wrong "already there" is the only verdict
 * in the tool that loses a file silently, and it is also what leaves Map greyed
 * out with nothing to do.
 *
 * Reads the NAS side only. The Drive side has its md5 from the manifest, and
 * reading it would make Drive for Desktop materialise the whole mount.
 */
async function verifyDuplicates() {
  var rows = RESULT.duplicates.filter(function (r) { return r.md5 && r.nasPath; });
  if (!rows.length) return;

  $('bar').hidden = false;
  $('barFill').style.width = '5%';
  $('barText').textContent = 'Verifying ' + rows.length.toLocaleString() + ' matches…';

  var res;
  try {
    res = await window.mapper.verifyDest(rows.map(function (r) {
      return { verifyPath: r.nasPath, md5: r.md5, size: r.size, name: r.name };
    }));
  } catch (e) {
    res = null;
  } finally {
    $('bar').hidden = true;
  }
  if (!res) return;

  var v = res.verdicts || {};
  var moved = [];
  RESULT.duplicates = RESULT.duplicates.filter(function (r) {
    var verdict = v[r.nasPath];
    if (verdict === 'differs') {
      // Not the same file. Put it back where it belongs, with a destination so
      // it can actually be copied rather than just re-flagged.
      var dest = destForDrivePath(r.drivePath);
      moved.push({
        drivePath: r.drivePath, name: r.name, size: r.size, md5: r.md5,
        driveRoot: r.driveRoot || '', driveAbs: r.driveAbs || '',
        proposedNas: dest ? dest.nas : '', mappedBy: dest ? dest.rule : '(unmapped)',
        wasCalledDuplicate: r.nasPath,
      });
      return false;
    }
    if (verdict) r.verified = verdict === 'same' ? 'same' : 'unreadable';
    return true;
  });

  if (moved.length) {
    RESULT.new = RESULT.new.concat(moved);
    MAPPED = null;   // the plan predates these rows
  }
  renderCounts();
  syncStageButtons();
  renderTab();

  if (moved.length) {
    window.alert(moved.length + ' file(s) matched on name and size but are NOT the same file.\n\n' +
      'They were going to be skipped. They have been moved to New so they can be copied.');
  }
}

/**
 * Re-derive a destination for a row that has just become copyable. Uses the
 * same mapping the comparison used, so a rescued file lands where it would have
 * landed had it been called new in the first place.
 */
function destForDrivePath(drivePath) {
  var rule = (MAPPING.map || []).find(function (x) {
    return x.drive && String(drivePath).indexOf(x.drive) === 0;
  });
  if (rule) {
    var tail = String(drivePath).slice(rule.drive.length).replace(/^[\\/]+/, '');
    return { nas: joinPath(rule.nas, tail), rule: rule.drive + ' → ' + rule.nas };
  }
  if (NAS_ROOTS.length === 1) {
    return { nas: joinPath(NAS_ROOTS[0], drivePath), rule: 'mirror' };
  }
  return null;
}

function joinPath(a, b) {
  var sep = String(a).indexOf('\\') !== -1 ? '\\' : '/';
  return String(a).replace(/[\\/]+$/, '') + sep + String(b).split('/').join(sep);
}

function renderTab() {
  var m = $('main');
  if (!RESULT) return;

  if (TAB === 'duplicates') {
    /*
     * Every row here is a decision NOT to copy something, and on the fast path
     * that decision rests on a name and a byte count. This is also why Map goes
     * grey: a file called a duplicate never reaches the new list. So the check
     * is offered exactly where the claim is made, on the files it is made about.
     */
    var checkable = RESULT.duplicates.filter(function (r) { return r.md5 && r.nasPath; });
    var unproven = RESULT.duplicates.filter(function (r) {
      return r.verified !== 'same' && r.tier && r.tier.indexOf('md5') === -1;
    });
    m.innerHTML = droppedNote() +
      (RESULT.duplicates.length
        ? '<div class="note" style="display:flex;align-items:center;gap:10px">' +
            '<span style="flex:1">' +
              (unproven.length
                ? '<b>' + unproven.length.toLocaleString() + '</b> of these are matched on name and ' +
                  'size only — not verified. Each one is a file that will NOT be copied.' +
                  (checkable.length
                    ? ''
                    : ' <i>Load a Drive manifest to be able to check them.</i>')
                : 'Every match here was verified byte for byte.') +
            '</span>' +
            (checkable.length
              ? '<button class="btn" id="btnVerifyDups">Verify ' +
                checkable.length.toLocaleString() + ' against the manifest…</button>'
              : '') +
          '</div>'
        : '') +
      table(['Drive file', 'Already on NAS at', 'Size', 'Matched by'],
      RESULT.duplicates, function (r) {
        var weak = r.tier && r.tier.indexOf('md5') === -1 && r.verified !== 'same';
        var label = r.verified === 'same' ? 'verified byte for byte'
          : r.verified === 'unreadable' ? r.tier + ' — could not read to verify'
          : r.tier;
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + esc(r.nasPath) + '</td>' +
          '<td class="num">' + fmtBytes(r.size) + '</td>' +
          '<td><span class="tier ' + (weak ? 'weak' : 'md5') + '">' + esc(label) + '</span></td></tr>';
      });
    var vb = $('btnVerifyDups');
    if (vb) vb.addEventListener('click', verifyDuplicates);
  } else if (TAB === 'new') {
    var ready = RESULT.new.filter(function (r) { return r.proposedNas && isAbsoluteDest(r.proposedNas); });
    var readyBytes = ready.reduce(function (a, r) { return a + r.size; }, 0);
    m.innerHTML = droppedNote() +
      '<div class="note" style="display:flex;align-items:center;gap:10px">' +
        '<span style="flex:1"><b>' + ready.length.toLocaleString() + ' of ' +
        RESULT.new.length.toLocaleString() + '</b> new file(s) have a destination and are ready to copy · ' +
        fmtBytes(readyBytes) +
        (ready.length < RESULT.new.length
          ? ' — the rest need <i>Set destination…</i> first and will be skipped'
          : '') + '</span>' +
        '<button class="btn" id="btnCopyOpen"' + (ready.length ? '' : ' disabled') + '>Copy to NAS…</button>' +
      '</div>' +
      table(['Drive file', 'Proposed NAS destination', 'Size', ''],
      RESULT.new, function (r, i) {
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + (r.proposedNas
            ? esc(r.proposedNas) + '<small>rule: ' + esc(r.mappedBy) + '</small>'
            : '<i style="color:var(--muted)">no mapping rule</i>') + '</td>' +
          '<td class="num">' + fmtBytes(r.size) + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn sm" data-act="dest" data-i="' + i + '">Set destination…</button> ' +
            '<button class="btn sm" data-act="link" data-i="' + i + '">Already on NAS…</button>' +
          '</td></tr>';
      });
    m.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        openRemap(b.dataset.act, RESULT.new[Number(b.dataset.i)]);
      });
    });
    var openBtn = $('btnCopyOpen');
    if (openBtn) openBtn.addEventListener('click', openCopy);
  } else if (TAB === 'conflicts') {
    var picked = electedConflictRows().length;
    m.innerHTML = droppedNote() +
      (RESULT.conflicts.length
        ? '<div class="note"><b>A file that exists on both sides and differs.</b> ' +
          'Usually one that was updated in Drive after it was copied. The tool cannot ' +
          'know which version you want, so it does nothing until you say.' +
          '<br><b>Copy alongside</b> writes the Drive version next to the NAS one as ' +
          '<i>name (from Drive).ext</i> — nothing is overwritten and you reconcile later. ' +
          '<b>Replace</b> writes over the NAS file.' +
          (picked ? ' <b>' + picked + ' selected — they are included in Map and Copy.</b>' : '') +
          '</div>'
        : '') +
      table(['Drive file', 'NAS file', 'Drive size', 'NAS size', 'Why', 'What to do'],
      RESULT.conflicts, function (r, i) {
        var mode = CONFLICT_PICKS[r.drivePath] || '';
        var opt = function (v, label) {
          return '<option value="' + v + '"' + (mode === v ? ' selected' : '') + '>' + label + '</option>';
        };
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + esc(r.nasPath) + '</td>' +
          '<td class="num">' + fmtBytes(r.driveSize) + '</td>' +
          '<td class="num">' + fmtBytes(r.nasSize) + '</td>' +
          '<td>' + esc(r.reason) + '</td>' +
          '<td><select data-conf="' + i + '">' +
            opt('', 'Leave it') +
            opt('alongside', 'Copy alongside') +
            opt('replace', 'Replace the NAS file') +
          '</select></td></tr>';
      });
    m.querySelectorAll('select[data-conf]').forEach(function (s) {
      s.addEventListener('change', function () {
        var row = RESULT.conflicts[Number(s.dataset.conf)];
        if (s.value) CONFLICT_PICKS[row.drivePath] = s.value;
        else delete CONFLICT_PICKS[row.drivePath];
        // A choice changes what the plan contains, so any existing plan is stale.
        MAPPED = null;
        renderCounts();
        syncStageButtons();
        renderTab();
      });
    });
  } else if (TAB === 'natives') {
    var resolved = RESULT.natives.filter(function (n) { return n.resolved; }).length;
    var unresolved = RESULT.natives.length - resolved;
    m.innerHTML = droppedNote() +
      '<div class="note"><b>A stub is not a file.</b> Google Drive for Desktop stores a ' +
      'Doc, Sheet or Slide as a few hundred bytes of JSON holding a URL — copying one ' +
      'archives a dead link.' +
      /*
       * The tab used to stop at "these cannot be copied", which stopped being
       * true once the Explorer could convert them. Left as it was, 118 stubs
       * looked like a dead end when the files to copy in their place may
       * already exist — the app just had not been told where.
       */
      (resolved
        ? '<br><b>' + resolved.toLocaleString() + '</b> of these have a converted file and ' +
          'ARE being copied, to where the original belonged.'
        : '') +
      (unresolved
        ? '<br><b>' + unresolved.toLocaleString() + '</b> have no converted file yet. ' +
          (CONV_ROOTS.length
            ? 'Nothing in the converted folder matches them by name — convert them in the ' +
              'Storage Explorer first, then compare again.'
            : 'Convert them in the Storage Explorer, then point <i>Converted files</i> at ' +
              '<code>My Drive/_Converted for NAS</code> and compare again — they become ' +
              'ordinary copies.') +
          ' <button class="btn sm" id="btnConvHere">Choose the converted folder…</button>'
        : '') +
      '</div>' +
      table(['Drive file', 'Type', 'Must be exported as', 'Status'],
        RESULT.natives, function (r) {
          return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
            '<td>' + esc(r.kind) + '</td>' +
            '<td>' + (r.exportAs ? '.' + esc(r.exportAs)
              : '<span style="color:var(--critical)">no export path — must stay in Drive</span>') + '</td>' +
            '<td>' + (r.resolved
              ? '<span class="tier md5">' + esc(r.convertedAs || 'converted') + ' will be copied</span>'
              : '<span class="tier weak">not converted</span>') + '</td></tr>';
        });
    var cb = $('btnConvHere');
    if (cb) {
      cb.addEventListener('click', async function () {
        var p = await window.mapper.pickFolder(
          'Choose the converted-files folder (My Drive/_Converted for NAS)', true);
        (p || []).forEach(function (x) { if (CONV_ROOTS.indexOf(x) === -1) CONV_ROOTS.push(x); });
        renderPaths();
        // Say what happens next rather than leaving the same numbers on screen.
        if (p && p.length) $('main').innerHTML =
          '<div class="empty"><b>Converted folder set.</b><br>Run <i>Compare</i> again to ' +
          'match the stubs to their converted files.</div>';
      });
    }
  } else {
    m.innerHTML = droppedNote() +
      '<div class="note">The same file present in more than one NAS tree, matched on name and ' +
      'size. A <b>hint, not a verdict</b> — confirm with a compare-by-content pass before ' +
      'deleting anything.</div>' +
      table(['File', 'Size', 'Copies', 'Where'], OVERLAP, function (r) {
        return '<tr><td>' + esc(r.name) + '</td>' +
          '<td class="num">' + fmtBytes(r.size) + '</td>' +
          '<td class="num">' + esc(r.copies) + '</td>' +
          '<td class="path"><small>' + esc(r.paths) + '</small></td></tr>';
      });
  }
}

// ── remapping ───────────────────────────────────────────────────────────────
function openRemap(mode, row) {
  REMAP = { mode: mode, row: row, selected: null };
  var dlg = $('remapDlg');
  $('remapNote').hidden = true;
  $('remapResults').innerHTML = '';
  $('remapSave').disabled = true;

  $('remapBrowse').hidden = mode !== 'dest';
  $('remapWarn').hidden = true;
  if (mode === 'dest') {
    $('remapTitle').textContent = 'Set a destination';
    $('remapHint').innerHTML =
      'Everything under <b>' + esc(parentOf(row.drivePath) || '(root)') + '</b> will be mapped ' +
      'to the NAS path you type. Keeping a <code>_fromDrive</code> leaf means incoming ' +
      'material lands beside the curated content instead of merged into it.';
    $('remapInput').placeholder = 'e.g. Projects/Internal UWC Projects/Loggerhead Turtle Project/_fromDrive';
    $('remapInput').value = row.proposedNas || '';
    validateDest();
  } else {
    $('remapTitle').textContent = 'Mark as already on the NAS';
    $('remapHint').innerHTML =
      'Find the file this one duplicates. Saving records that <b>' +
      esc(baseOf(parentOf(row.drivePath))) + '</b> and the NAS folder are the same project, ' +
      'so every other file in them matches on the next run too.';
    $('remapInput').placeholder = 'Search the NAS by file name…';
    $('remapInput').value = row.name || '';
    searchNas();
  }
  dlg.showModal();
}

async function searchNas() {
  if (!REMAP || REMAP.mode !== 'link') return;
  var q = $('remapInput').value.trim();
  var rows = await window.mapper.searchNas(q, REMAP.row.size);
  if (!rows.length) {
    $('remapResults').innerHTML = '<div class="empty">No NAS file matches.</div>';
    return;
  }
  $('remapResults').innerHTML = rows.map(function (r, i) {
    var exact = r.size === REMAP.row.size;
    return '<div class="row" data-i="' + i + '">' + esc(r.base) +
      (exact ? ' <span class="tier md5">exact size</span>' : '') +
      ' <span style="color:var(--muted)">' + fmtBytes(r.size) + '</span>' +
      '<small>' + esc(r.abs) + '</small></div>';
  }).join('');
  $('remapResults').querySelectorAll('.row').forEach(function (el) {
    el.addEventListener('click', function () {
      $('remapResults').querySelectorAll('.row').forEach(function (x) { x.classList.remove('sel'); });
      el.classList.add('sel');
      REMAP.selected = rows[Number(el.dataset.i)];
      $('remapSave').disabled = false;
      $('remapNote').hidden = false;
      $('remapNote').innerHTML = 'Will record <b>' +
        esc(baseOf(parentOf(REMAP.row.drivePath))) + '</b> ≡ <b>' +
        esc(baseOf(parentOf(REMAP.selected.abs.replace(/\\/g, '/')))) + '</b> as the same project.';
    });
  });
}

/**
 * A destination must be absolute. A relative one silently created the tree next
 * to wherever the copy plan ran instead of on the NAS, so the plan now skips it
 * and the dialog refuses to save it.
 */
function isAbsoluteDest(p) {
  var s = String(p || '');
  return /^[A-Za-z]:[\\/]/.test(s) || s.indexOf('\\\\') === 0 || s.charAt(0) === '/';
}

function validateDest() {
  if (!REMAP || REMAP.mode !== 'dest') return;
  var v = $('remapInput').value.trim();
  var ok = !!v && isAbsoluteDest(v);
  $('remapSave').disabled = !ok;
  if (!v) { $('remapWarn').hidden = true; return; }
  $('remapWarn').hidden = ok;
  if (!ok) {
    $('remapWarn').innerHTML =
      '<b>Needs a full path.</b> Use <code>Browse…</code>, or type something like ' +
      '<code>Z:\\Projects\\Internal UWC Projects\\…\\_fromDrive</code>. ' +
      'A relative path would be created next to the copy plan instead of on the NAS, ' +
      'so it will be skipped.';
  }
}

async function saveRemap() {
  if (!REMAP) return;
  if (REMAP.mode === 'dest') {
    var nas = $('remapInput').value.trim();
    if (!nas) return;
    var drive = parentOf(REMAP.row.drivePath);
    MAPPING.map = (MAPPING.map || []).filter(function (m) { return m.drive !== drive; });
    MAPPING.map.push({ drive: drive, nas: nas, note: 'set in the app' });
  } else {
    if (!REMAP.selected) return;
    var a = baseOf(parentOf(REMAP.row.drivePath));
    var b = baseOf(parentOf(REMAP.selected.abs.replace(/\\/g, '/')));
    if (a && b && a !== b) {
      var dup = (MAPPING.aliases || []).some(function (p) {
        return (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a);
      });
      if (!dup) MAPPING.aliases.push([a, b]);
    }
  }
  await window.mapper.saveMapping(MAPPING);
  syncStageButtons();
  $('remapDlg').close();
  // The rule only takes effect on a re-run, so say so rather than implying the
  // table on screen already reflects it.
  $('main').insertAdjacentHTML('afterbegin',
    '<div class="note"><b>Rule saved.</b> Hit Compare again to apply it.</div>');
}

// ── map ─────────────────────────────────────────────────────────────────────
/*
  One decision for every new file, instead of per-row. Compare lights Map; Map
  lights Copy. The staging is the point: you cannot copy something you have not
  said where to put.
*/
function joinDest(root, rel) {
  var r = String(root).replace(/[\\/]+$/, '');
  var t = String(rel).split(/[\\/]+/).filter(Boolean).join(SEP);
  return t ? r + SEP + t : r;
}

/*
 * Everything the run could still act on — NOT just RESULT.new.
 *
 * Gating the whole pipeline on the new list meant "nothing new" was treated as
 * "nothing to do", which is wrong in the two cases that matter most on a real
 * migration: a file that was UPDATED in Drive sits in conflicts, and a Google
 * stub with a converted equivalent is only in the new list if the converted
 * folder was pointed at. Both are work; neither is new. Map and Copy went grey
 * over them and the run looked finished when it was not.
 */
function actionableRows() {
  if (!RESULT) return [];
  return (RESULT.new || []).concat(electedConflictRows());
}

function syncStageButtons() {
  var mapBtn = $('btnMapTop'), copyBtn = $('btnCopyTop');
  var rows = actionableRows();
  var count = rows.length;
  var elected = electedConflictRows().length;
  var conflictsWaiting = RESULT ? (RESULT.conflicts || []).length - elected : 0;
  var stubsWaiting = RESULT
    ? (RESULT.natives || []).filter(function (n) { return !n.resolved; }).length : 0;

  mapBtn.disabled = !count;
  // "new" only while that is all these are; electing a conflict makes the word
  // wrong, and a count that quietly means something else is worse than a
  // vaguer one.
  mapBtn.textContent = count
    ? 'Map ' + count.toLocaleString() +
      (elected ? (count === 1 ? ' file…' : ' files…') : ' new…')
    : 'Map…';
  mapBtn.title = !RESULT ? 'Run Scan only, or Compare, first'
    : count ? 'Choose where these files should go'
    : SCANNED ? 'Nothing was found in the folders you scanned'
    // Say what is waiting, and where. "Nothing new" is true and useless when
    // there are conflicts and stubs sitting in other tabs.
    : conflictsWaiting
      ? 'Nothing new. ' + conflictsWaiting + ' updated file(s) are waiting in Conflicts — ' +
        'choose what to do with them there'
    : stubsWaiting
      ? 'Nothing new. ' + stubsWaiting + ' Google stub(s) need their converted files — ' +
        'see the Native stubs tab'
    : 'Nothing new — everything is already on the NAS';

  /*
   * No longer gated on having been through Map.
   *
   * The gate assumed a destination was unreviewed until Map confirmed it, but a
   * row that arrived with one from a mapping rule is not less examined than one
   * Map derived the same way — and the real review happens after this button,
   * not before it: Copy opens a dialog listing every file with its destination
   * and a checkbox, and nothing moves until that is confirmed. The gate only
   * ever blocked the case where the rules already had the answer, which is the
   * common one once a profile is set up.
   *
   * Copy still needs an ABSOLUTE destination. That is a correctness rule, not a
   * ceremony, and it stays.
   */
  var ready = copyReadyRows();
  copyBtn.disabled = !ready.length;
  copyBtn.textContent = ready.length ? 'Copy ' + ready.length.toLocaleString() + '…' : 'Copy…';
  copyBtn.title = ready.length ? 'Review and copy'
    : count ? 'These have no destination yet — set one in Map'
    : 'Nothing to copy';
}

function openMap() {
  // actionableRows, not RESULT.new — the button is enabled from the same list,
  // and gating the dialog on a narrower one made it light up and do nothing.
  if (!actionableRows().length) return;
  MAP_PAIRS = suggestPairs(DRIVE_ROOTS, NAS_ROOTS);
  renderMap();
  $('mapDlg').showModal();
}

var MAP_PAIRS = [];

function baseName(p) {
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}
function normPath(p) {
  var v = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return SEP === '\\' ? v.toLowerCase() : v;
}

/**
 * Suggest one destination PER SOURCE by folder-name similarity.
 * With several sources a single shared destination would flatten
 * "External Client Projects", "Internal UIZ Projects" and "Meeting_Minutes_Clients"
 * into one folder — the mess this screen exists to prevent.
 */
function suggestPairs(drives, nas) {
  var toks = function (n) {
    return String(baseName(n)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  };
  var sim = function (a, b) {
    var A = toks(a), B = toks(b);
    if (!A.length || !B.length) return 0;
    var hit = 0;
    A.forEach(function (t) { if (B.indexOf(t) !== -1) hit++; });
    return hit / Math.max(A.length, B.length);
  };
  var used = {};
  return drives.map(function (d) {
    var best = null, bestScore = 0;
    nas.forEach(function (n) {
      if (used[n]) return;
      var sc = sim(d, n);
      if (sc > bestScore) { bestScore = sc; best = n; }
    });
    if (best && bestScore >= 0.5) { used[best] = 1; return { drive: d, nas: best, auto: true }; }
    return { drive: d, nas: null, auto: false };
  });
}

function rowsForSource(root) {
  // Matches applyMap: a converted file belongs to the source its STUB came
  // from, not to the converted folder it happens to sit in.
  return actionableRows().filter(function (r) {
    return normPath(r.viaConversion ? r.stubRoot : r.driveRoot) === normPath(root);
  });
}

function renderMap() {
  var total = actionableRows().length;
  var unset = MAP_PAIRS.filter(function (p) { return !p.nas; });
  var mappedFiles = MAP_PAIRS.reduce(function (a, p) {
    return a + (p.nas ? rowsForSource(p.drive).length : 0);
  }, 0);

  $('mapHint').innerHTML =
    '<b>' + mappedFiles.toLocaleString() + ' of ' + total.toLocaleString() + '</b> file(s) have a destination. ' +
    'Every source is mapped separately — check each arrow before continuing.';

  $('mapNote').innerHTML = unset.length
    ? '<b>' + unset.length + ' source(s) have no destination.</b> Their files will be left out of the copy ' +
      'rather than guessed at. Set one, or leave them for later.'
    : 'Files keep the folder structure they have in Drive and land <b>under</b> the destination. ' +
      'They are not merged into existing sub-folders, and nothing existing is touched.';

  $('mapPreview').innerHTML =
    '<div class="pairhead"><span>From (Google Drive)</span><span></span><span>To (NAS)</span><span></span></div>' +
    MAP_PAIRS.map(function (p, i) {
      var mine = rowsForSource(p.drive);
      var bytes = mine.reduce(function (a, r) { return a + r.size; }, 0);
      return '<div class="pairrow' + (p.nas ? '' : ' unset') + '">' +
        '<span class="side"><b>' + esc(baseName(p.drive)) + '</b>' +
          '<small>' + esc(p.drive) + '</small>' +
          '<small>' + mine.length.toLocaleString() + ' file(s) · ' + fmtBytes(bytes) + '</small></span>' +
        '<span class="arrow">→</span>' +
        '<span class="side to"><b>' + (p.nas ? esc(baseName(p.nas)) : 'not set') + '</b>' +
          '<small>' + (p.nas ? esc(p.nas) : 'these files will be skipped') + '</small></span>' +
        '<button class="btn sm" data-pair="' + i + '">' + (p.nas ? 'Change…' : 'Set…') + '</button>' +
        '</div>';
    }).join('');

  $('mapPreview').querySelectorAll('button[data-pair]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var i = Number(b.dataset.pair);
      var picked = await window.mapper.pickFolder(
        'Destination for ' + baseName(MAP_PAIRS[i].drive), false);
      if (picked && picked.length) { MAP_PAIRS[i].nas = picked[0]; renderMap(); }
    });
  });

  $('mapConfirm').disabled = mappedFiles === 0;
  $('mapConfirm').textContent = unset.length
    ? 'Map ' + mappedFiles.toLocaleString() + ', skip the rest'
    : 'Confirm all ' + mappedFiles.toLocaleString();
}

function applyMap() {
  var byRoot = {};
  MAP_PAIRS.forEach(function (p) { if (p.nas) byRoot[normPath(p.drive)] = p.nas; });

  // Each row follows the pairing of ITS OWN source root. A shared destination
  // would merge separate project trees into one folder.
  MAPPED = actionableRows().map(function (r) {
    /*
     * A converted file is mapped by where its STUB lived, not by where the
     * converted file itself sits. The converted tree is a single folder holding
     * output from every project and is never one of the sources being paired,
     * so keying on its root dropped every converted row as "source not mapped"
     * — the whole point of pointing at the folder, silently undone.
     */
    var srcRoot = r.viaConversion ? r.stubRoot : r.driveRoot;
    var srcPath = r.viaConversion ? r.stubPath : r.drivePath;
    var nas = byRoot[normPath(srcRoot)];
    if (!nas) return Object.assign({}, r, { proposedNas: '', mappedBy: '(source not mapped)' });

    var dest = joinDest(nas, srcPath);
    // Keep the stub's folder, take the converted file's name: Plan.gdoc's
    // destination becomes Plan.docx in the same place.
    if (r.viaConversion) dest = withFileName(dest, r.name);
    // An elected conflict keeps whichever mode was chosen for it.
    if (r.conflictMode === 'alongside') dest = alongsideName(dest);

    return Object.assign({}, r, {
      proposedNas: dest,
      mappedBy: baseName(srcRoot) + ' → ' + baseName(nas) +
        (r.viaConversion ? ' (converted)' : '') +
        (r.conflictMode ? ' (' + r.conflictMode + ')' : ''),
    });
  });

  var ok = MAPPED.filter(function (r) { return r.proposedNas; }).length;
  var skipped = MAPPED.length - ok;
  $('mapDlg').close();
  // Only the new rows go back to RESULT.new. Elected conflicts stay conflicts —
  // folding them in would double-count them and lose the choice attached to them.
  RESULT.new = MAPPED.filter(function (r) { return !r.conflictMode; });
  syncStageButtons();
  renderTab();
  $('main').insertAdjacentHTML('afterbegin',
    '<div class="note"><b>Mapped ' + ok.toLocaleString() + ' file(s)</b> across ' +
    MAP_PAIRS.filter(function (p) { return p.nas; }).length + ' source(s)' +
    (skipped ? ' · <b>' + skipped.toLocaleString() + ' skipped</b> (source not mapped)' : '') +
    '. <b>Copy…</b> is now available.</div>');
}

// ── copy ────────────────────────────────────────────────────────────────────
var COPY_RUNNING = false;

function copyReadyRows() {
  var src = MAPPED || actionableRows();
  return src.filter(function (r) { return r.proposedNas && isAbsoluteDest(r.proposedNas); });
}

/*
 * Conflicts the user has decided to act on, turned into copy rows.
 *
 * Two ways to act, and the default never destroys anything:
 *
 *   alongside — write the Drive version next to the NAS one under a different
 *               name. Both survive and a human reconciles later. This is the
 *               default because a conflict means the tool does NOT know which
 *               file is wanted.
 *   replace   — write over the NAS file. Only ever from an explicit choice.
 *
 * This distinction cannot be left to the copy engine: robocopy runs with /XO
 * and WILL overwrite when the Drive file is newer, while rsync runs with
 * --ignore-existing and never overwrites at all. Leaving it implicit means the
 * same plan does different things on Windows and on a Mac.
 */
function electedConflictRows() {
  if (!RESULT || !RESULT.conflicts) return [];
  return RESULT.conflicts
    .filter(function (c) { return CONFLICT_PICKS[c.drivePath]; })
    .map(function (c) {
      var mode = CONFLICT_PICKS[c.drivePath];
      var dest = c.proposedNas || c.nasPath;
      return Object.assign({}, c, {
        size: c.size || c.driveSize,
        proposedNas: mode === 'replace' ? dest : alongsideName(dest),
        mappedBy: (c.mappedBy || 'conflict') + (mode === 'replace' ? ' (replaces)' : ' (alongside)'),
        conflictMode: mode,
      });
    });
}

/** Swap the last path segment for `name`, keeping the folders. */
function withFileName(p, name) {
  var s = String(p);
  var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut >= 0 ? s.slice(0, cut + 1) + name : name;
}

/** `Report.docx` -> `Report (from Drive).docx`, extension preserved. */
function alongsideName(p) {
  var s = String(p);
  var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  var dir = cut >= 0 ? s.slice(0, cut + 1) : '';
  var base = cut >= 0 ? s.slice(cut + 1) : s;
  var dot = base.lastIndexOf('.');
  return dot > 0
    ? dir + base.slice(0, dot) + ' (from Drive)' + base.slice(dot)
    : dir + base + ' (from Drive)';
}

var CONFLICT_PICKS = {};   // drivePath -> 'alongside' | 'replace'

/** Skip anything already there at the same size; never overwrite by default. */
function classifyAgainstDest(rows, existing) {
  var get = function (p) { return existing[String(p).toLowerCase().split('\\').join('/')]; };
  return rows.map(function (r) {
    var hit = get(r.proposedNas);
    if (!hit) return Object.assign({}, r, { state: 'new', existingSize: null, selected: true });
    if (Number(hit.size) === Number(r.size)) {
      /*
       * Same size is a PRESUMPTION, not a verdict, so it is marked as one.
       * applyDestVerdicts upgrades it to proven, or overturns it, when the
       * manifest gave us an md5 to check against.
       */
      return Object.assign({}, r, {
        state: 'identical', existingSize: hit.size, selected: false, proof: 'size',
      });
    }
    return Object.assign({}, r, { state: 'different', existingSize: hit.size, selected: false });
  });
}

/**
 * Fold the md5 verdicts back in.
 *
 * A file the size check called identical but the hash says differs is the case
 * this whole step exists for: it would have been skipped, silently, and never
 * reached the NAS. It is selected for copying, because the Drive copy is the
 * one the comparison was asked about.
 */
function applyDestVerdicts(rows, verdicts) {
  var v = verdicts || {};
  return rows.map(function (r) {
    var verdict = v[r.proposedNas];
    if (!verdict || r.state !== 'identical') return r;
    if (verdict === 'same') return Object.assign({}, r, { proof: 'md5' });
    if (verdict === 'differs') {
      return Object.assign({}, r, {
        state: 'different', proof: 'md5', selected: true,
        note: 'same size, different content',
      });
    }
    return Object.assign({}, r, { proof: 'unreadable' });
  });
}

function renderCopyReview() {
  var counts = { new: 0, identical: 0, different: 0 };
  COPY_ROWS.forEach(function (r) { counts[r.state]++; });
  var sel = COPY_ROWS.filter(function (r) { return r.selected; });
  var bytes = sel.reduce(function (a, r) { return a + r.size; }, 0);

  /*
   * Say which of these were PROVEN and which were assumed. "Already there" on a
   * size match and "already there, byte for byte" are different claims, and the
   * user is deciding whether to skip a file on the strength of one of them.
   */
  var proven = COPY_ROWS.filter(function (r) { return r.proof === 'md5'; }).length;
  var overturned = COPY_ROWS.filter(function (r) {
    return r.state === 'different' && r.proof === 'md5';
  }).length;
  var unread = COPY_ROWS.filter(function (r) { return r.proof === 'unreadable'; }).length;

  $('copyHint').innerHTML =
    '<b>' + counts.new + '</b> not on the NAS · ' +
    '<b>' + counts.identical + '</b> already there at the same size · ' +
    '<b>' + counts.different + '</b> there but different.' +
    (proven
      ? ' <span style="color:var(--muted)">' + proven +
        ' checked byte for byte against the manifest.</span>'
      : '') +
    (overturned
      ? ' <b style="color:var(--warn,#b45309)">' + overturned +
        ' matched on size but are NOT the same file — selected for copying.</b>'
      : '') +
    (unread
      ? ' <span style="color:var(--muted)">' + unread +
        ' could not be read to check; left skipped.</span>'
      : '');

  $('copyLog').innerHTML =
    '<div class="selbar" style="padding:6px 10px">' +
      '<span class="grow">Selected: <b>' + sel.length + '</b> file(s), ' + fmtBytes(bytes) + '</span>' +
      '<button class="btn sm" id="selNew">Select only new</button>' +
      '<button class="btn sm" id="selAll">Select all</button>' +
      '<button class="btn sm" id="selNone">Select none</button>' +
    '</div>' +
    COPY_ROWS.slice(0, 600).map(function (r, i) {
      return '<div class="filerow">' +
        '<input type="checkbox" data-i="' + i + '"' + (r.selected ? ' checked' : '') +
        (r.state === 'identical'
          ? ' title="' + (r.proof === 'md5'
              ? 'already on the NAS — verified byte for byte'
              : r.proof === 'unreadable'
                ? 'already there at the same size; could not be read to verify'
                : 'already on the NAS at the same size (not verified)') + '"'
          : r.note ? ' title="' + esc(r.note) + '"' : '') + '>' +
        '<span class="statetag ' + r.state + '">' + r.state + '</span>' +
        '<span class="nm">' + esc(r.name) + '<small>→ ' + esc(r.proposedNas) + '</small></span>' +
        '<span class="sz">' + fmtBytes(r.size) +
          (r.existingSize !== null && r.existingSize !== undefined
            ? ' <span style="color:var(--muted)">(there: ' + fmtBytes(r.existingSize) + ')</span>' : '') +
        '</span></div>';
    }).join('') +
    (COPY_ROWS.length > 600 ? '<div class="filerow"><small>… and ' + (COPY_ROWS.length - 600) +
      ' more (all included in the copy)</small></div>' : '');
  $('copyLog').hidden = false;

  $('copyLog').querySelectorAll('input[type=checkbox][data-i]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      COPY_ROWS[Number(cb.dataset.i)].selected = cb.checked;
      renderCopyReview();
    });
  });
  var setAll = function (fn) { COPY_ROWS.forEach(fn); renderCopyReview(); };
  $('selNew').addEventListener('click', function () { setAll(function (r) { r.selected = r.state === 'new'; }); });
  $('selAll').addEventListener('click', function () { setAll(function (r) { r.selected = true; }); });
  $('selNone').addEventListener('click', function () { setAll(function (r) { r.selected = false; }); });
  $('copyGo').disabled = !sel.length;
}

async function openCopy() {
  var rows = copyReadyRows();
  if (!rows.length) return;
  $('copyTitle').textContent = 'Review before copying';
  $('copyHint').textContent = 'Checking what is already at the destination…';
  $('copyResult').hidden = true;
  $('copyBlocked').hidden = true;
  BLOCKED = [];
  $('copyBar').hidden = true;
  $('copyCancel').hidden = true;
  $('copyDry').disabled = false;
  $('copyDlg').showModal();

  // Ask the filesystem, not the earlier index: the destination may be a folder
  // that was never part of the comparison.
  var existing = await window.mapper.inspectDest(rows.map(function (r) { return r.proposedNas; }));
  COPY_ROWS = classifyAgainstDest(rows, existing || {});

  /*
   * The exact check, on the only files it can change anything for: the ones
   * already sitting at their destination at the same size, which are about to
   * be dropped from the plan on that basis. Everything else is either missing
   * (copy it) or a different size (already flagged), and no hash alters either.
   *
   * This is why the comparison no longer reads the NAS. Same question, asked
   * where the set is small and the answer decides something.
   */
  var toVerify = COPY_ROWS.filter(function (r) { return r.state === 'identical' && r.md5; });
  if (toVerify.length) {
    $('copyHint').textContent =
      'Checking the ' + toVerify.length + ' file(s) already at the destination are the same file…';
    var dv = await window.mapper.verifyDest(toVerify);
    COPY_ROWS = applyDestVerdicts(COPY_ROWS, dv && dv.verdicts);
  }

  /*
   * Prove every source is readable before offering to copy it. Anything that
   * cannot be read is taken out of the plan here rather than discovered by the
   * copy engine, which reports per-directory and leaves the user reading a log
   * to find out which file it was.
   */
  $('copyHint').textContent = 'Checking every file can actually be read…';
  var pf = await window.mapper.preflightCopy(COPY_ROWS);
  BLOCKED = pf.blocked || [];
  if (BLOCKED.length) {
    var byPath = {};
    BLOCKED.forEach(function (b) { byPath[b.proposedNas] = b; });
    COPY_ROWS = COPY_ROWS.filter(function (r) { return !byPath[r.proposedNas]; });
  }
  renderCopyReview();
  renderBlocked();
}

var BLOCKED = [];

/*
 * Say what cannot go, and why, in the same breath as what can. Grouped by cause
 * because "6 Google-native files" is one decision and "2 locked files" is a
 * different one — a flat list of 8 reads as eight separate problems.
 */
function renderBlocked() {
  var el = $('copyBlocked');
  if (!el) return;
  if (!BLOCKED.length) { el.hidden = true; el.innerHTML = ''; return; }

  var groups = {};
  BLOCKED.forEach(function (b) {
    if (!groups[b.kind]) groups[b.kind] = { kind: b.kind, reason: b.reason, rows: [] };
    groups[b.kind].rows.push(b);
  });
  var order = ['stub', 'permission', 'locked', 'gone', 'folder', 'nosource', 'unreadable'];
  var keys = Object.keys(groups).sort(function (a, b) {
    return (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99);
  });

  el.hidden = false;
  el.innerHTML =
    '<b>' + BLOCKED.length.toLocaleString() + ' file(s) cannot be copied and have been left out.</b> ' +
    'They were checked before the copy, not during it, so nothing below will fail mid-run.' +
    keys.map(function (k) {
      var g = groups[k];
      return '<div style="margin-top:7px"><b>' + g.rows.length.toLocaleString() + '</b> — ' +
        esc(g.reason) + '<div style="margin-top:3px">' +
        g.rows.slice(0, 6).map(function (r) { return '<div>· ' + esc(r.name) + '</div>'; }).join('') +
        (g.rows.length > 6 ? '<div>· …and ' + (g.rows.length - 6).toLocaleString() + ' more</div>' : '') +
        '</div></div>';
    }).join('') +
    '<div style="margin-top:8px"><button class="btn" id="btnBlockedCsv">Save this list as CSV…</button></div>' +
    (groups.stub
      ? '<div style="margin-top:6px"><small>Google-native files have no bytes on disk. Export them from ' +
        'Google Drive first — the Storage Explorer dashboard lists what each type converts to — then ' +
        'they will copy like any other file.</small></div>'
      : '');

  $('btnBlockedCsv').addEventListener('click', async function () {
    var r = await window.mapper.exportFailures(BLOCKED.map(function (b) {
      return { name: b.name, drivePath: b.drivePath, proposedNas: b.proposedNas,
               size: b.size, why: b.reason };
    }));
    if (r && r.ok) {
      el.insertAdjacentHTML('beforeend',
        '<div class="okline" style="margin-top:6px">Written to ' + esc(r.file) + '</div>');
    }
  });
}

async function startCopy(dryRun) {
  if (COPY_RUNNING) return;
  var rows = COPY_ROWS.filter(function (r) { return r.selected; });
  if (!rows.length) return;
  COPY_RUNNING = true;
  $('copyDry').disabled = true;
  $('copyGo').disabled = true;
  $('copyCancel').hidden = false;
  $('copyBar').hidden = false;
  $('copyLog').innerHTML = '';
  $('copyResult').hidden = true;
  $('copyTitle').textContent = dryRun ? 'Dry run (nothing will be written)' : 'Copying to the NAS';
  $('copyStatus').textContent = 'Starting…';

  var r = await window.mapper.copyRun({ rows: rows, dryRun: !!dryRun, threads: 8 });

  COPY_RUNNING = false;
  $('copyCancel').hidden = true;
  $('copyDry').disabled = false;
  $('copyGo').disabled = false;
  $('copyFill').style.width = '100%';
  $('copyStatus').textContent = 'Finished';
  renderCopyResult(r);

  /*
   * Check the destination itself, rather than trusting the engine's verdict.
   *
   * robocopy exits per DIRECTORY, so a run reported "3 of 8 folder(s) FAILED"
   * and left the user to read a log to find out WHICH files were missing. A
   * stat of each intended destination answers that in the terms the files were
   * chosen in, works identically for rsync, and needs no log parsing — robocopy
   * localises its log, so parsing it breaks on a non-English Windows.
   *
   * Skipped on a dry run, where nothing was supposed to land.
   */
  if (!dryRun) verifyAfterCopy(rows);
}

var LAST_FAILURES = [];

async function verifyAfterCopy(rows) {
  var v = await window.mapper.verifyCopy(rows);
  var bad = (v.missing || []).concat(v.short || []);
  LAST_FAILURES = bad;
  if (!bad.length) {
    $('copyResult').insertAdjacentHTML('beforeend',
      '<div class="okline" style="margin-top:6px">Verified: all ' +
      v.ok.toLocaleString() + ' file(s) are present at the destination with the right size.</div>');
    return;
  }
  var list = bad.slice(0, 12).map(function (x) {
    return '<div>· ' + esc(x.name) + ' — ' +
      (x.diagnosis ? esc(x.diagnosis)
        : x.why ? esc(x.why)
        : 'size mismatch (' + fmtBytes(x.actual) + ' of ' + fmtBytes(x.size) + ')') +
      '</div>';
  }).join('');

  /*
   * Retry only what retrying can fix. A Google-native stub has no bytes behind
   * it, so a second attempt fails identically — offering "Retry these 6" for six
   * stubs sends the user round a loop that cannot terminate, which is what
   * happened on the first run of this feature.
   */
  var retryable = bad.filter(function (x) {
    return !(x.diagnosis && x.diagnosis.indexOf('Google-native stub') !== -1);
  });
  var stubs = bad.length - retryable.length;

  $('copyResult').insertAdjacentHTML('beforeend',
    '<div class="warn" style="margin-top:8px"><b>' + bad.length.toLocaleString() +
    ' file(s) did not land.</b> ' + v.ok.toLocaleString() + ' did.' +
    (stubs ? ' <b>' + stubs.toLocaleString() + '</b> of them are Google-native files with no ' +
             'contents to copy — those will never transfer and are not a fault of this run.' : '') +
    '<div style="margin-top:6px">' + list +
    (bad.length > 12 ? '<div>· …and ' + (bad.length - 12).toLocaleString() + ' more</div>' : '') +
    '</div>' +
    '<div style="margin-top:8px">' +
    '<button class="btn" id="btnFailCsv">Save the list as CSV…</button>' +
    (retryable.length
      ? ' <button class="btn primary" id="btnRetryFailed">Retry these ' +
        retryable.length.toLocaleString() + '</button>'
      : '') +
    '</div>' +
    (stubs && !retryable.length
      ? '<div style="margin-top:6px"><small>Nothing here is retryable. Run Compare again ' +
        'and these will be listed under <i>Native stubs</i> instead of <i>New</i>.</small></div>'
      : '<div style="margin-top:6px"><small>A size mismatch counts as not landed: a truncated ' +
        'file at the destination would make the next comparison call it already copied.</small></div>') +
    '</div>');

  $('btnFailCsv').addEventListener('click', async function () {
    var r = await window.mapper.exportFailures(LAST_FAILURES);
    if (r && r.ok) {
      $('copyResult').insertAdjacentHTML('beforeend',
        '<div class="okline" style="margin-top:6px">Written to ' + esc(r.file) + '</div>');
    }
  });
  if (retryable.length) {
    $('btnRetryFailed').addEventListener('click', function () {
      // Select exactly the files a retry can actually help, and nothing else.
      COPY_ROWS.forEach(function (r) {
        r.selected = retryable.some(function (f) { return f.proposedNas === r.proposedNas; });
      });
      renderCopyReview();
      startCopy(false);
    });
  }
}

function renderCopyResult(r) {
  var el = $('copyResult');
  el.hidden = false;
  if (r.error) { el.innerHTML = '<b>Could not start.</b> ' + esc(r.error); return; }

  var head;
  if (r.cancelled) head = '<b>Stopped.</b> ' + r.groups + ' of ' + r.totalGroups + ' folder(s) had already been processed.';
  else if (r.ok) head = r.dryRun
    ? '<b>Dry run finished — nothing was written.</b> All ' + r.groups + ' folder(s) would copy cleanly.'
    : '<b>Copied successfully.</b> ' + r.groups + ' folder(s), ' + fmtBytes(r.copiedBytes) + '.';
  else head = '<b>' + r.failed + ' of ' + r.groups + ' folder(s) FAILED.</b> Nothing was deleted; re-running is safe.';

  var detail = (r.results || []).filter(function (x) { return !x.ok; }).slice(0, 20).map(function (x) {
    return '<div>· ' + esc(x.dstDir) + ' — ' + esc(x.summary) + ' (exit ' + x.code + ')</div>';
  }).join('');

  var skipped = (r.skipped || []).length
    ? '<div style="margin-top:6px">' + r.skipped.length + ' file(s) were skipped for want of a destination.</div>' : '';

  el.innerHTML = head +
    (detail ? '<div style="margin-top:6px">' + detail + '</div>' : '') + skipped +
    (r.dryRun || !r.ok ? '' :
      '<div style="margin-top:6px">Now hit <b>Compare</b> again — everything you just copied ' +
      'should move into <i>Already on NAS</i>. That round trip is the proof it landed.</div>') +
    (r.logFile ? '<div style="margin-top:6px">Log: <code>' + esc(r.logFile) + '</code></div>' : '');
}

// ── export ──────────────────────────────────────────────────────────────────
/*
 * A picker, because there are now two quite different things to export and they
 * become available at different moments. The old single button was enabled only
 * after a comparison, went straight to a folder dialog, and — when the main
 * process refused with "nothing to export yet" — the renderer checked only
 * `if (r && r.ok)`, so the refusal was swallowed and the click looked like it
 * had done nothing at all. Every branch here reports its outcome.
 */
async function openExport() {
  var opt = await window.mapper.exportOptions();
  var rows = [];

  rows.push({
    id: 'manifest',
    on: opt.driveFiles > 0,
    t: 'Drive manifest (CSV)',
    d: opt.driveFiles > 0
      ? opt.driveFiles.toLocaleString() + ' files indexed. This is the manifest ' +
        'format this app reads back — load it under Drive manifest to keep an ' +
        'inventory between sessions.'
      : 'Nothing indexed yet. Run Scan only, or Compare.',
    note: 'No checksums: hashing a Drive for Desktop mount would download every file. ' +
          'Matching stays on size + name.',
  });

  rows.push({
    id: 'reports',
    on: !!opt.compared,
    t: 'Comparison reports + copy plan',
    d: opt.compared
      ? 'duplicates, new, conflicts, natives, overlap, summary — plus a copy plan that only ever adds files.'
      : opt.scanned
        ? 'Needs a comparison. A scan has no destination to compare against, so there are no duplicates or conflicts to report.'
        : 'Run Compare first.',
  });

  $('exportList').innerHTML = rows.map(function (r) {
    return '<button class="exportrow" data-id="' + r.id + '"' + (r.on ? '' : ' disabled') + '>' +
      '<span class="et">' + esc(r.t) + '</span>' +
      '<span class="ed">' + esc(r.d) + '</span>' +
      (r.note && r.on ? '<span class="en">' + esc(r.note) + '</span>' : '') +
      '</button>';
  }).join('');

  $('exportList').querySelectorAll('.exportrow').forEach(function (b) {
    b.addEventListener('click', function () { doExport(b.dataset.id); });
  });
  $('exportDlg').showModal();
}

async function doExport(id) {
  var r = id === 'manifest'
    ? await window.mapper.exportManifest()
    : await window.mapper.exportReports();
  $('exportDlg').close();
  if (!r || r.canceled) return;
  if (!r.ok) {
    $('main').insertAdjacentHTML('afterbegin',
      '<div class="warn"><b>Nothing was written.</b> ' + esc(r.error || 'Unknown error') + '</div>');
    return;
  }
  $('main').insertAdjacentHTML('afterbegin', id === 'manifest'
    ? '<div class="note"><b>Manifest written</b> — ' + r.rows.toLocaleString() +
      ' rows to ' + esc(r.file) + '</div>'
    : '<div class="note"><b>Reports written</b> to ' + esc(r.outDir) +
      ' — including a copy plan that only ever adds files.</div>');
}

// ── wiring ──────────────────────────────────────────────────────────────────
async function init() {
  var seenVersion = null;
  try {
    var info = await window.mapper.appInfo();
    APP_VERSION = info.version;
    SEP = info.isWindows ? '\\' : '/';
    $('appVer').textContent = 'v' + info.version;
    $('appVer').title = 'Electron ' + info.electron + ' · copy engine: ' + info.engine;
    var st = await window.mapper.profilesSettings();
    seenVersion = st.splashSeenVersion || null;
  } catch (e) {
    $('appVer').textContent = 'v?';
  }
  $('btnWhatsNew').addEventListener('click', openSplash);
  $('splashGo').addEventListener('click', async function () {
    if ($('splashHide').checked) await window.mapper.splashSeen(APP_VERSION);
    $('splashDlg').close();
  });
  // Shown on a fresh install and after every upgrade, so a new feature is never
  // silently added to a UI the user already thinks they know.
  var showSplash = seenVersion !== APP_VERSION;

  var boot = await window.mapper.profilesBoot();
  applyProfileToUi(boot.profile || blankProfile());
  PROFILE_FILE = boot.defaultFile || null;
  await refreshProfileList();

  $('profileSel').addEventListener('change', async function () {
    var f = this.value;
    if (!f) { PROFILE_FILE = null; return; }
    applyProfileToUi(await window.mapper.profilesLoad(f));
    PROFILE_FILE = f;
  });
  $('btnProfSave').addEventListener('click', async function () {
    var n = (PROFILE && PROFILE.name) || null;
    if (!n || !PROFILE_FILE) {
      n = await askText('Save profile as', 'A name for this set of folders and rules.', n || 'Default');
    }
    if (!n) return;
    var r = await saveProfile(n);
    // Confirm what the SERVER actually wrote, with the path, so a failed save
    // can never look like a successful one again.
    $('main').insertAdjacentHTML('afterbegin', r && r.file
      ? '<div class="note"><b>Profile &ldquo;' + esc(n) + '&rdquo; saved.</b> ' +
        '<small>' + esc(r.file) + '</small> — set it as default (⋯) to load it at startup.</div>'
      : '<div class="warn"><b>Profile did NOT save.</b> No file path came back from the app.</div>');
  });
  $('btnProfMenu').addEventListener('click', openProfileMenu);
  $('profClose').addEventListener('click', function () { $('profDlg').close(); });
  $('sharedApply').addEventListener('click', function () { sharedDecision('apply'); });
  $('sharedKeep').addEventListener('click', function () { sharedDecision('keep'); });
  $('sharedFresh').addEventListener('click', function () { sharedDecision('fresh'); });

  if (showSplash) openSplash();
  else if (boot.shared && boot.shared.status === 'updated') showSharedDialog(boot.shared);

  $('btnDrive').addEventListener('click', async function () {
    var p = await window.mapper.pickFolder('Choose your Google Drive folder', true);
    p.forEach(function (x) { if (DRIVE_ROOTS.indexOf(x) === -1) DRIVE_ROOTS.push(x); });
    renderPaths();
  });
  $('btnNas').addEventListener('click', async function () {
    var p = await window.mapper.pickFolder('Choose a NAS folder', true);
    p.forEach(function (x) { if (NAS_ROOTS.indexOf(x) === -1) NAS_ROOTS.push(x); });
    renderPaths();
  });
  $('btnConv').addEventListener('click', async function () {
    var p = await window.mapper.pickFolder(
      'Choose the converted-files folder (My Drive/_Converted for NAS)', true);
    p.forEach(function (x) { if (CONV_ROOTS.indexOf(x) === -1) CONV_ROOTS.push(x); });
    renderPaths();
  });
  $('btnManifest').addEventListener('click', async function () {
    var f = await window.mapper.pickManifest();
    if (f) { MANIFEST = f; setAccuracy('exact', null); $('accText').textContent = f; }
  });
  $('btnCompare').addEventListener('click', runCompare);
  $('btnExport').addEventListener('click', openExport);
  $('exportClose').addEventListener('click', function () { $('exportDlg').close(); });
  $('btnScan').addEventListener('click', runScan);
  $('btnTheme').addEventListener('click', function () {
    var r = document.documentElement, cur = r.getAttribute('data-theme');
    if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    r.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  });

  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      TAB = b.dataset.tab;
      renderTab();
    });
  });

  $('btnCopyTop').addEventListener('click', openCopy);
  $('btnMapTop').addEventListener('click', openMap);
  $('mapCancel').addEventListener('click', function () { $('mapDlg').close(); });
  $('mapConfirm').addEventListener('click', applyMap);
  $('copyClose').addEventListener('click', function () { $('copyDlg').close(); });
  $('copyCancel').addEventListener('click', function () { window.mapper.copyCancel(); });
  $('copyDry').addEventListener('click', function () { startCopy(true); });
  $('copyGo').addEventListener('click', function () {
    var rows = COPY_ROWS.filter(function (x) { return x.selected; });
    var bytes = rows.reduce(function (a, r) { return a + r.size; }, 0);
    if (!window.confirm('Copy ' + rows.length + ' file(s), ' + fmtBytes(bytes) +
        ', to the NAS?\n\nFiles are only added. Nothing on the NAS is deleted or ' +
        'overwritten with an older copy.')) return;
    startCopy(false);
  });
  window.mapper.onCopyEvent(function (e) {
    if (e.type === 'group-start') {
      $('copyFill').style.width = Math.round(100 * e.index / Math.max(1, e.total)) + '%';
      $('copyStatus').textContent = 'Folder ' + (e.index + 1) + ' of ' + e.total +
        ' · ' + e.files + ' file(s) · ' + fmtBytes(e.bytes);
      $('copyLog').insertAdjacentHTML('beforeend',
        '<div class="row">→ ' + esc(e.dstDir) + '</div>');
    } else if (e.type === 'group-done') {
      $('copyLog').insertAdjacentHTML('beforeend',
        '<div class="row" style="color:' + (e.verdict.ok ? 'var(--good)' : 'var(--critical)') + '">' +
        (e.verdict.ok ? '✓ ' : '✗ ') + esc(e.verdict.summary) + ' (exit ' + e.verdict.code + ')</div>');
      $('copyLog').scrollTop = $('copyLog').scrollHeight;
    } else if (e.type === 'log') {
      $('copyLog').insertAdjacentHTML('beforeend', '<div class="row"><small>' + esc(e.line) + '</small></div>');
      $('copyLog').scrollTop = $('copyLog').scrollHeight;
    }
  });

  $('remapInput').addEventListener('input', function () { searchNas(); validateDest(); });
  $('remapBrowse').addEventListener('click', async function () {
    var p = await window.mapper.pickFolder('Choose the destination folder on the NAS', false);
    if (p && p.length) { $('remapInput').value = p[0]; validateDest(); }
  });
  $('remapCancel').addEventListener('click', function () { $('remapDlg').close(); });
  $('remapSave').addEventListener('click', saveRemap);

  window.mapper.onProgress(function (m) {
    $('barText').textContent = m.text || 'Working…';
    if (m.done && m.total) $('barFill').style.width = Math.round(100 * m.done / m.total) + '%';
    else if (m.phase === 'nas') $('barFill').style.width = '15%';
    else if (m.phase === 'drive') $('barFill').style.width = '40%';
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
