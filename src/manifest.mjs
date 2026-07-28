/**
 * The Drive half of the index.
 *
 * Checksums come from the Drive API manifest, never from the filesystem: the
 * API returns md5Checksum in the file listing at no cost, whereas reading the
 * same bytes through a Drive for Desktop mount would download them.
 *
 * Accepts the CSV exported by the Google Drive Storage Explorer dashboard.
 * `md5` is optional — without it the matcher falls back to size+name, which is
 * weaker but still useful.
 */
import { readFileSync } from 'node:fs';

/** RFC4180-ish parser: handles quoted fields, embedded commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim() !== '');
}

export function loadManifest(csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  if (!rows.length) return emptyManifest();
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);

  const iId = col('drive_id'), iName = col('name'), iPath = col('path');
  const iBytes = col('bytes'), iMime = col('mime'), iCls = col('class');
  const iExport = col('export_as');
  // md5 is the column the dashboard has to be extended to emit.
  const iMd5 = [col('md5'), col('md5checksum'), col('md5_checksum')].find((i) => i >= 0) ?? -1;

  const byId = new Map(), byMd5 = new Map(), bySize = new Map();
  let withMd5 = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const rec = {
      id: iId >= 0 ? row[iId] : '',
      name: iName >= 0 ? row[iName] : '',
      path: iPath >= 0 ? row[iPath] : '',
      size: iBytes >= 0 ? Number(row[iBytes] || 0) : 0,
      mime: iMime >= 0 ? row[iMime] : '',
      cls: iCls >= 0 ? row[iCls] : '',
      exportAs: iExport >= 0 ? row[iExport] : '',
      md5: iMd5 >= 0 ? (row[iMd5] || '').trim().toLowerCase() : '',
    };
    if (rec.id) byId.set(rec.id, rec);
    if (rec.md5) {
      withMd5++;
      if (!byMd5.has(rec.md5)) byMd5.set(rec.md5, []);
      byMd5.get(rec.md5).push(rec);
    }
    if (rec.size > 0) {
      if (!bySize.has(rec.size)) bySize.set(rec.size, []);
      bySize.get(rec.size).push(rec);
    }
  }
  return { byId, byMd5, bySize, count: byId.size, withMd5 };
}

export function emptyManifest() {
  return { byId: new Map(), byMd5: new Map(), bySize: new Map(), count: 0, withMd5: 0 };
}
