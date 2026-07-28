/*
  Renderer. Talks to Node only through window.mapper (see preload.cjs).

  Single script, everything top level — the partials in the sibling Drive tool
  taught the lesson that a helper hidden inside an IIFE becomes a silently dead
  button, so there are no IIFEs here either.
*/

var MAPPING = { nasRoots: [], driveRoots: [], aliases: [], map: [] };
var DRIVE_ROOTS = [];
var NAS_ROOTS = [];
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
  if (MANIFEST) { setAccuracy('exact', null); $('accText').textContent = MANIFEST; }
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
    var n = window.prompt('Profile name', (PROFILE && PROFILE.name) || 'Default');
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
function renderPaths() {
  var draw = function (el, list, kind) {
    el.innerHTML = list.map(function (p, i) {
      return '<span class="chip"><code title="' + esc(p) + '">' + esc(p) + '</code>' +
        '<button data-kind="' + kind + '" data-i="' + i + '" title="Remove">×</button></span>';
    }).join('');
  };
  draw($('drivePaths'), DRIVE_ROOTS, 'drive');
  draw($('nasPaths'), NAS_ROOTS, 'nas');
  document.querySelectorAll('.paths .chip button').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = Number(b.dataset.i);
      if (b.dataset.kind === 'drive') DRIVE_ROOTS.splice(i, 1); else NAS_ROOTS.splice(i, 1);
      renderPaths();
    });
  });
  $('btnCompare').disabled = !(DRIVE_ROOTS.length && NAS_ROOTS.length);
  $('setupHint').textContent = DRIVE_ROOTS.length && NAS_ROOTS.length
    ? 'Nothing will be copied — Compare only produces a plan.'
    : 'Choose at least one Google Drive folder and one NAS folder.';
}

function setAccuracy(mode, stats) {
  var badge = $('accBadge'), text = $('accText');
  if (mode === 'exact') {
    badge.className = 'badge exact';
    badge.textContent = 'Exact — md5 from Drive API';
    text.textContent = stats
      ? stats.withMd5.toLocaleString() + ' of ' + stats.count.toLocaleString() +
        ' manifest rows carry a checksum. Renamed copies will still be detected.'
      : 'Checksums loaded.';
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
async function runCompare() {
  $('btnCompare').disabled = true;
  $('bar').hidden = false;
  $('barFill').style.width = '5%';
  $('barText').textContent = 'Starting…';
  $('emptyState').hidden = true;

  MAPPING.driveRoots = [];
  MAPPING.nasRoots = [];

  var res = await window.mapper.compare({
    driveRoots: DRIVE_ROOTS, nasRoots: NAS_ROOTS,
    manifestPath: MANIFEST, mapping: MAPPING,
  });

  $('bar').hidden = true;
  $('btnCompare').disabled = false;

  if (res.type === 'error') {
    $('main').innerHTML = '<div class="empty"><b>Comparison failed</b><br><br>' +
      esc(res.message) + '</div>';
    return;
  }

  RESULT = res.result;
  OVERLAP = res.overlap || [];
  setAccuracy(res.accuracy, res.manifestStats);
  DROPPED = res.droppedRoots || [];
  $('btnExport').disabled = false;
  MAPPED = null;
  renderCounts();
  syncStageButtons();
  renderTab();
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

function renderTab() {
  var m = $('main');
  if (!RESULT) return;

  if (TAB === 'duplicates') {
    m.innerHTML = droppedNote() + table(['Drive file', 'Already on NAS at', 'Size', 'Matched by'],
      RESULT.duplicates, function (r) {
        var weak = r.tier && r.tier.indexOf('md5') === -1;
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + esc(r.nasPath) + '</td>' +
          '<td class="num">' + fmtBytes(r.size) + '</td>' +
          '<td><span class="tier ' + (weak ? 'weak' : 'md5') + '">' + esc(r.tier) + '</span></td></tr>';
      });
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
    m.innerHTML = droppedNote() + table(['Drive file', 'NAS file', 'Drive size', 'NAS size', 'Why'],
      RESULT.conflicts, function (r) {
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + esc(r.nasPath) + '</td>' +
          '<td class="num">' + fmtBytes(r.driveSize) + '</td>' +
          '<td class="num">' + fmtBytes(r.nasSize) + '</td>' +
          '<td>' + esc(r.reason) + '</td></tr>';
      });
  } else if (TAB === 'natives') {
    m.innerHTML = droppedNote() +
      '<div class="note"><b>These cannot be copied.</b> Google Drive for Desktop stores a ' +
      'Doc, Sheet or Slide as a few hundred bytes of JSON holding a URL — copying one ' +
      'archives a dead link. Export them through the Drive API or rclone ' +
      '<code>--drive-export-formats</code> instead.</div>' +
      table(['Drive file', 'Type', 'Must be exported as', 'Drive id'],
        RESULT.natives, function (r) {
          return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
            '<td>' + esc(r.kind) + '</td>' +
            '<td>' + (r.exportAs ? '.' + esc(r.exportAs)
              : '<span style="color:var(--critical)">no export path — must stay in Drive</span>') + '</td>' +
            '<td class="path"><small>' + esc(r.docId) + '</small></td></tr>';
        });
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

function syncStageButtons() {
  var mapBtn = $('btnMapTop'), copyBtn = $('btnCopyTop');
  var newCount = RESULT ? RESULT.new.length : 0;
  mapBtn.disabled = !newCount;
  mapBtn.textContent = newCount ? 'Map ' + newCount.toLocaleString() + ' new…' : 'Map…';
  mapBtn.title = !RESULT ? 'Run a comparison first'
    : newCount ? 'Choose where the new files should go'
    : 'Nothing new — everything is already on the NAS';

  var ready = MAPPED ? MAPPED.filter(function (r) { return r.proposedNas && isAbsoluteDest(r.proposedNas); }) : [];
  copyBtn.disabled = !ready.length;
  copyBtn.textContent = ready.length ? 'Copy ' + ready.length.toLocaleString() + '…' : 'Copy…';
  copyBtn.title = ready.length ? 'Review and copy' : 'Map a destination first';
}

function openMap() {
  if (!RESULT || !RESULT.new.length) return;
  MAP_TARGET = NAS_ROOTS.length === 1 ? NAS_ROOTS[0] : null;
  renderMap();
  $('mapDlg').showModal();
}

var MAP_TARGET = null;

function renderMap() {
  var n = RESULT.new.length;
  if (!MAP_TARGET && NAS_ROOTS.length > 1) {
    $('mapHint').innerHTML = '<b>' + n.toLocaleString() + '</b> new file(s). ' +
      'You compared against more than one NAS folder — pick which one they belong under.';
    $('mapNote').innerHTML = '';
    $('mapPreview').innerHTML = NAS_ROOTS.map(function (r, i) {
      return '<div class="row" data-nas="' + i + '">' + esc(r) + '</div>';
    }).join('');
    $('mapPreview').querySelectorAll('[data-nas]').forEach(function (el) {
      el.addEventListener('click', function () {
        MAP_TARGET = NAS_ROOTS[Number(el.dataset.nas)];
        renderMap();
      });
    });
    $('mapConfirm').disabled = true;
    return;
  }
  $('mapConfirm').disabled = !MAP_TARGET;
  $('mapHint').innerHTML = '<b>' + n.toLocaleString() + '</b> new file(s) will go under ' +
    '<b>' + esc(MAP_TARGET || '(nothing chosen)') + '</b>, keeping the folder structure they have in Drive.';
  // Say the awkward part out loud rather than let it surprise anyone.
  $('mapNote').innerHTML =
    'They are <b>not</b> merged into existing sub-folders — the two trees do not line up ' +
    '(Drive <code>Shoot_…/Pictures</code> vs NAS <code>360 Footage/Shoot_…_SRC/Pictures/Processed</code>), ' +
    'and guessing would be worse than predictable. <b>Nothing existing is touched</b>; you can file ' +
    'them afterwards.';
  var ex = RESULT.new.slice(0, 6);
  $('mapPreview').innerHTML = ex.map(function (r) {
    return '<div class="row">' + esc(r.drivePath) +
      '<small>→ ' + esc(joinDest(MAP_TARGET, r.drivePath)) + '</small></div>';
  }).join('') + (n > ex.length ? '<div class="row"><small>… and ' + (n - ex.length) + ' more</small></div>' : '');
}

function applyMap() {
  if (!MAP_TARGET) return;
  MAPPED = RESULT.new.map(function (r) {
    return Object.assign({}, r, {
      proposedNas: joinDest(MAP_TARGET, r.drivePath),
      mappedBy: 'mapped to ' + MAP_TARGET,
    });
  });
  $('mapDlg').close();
  syncStageButtons();
  RESULT.new = MAPPED;      // so the New tab and the exported plan agree
  renderTab();
  $('main').insertAdjacentHTML('afterbegin',
    '<div class="note"><b>Mapped ' + MAPPED.length.toLocaleString() + ' file(s)</b> to ' +
    esc(MAP_TARGET) + '. <b>Copy…</b> is now available.</div>');
}

// ── copy ────────────────────────────────────────────────────────────────────
var COPY_RUNNING = false;

function copyReadyRows() {
  var src = MAPPED || (RESULT ? RESULT.new : []);
  return src.filter(function (r) { return r.proposedNas && isAbsoluteDest(r.proposedNas); });
}

/** Skip anything already there at the same size; never overwrite by default. */
function classifyAgainstDest(rows, existing) {
  var get = function (p) { return existing[String(p).toLowerCase().split('\\').join('/')]; };
  return rows.map(function (r) {
    var hit = get(r.proposedNas);
    if (!hit) return Object.assign({}, r, { state: 'new', existingSize: null, selected: true });
    if (Number(hit.size) === Number(r.size)) {
      return Object.assign({}, r, { state: 'identical', existingSize: hit.size, selected: false });
    }
    return Object.assign({}, r, { state: 'different', existingSize: hit.size, selected: false });
  });
}

function renderCopyReview() {
  var counts = { new: 0, identical: 0, different: 0 };
  COPY_ROWS.forEach(function (r) { counts[r.state]++; });
  var sel = COPY_ROWS.filter(function (r) { return r.selected; });
  var bytes = sel.reduce(function (a, r) { return a + r.size; }, 0);

  $('copyHint').innerHTML =
    '<b>' + counts.new + '</b> not on the NAS · ' +
    '<b>' + counts.identical + '</b> already there at the same size · ' +
    '<b>' + counts.different + '</b> there but a different size.';

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
        (r.state === 'identical' ? ' title="already on the NAS at the same size"' : '') + '>' +
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
  $('copyBar').hidden = true;
  $('copyCancel').hidden = true;
  $('copyDry').disabled = false;
  $('copyDlg').showModal();

  // Ask the filesystem, not the earlier index: the destination may be a folder
  // that was never part of the comparison.
  var existing = await window.mapper.inspectDest(rows.map(function (r) { return r.proposedNas; }));
  COPY_ROWS = classifyAgainstDest(rows, existing || {});
  renderCopyReview();
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
    if (!n || !PROFILE_FILE) n = window.prompt('Profile name', n || 'Default');
    if (n) {
      await saveProfile(n);
      $('main').insertAdjacentHTML('afterbegin',
        '<div class="note"><b>Profile saved.</b> It will load automatically if you set it as default.</div>');
    }
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
  $('btnManifest').addEventListener('click', async function () {
    var f = await window.mapper.pickManifest();
    if (f) { MANIFEST = f; setAccuracy('exact', null); $('accText').textContent = f; }
  });
  $('btnCompare').addEventListener('click', runCompare);
  $('btnExport').addEventListener('click', async function () {
    var r = await window.mapper.exportReports();
    if (r && r.ok) {
      $('main').insertAdjacentHTML('afterbegin',
        '<div class="note"><b>Reports written</b> to ' + esc(r.outDir) +
        ' — including a copy plan that only ever adds files.</div>');
    }
  });
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
  $('mapNew').addEventListener('click', async function () {
    var p = await window.mapper.pickFolder('Choose where the new files should go', false);
    if (p && p.length) { MAP_TARGET = p[0]; renderMap(); }
  });
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
