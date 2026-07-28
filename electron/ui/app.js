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
  renderCounts();
  renderTab();
}

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
    m.innerHTML = droppedNote() + table(['Drive file', 'Proposed NAS destination', 'Size', ''],
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

  if (mode === 'dest') {
    $('remapTitle').textContent = 'Set a destination';
    $('remapHint').innerHTML =
      'Everything under <b>' + esc(parentOf(row.drivePath) || '(root)') + '</b> will be mapped ' +
      'to the NAS path you type. Keeping a <code>_fromDrive</code> leaf means incoming ' +
      'material lands beside the curated content instead of merged into it.';
    $('remapInput').placeholder = 'e.g. Projects/Internal UWC Projects/Loggerhead Turtle Project/_fromDrive';
    $('remapInput').value = row.proposedNas || '';
    $('remapSave').disabled = false;
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
  $('remapDlg').close();
  // The rule only takes effect on a re-run, so say so rather than implying the
  // table on screen already reflects it.
  $('main').insertAdjacentHTML('afterbegin',
    '<div class="note"><b>Rule saved.</b> Hit Compare again to apply it.</div>');
}

// ── wiring ──────────────────────────────────────────────────────────────────
async function init() {
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

  if (boot.shared && boot.shared.status === 'updated') showSharedDialog(boot.shared);

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

  $('remapInput').addEventListener('input', searchNas);
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
