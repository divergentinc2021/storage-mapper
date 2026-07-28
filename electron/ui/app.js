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
var OVERLAP = [];
var TAB = 'duplicates';
var REMAP = null;              // { mode, row, selected }
var MAX_ROWS = 1000;           // render cap; the CSV export always has everything

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

function renderTab() {
  var m = $('main');
  if (!RESULT) return;

  if (TAB === 'duplicates') {
    m.innerHTML = table(['Drive file', 'Already on NAS at', 'Size', 'Matched by'],
      RESULT.duplicates, function (r) {
        var weak = r.tier && r.tier.indexOf('md5') === -1;
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + esc(r.nasPath) + '</td>' +
          '<td class="num">' + fmtBytes(r.size) + '</td>' +
          '<td><span class="tier ' + (weak ? 'weak' : 'md5') + '">' + esc(r.tier) + '</span></td></tr>';
      });
  } else if (TAB === 'new') {
    m.innerHTML = table(['Drive file', 'Proposed NAS destination', 'Size', ''],
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
    m.innerHTML = table(['Drive file', 'NAS file', 'Drive size', 'NAS size', 'Why'],
      RESULT.conflicts, function (r) {
        return '<tr><td class="path">' + esc(r.drivePath) + '</td>' +
          '<td class="path">' + esc(r.nasPath) + '</td>' +
          '<td class="num">' + fmtBytes(r.driveSize) + '</td>' +
          '<td class="num">' + fmtBytes(r.nasSize) + '</td>' +
          '<td>' + esc(r.reason) + '</td></tr>';
      });
  } else if (TAB === 'natives') {
    m.innerHTML =
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
    m.innerHTML =
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
  MAPPING = await window.mapper.loadMapping();
  MAPPING.aliases = MAPPING.aliases || [];
  MAPPING.map = MAPPING.map || [];
  renderPaths();

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
