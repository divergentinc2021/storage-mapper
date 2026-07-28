/**
 * Browser preview of the Electron renderer.
 *
 * Reads electron/ui/* verbatim and swaps in a mock window.mapper, so the UI
 * under test is the same bytes that ship — no second copy to drift. Lets the
 * whole interface be exercised without packaging or a NAS.
 *
 * Usage: node tools/build_preview.mjs && open preview/index.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = join(ROOT, 'electron', 'ui');
const read = (f) => readFileSync(join(UI, f), 'utf8');

const html = read('index.html');
const css = read('styles.css');
const app = read('app.js');

const MOCK = `
<script>
/* Mock of the preload bridge. Shapes match electron/preload.cjs exactly. */
var MK_NAS = [
  { abs: 'Z:/Projects/Internal UWC Projects/Preclinical Dental Education VR & Haptics/scan_001.mp4', base: 'scan_001.mp4', size: 5368709120, root: 'Z:/Projects' },
  { abs: 'Z:/Projects/Internal UWC Projects/Preclinical Dental Education VR & Haptics/TAKE_FINAL_v2.mov', base: 'TAKE_FINAL_v2.mov', size: 2411724800, root: 'Z:/Projects' },
  { abs: 'Z:/Projects/Internal UIZ Projects/YouTube/launch_cut.mp4', base: 'launch_cut.mp4', size: 1288490188, root: 'Z:/Projects' },
  { abs: 'Z:/Resources/Projects/u0004_Custom_Haptic_VR_Dentistry/scan_001.mp4', base: 'scan_001.mp4', size: 5368709120, root: 'Z:/Resources/Projects' },
  { abs: 'Z:/Resources/Projects/ird0001_general_vr_development/unity_build.zip', base: 'unity_build.zip', size: 894784853, root: 'Z:/Resources/Projects' }
];

var MK_RESULT = {
  duplicates: [
    { drivePath: 'Shared drives/UIH Dental/scan_001.mp4', nasPath: MK_NAS[0].abs, name: 'scan_001.mp4', size: 5368709120, tier: 'md5', md5: 'a1b2c3' },
    { drivePath: 'Shared drives/UIH Dental/take_final.mov', nasPath: MK_NAS[1].abs, name: 'take_final.mov', size: 2411724800, tier: 'md5', md5: 'd4e5f6' },
    { drivePath: 'Shared drives/UIZ Media/launch_cut.mp4', nasPath: MK_NAS[2].abs, name: 'launch_cut.mp4', size: 1288490188, tier: 'size+name', md5: '' }
  ],
  new: [
    { drivePath: 'Shared drives/UIH Dental/newclip_2026.mp4', name: 'newclip_2026.mp4', size: 3221225472, proposedNas: 'Projects/Internal UWC Projects/Preclinical Dental Education VR & Haptics/_fromDrive/newclip_2026.mp4', mappedBy: 'Shared drives/UIH Dental' },
    { drivePath: 'Shared drives/Loggerhead/turtle_survey_raw.mov', name: 'turtle_survey_raw.mov', size: 11811160064, proposedNas: '', mappedBy: '(unmapped)' },
    { drivePath: 'My Drive/Military_Public_Bundle_ValuePlan_Part2.zip', name: 'Military_Public_Bundle_ValuePlan_Part2.zip', size: 12026243481, proposedNas: '', mappedBy: '(unmapped)' }
  ],
  conflicts: [
    { drivePath: 'Shared drives/UIH Dental/report.mp4', nasPath: 'Z:/Projects/Internal UWC Projects/Preclinical Dental Education VR & Haptics/report.mp4', name: 'report.mp4', driveSize: 429496729, nasSize: 429496729, reason: 'md5 differs at equal size+name' }
  ],
  natives: [
    { drivePath: 'Shared drives/UIH Dental/Budget.gsheet', name: 'Budget.gsheet', kind: 'Google Sheets', exportAs: 'xlsx', docId: 'SHEET123', note: 'export via Drive API as .xlsx' },
    { drivePath: 'My Drive/Notes.gdoc', name: 'Notes.gdoc', kind: 'Google Docs', exportAs: 'docx', docId: 'DOC456', note: 'export via Drive API as .docx' },
    { drivePath: 'My Drive/Open Day Signup.gform', name: 'Open Day Signup.gform', kind: 'Google Forms', exportAs: '', docId: 'FORM789', note: 'no export path exists; this must stay in Google Drive' }
  ],
  errors: [],
  stats: { driveFiles: 5513, nasFiles: 18240, hashedFiles: 61, hashedBytes: 41231686041, manifestRecords: 5513, manifestWithMd5: 5355 }
};

var MK_OVERLAP = [
  { name: 'scan_001.mp4', size: 5368709120, copies: 2, paths: MK_NAS[0].abs + ' | ' + MK_NAS[3].abs }
];

var MK_MAPPING = { nasRoots: [], driveRoots: [], aliases: [], map: [] };

var MK_PROFILES = [{
  file: '/mock/UIZ.json', name: 'UIZ Windows', updatedAt: '2026-07-28T20:00:00Z',
  updatedBy: 'laure@UIZ-PC', isDefault: true,
  counts: { aliases: 4, map: 6, driveRoots: 11, nasRoots: 4 },
  full: {
    schema: 1, name: 'UIZ Windows',
    shared: { aliases: [['UIH Dental','u0004_Custom_Haptic_VR_Dentistry']], map: [] },
    local: { driveRoots: ['H:/My Drive','H:/Shared drives'], nasRoots: ['Z:/Projects'], manifestPath: null }
  }
}];

var MK_SHARED = {
  status: 'updated', path: 'Z:/UIZ/storage-mapper/team.smprofile.json', hash: 'abc123',
  name: 'UIZ Team', updatedAt: '2026-07-28T19:30:00Z', updatedBy: 'bianca@UIZ-PC2',
  incoming: { aliases: [['UIH Dental','u0004_Custom_Haptic_VR_Dentistry'],['IZ_YouTube_Project','YouTube']], map: [{ drive:'Shared drives/UIZ - PROJECTS', nas:'Projects/Internal UIZ Projects/_fromDrive' }] },
  added: { aliases: [['IZ_YouTube_Project','YouTube']], map: [{ drive:'Shared drives/UIZ - PROJECTS', nas:'Projects/Internal UIZ Projects/_fromDrive' }] }
};
var MK_MANIFEST = null;

window.mapper = {
  pickFolder: function (title, multi) {
    var picks = /Google Drive/i.test(title || '')
      ? ['G:/Shared drives', 'G:/My Drive']
      : ['Z:/Projects', 'Z:/Resources/Projects'];
    return Promise.resolve(multi ? picks : [picks[0]]);
  },
  pickManifest: function () { MK_MANIFEST = 'C:/Users/laure/Downloads/studiodrive-manifest.csv'; return Promise.resolve(MK_MANIFEST); },
  compare: function () {
    var steps = [
      { type:'progress', phase:'nas', text:'Indexing NAS…' },
      { type:'progress', phase:'drive', text:'Indexing Google Drive (metadata only)…' },
      { type:'progress', phase:'match', done:2500, total:5513, hashed:31, text:'2500/5513 compared · 31 NAS files hashed' }
    ];
    steps.forEach(function (s, i) { setTimeout(function () { (window.__prog||[]).forEach(function(cb){cb(s);}); }, 120 * (i+1)); });
    return new Promise(function (res) {
      setTimeout(function () {
        res({ type:'done', result: MK_RESULT, overlap: MK_OVERLAP, nasIndex: MK_NAS,
              droppedRoots: [{ root:'H:/Shared drives/UIZ - PROJECTS', insideOf:'H:/Shared drives' }],
              accuracy: MK_MANIFEST ? 'exact' : 'approximate',
              manifestStats: { count: 5513, withMd5: MK_MANIFEST ? 5355 : 0 } });
      }, 520);
    });
  },
  searchNas: function (q, size) {
    q = String(q||'').toLowerCase();
    return Promise.resolve(MK_NAS.filter(function (f) {
      return (q && f.base.toLowerCase().indexOf(q) !== -1) || (size && f.size === size);
    }));
  },
  loadMapping: function () { return Promise.resolve(MK_MAPPING); },
  saveMapping: function (m) { MK_MAPPING = m; window.__savedMapping = m; return Promise.resolve('/mock/mapping.json'); },
  mappingPath: function () { return Promise.resolve('/mock/mapping.json'); },
  exportReports: function () { return Promise.resolve({ ok:true, outDir:'/mock/out', summary:{} }); },
  revealInFolder: function () { return Promise.resolve(); },
  splashSeen: function () { return Promise.resolve(true); },
  appInfo: function () { return Promise.resolve({ version: '0.4.1', engine: 'rsync', isWindows: false, electron: '33.4.11' }); },
  copyEngine: function () { return Promise.resolve({ engine: 'rsync', isWindows: false }); },
  copyRun: function (o) { return Promise.resolve({ ok: true, dryRun: !!o.dryRun, groups: 2, totalGroups: 2, failed: 0, copiedBytes: 3221225472, skipped: [], results: [], logFile: null, engine: 'rsync' }); },
  copyCancel: function () { return Promise.resolve(true); },
  onCopyEvent: function (cb) { window.__copyCb = cb; return function () {}; },
  profilesBoot: function () { return Promise.resolve({ profile: null, defaultFile: null, shared: MK_SHARED }); },
  profilesList: function () { return Promise.resolve(MK_PROFILES); },
  profilesSave: function (p) { window.__savedProfile = p; return Promise.resolve({ file: '/mock/p.json', profile: p }); },
  profilesLoad: function () { return Promise.resolve(MK_PROFILES[0].full); },
  profilesDelete: function () { return Promise.resolve(true); },
  profilesSetDefault: function () { return Promise.resolve(true); },
  profilesExport: function (p, incl) { window.__exported = { p: p, includeLocal: incl }; return Promise.resolve({ ok:true, file:'/mock/x.json' }); },
  profilesImport: function () { return Promise.resolve({ ok:true, file:'/mock/i.json', profile: MK_PROFILES[0].full }); },
  profilesSetShared: function () { return Promise.resolve({ ok:true, path:'Z:/UIZ/storage-mapper/team.smprofile.json', shared: MK_SHARED }); },
  profilesSharedApplied: function (h, sh) { window.__sharedApplied = { hash:h, shared:sh }; return Promise.resolve(true); },
  profilesSettings: function () { return Promise.resolve({ sharedProfilePath: 'Z:/UIZ/storage-mapper/team.smprofile.json' }); },
  onProgress: function (cb) { window.__prog = window.__prog || []; window.__prog.push(cb); return function(){}; }
};
</script>`;

const out = html
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace('<script src="app.js"></script>', `${MOCK}\n<script>\n${app}\n</script>`);

if (out.includes('src="app.js"')) {
  console.error('WARN: app.js was not inlined');
  process.exit(1);
}

mkdirSync(join(ROOT, 'preview'), { recursive: true });
writeFileSync(join(ROOT, 'preview', 'index.html'), out);
console.log('preview/index.html written');
