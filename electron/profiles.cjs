/**
 * Profiles.
 *
 * A profile is split in two on purpose:
 *
 *   shared — aliases and mapping rules. Machine-independent, and the part worth
 *            sharing: it is the accumulated knowledge that "UIH Dental" and
 *            "u0004_Custom_Haptic_VR_Dentistry" are one project.
 *   local  — drive roots, NAS roots, manifest path. Absolute and machine-bound:
 *            H:\ on one PC is not H:\ on another, and nothing on a Mac.
 *
 * Importing a shared profile therefore merges the knowledge and leaves your
 * paths alone. Copying someone else's drive letters over yours would just break
 * the app, so it is offered separately and never done silently.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const SCHEMA = 1;

function dirFor(app) {
  const d = path.join(app.getPath('userData'), 'profiles');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const settingsFile = (app) => path.join(app.getPath('userData'), 'settings.json');
const safeName = (n) => String(n || 'profile').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 60);

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}

/** Hash of the shared half only — local paths changing must not look like an update. */
function sharedHash(p) {
  const shared = (p && p.shared) || { aliases: [], map: [] };
  return crypto.createHash('sha256')
    .update(JSON.stringify({ aliases: shared.aliases || [], map: shared.map || [] }))
    .digest('hex').slice(0, 16);
}

function empty(name) {
  return {
    schema: SCHEMA,
    name: name || 'Default',
    updatedAt: new Date().toISOString(),
    updatedBy: `${os.userInfo().username}@${os.hostname()}`,
    shared: { aliases: [], map: [] },
    local: { driveRoots: [], nasRoots: [], manifestPath: null },
  };
}

function normalize(p, name) {
  if (!p || typeof p !== 'object') return empty(name);
  // Tolerate the flat v0.2 shape so an older mapping.json is not lost.
  if (!p.shared && (p.aliases || p.map)) {
    return {
      schema: SCHEMA, name: p.name || name || 'Default',
      updatedAt: p.updatedAt || new Date().toISOString(),
      updatedBy: p.updatedBy || 'migrated from v0.2',
      shared: { aliases: p.aliases || [], map: p.map || [] },
      local: {
        driveRoots: p.driveRoots || [], nasRoots: p.nasRoots || [],
        manifestPath: p.manifestPath || null,
      },
    };
  }
  return {
    schema: SCHEMA, name: p.name || name || 'Default',
    updatedAt: p.updatedAt || new Date().toISOString(),
    updatedBy: p.updatedBy || 'unknown',
    shared: { aliases: (p.shared && p.shared.aliases) || [], map: (p.shared && p.shared.map) || [] },
    local: {
      driveRoots: (p.local && p.local.driveRoots) || [],
      nasRoots: (p.local && p.local.nasRoots) || [],
      manifestPath: (p.local && p.local.manifestPath) || null,
    },
  };
}

function list(app) {
  const d = dirFor(app);
  const settings = readJson(settingsFile(app), {});
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = normalize(readJson(path.join(d, f), null), path.basename(f, '.json'));
      return {
        file: path.join(d, f), name: p.name, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
        isDefault: settings.defaultProfile === path.join(d, f),
        counts: {
          aliases: p.shared.aliases.length, map: p.shared.map.length,
          driveRoots: p.local.driveRoots.length, nasRoots: p.local.nasRoots.length,
        },
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function save(app, profile) {
  const p = normalize(profile);
  p.updatedAt = new Date().toISOString();
  p.updatedBy = `${os.userInfo().username}@${os.hostname()}`;
  const file = path.join(dirFor(app), `${safeName(p.name)}.json`);
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
  return { file, profile: p };
}

function load(app, file) { return normalize(readJson(file, null)); }

function remove(app, file) {
  fs.unlinkSync(file);
  const s = readJson(settingsFile(app), {});
  if (s.defaultProfile === file) { delete s.defaultProfile; writeSettings(app, s); }
}

function writeSettings(app, s) {
  fs.writeFileSync(settingsFile(app), JSON.stringify(s, null, 2) + '\n');
}
function getSettings(app) { return readJson(settingsFile(app), {}); }

function setDefault(app, file) {
  const s = getSettings(app);
  s.defaultProfile = file;
  writeSettings(app, s);
}

/** Export the portable half only, unless the caller asks to include paths. */
function exportProfile(profile, file, includeLocal) {
  const p = normalize(profile);
  const payload = {
    schema: SCHEMA, name: p.name, updatedAt: new Date().toISOString(),
    updatedBy: `${os.userInfo().username}@${os.hostname()}`,
    shared: p.shared,
    local: includeLocal ? p.local : { driveRoots: [], nasRoots: [], manifestPath: null },
    note: includeLocal
      ? 'Includes machine-specific paths. They will not exist on another computer.'
      : 'Portable: aliases and mapping rules only. Paths stay local to each machine.',
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

/**
 * Compare a shared profile on disk with what we last applied.
 * Returns null when there is nothing new, so the caller can stay silent.
 */
function checkShared(app) {
  const s = getSettings(app);
  if (!s.sharedProfilePath) return null;
  if (!fs.existsSync(s.sharedProfilePath)) {
    return { status: 'missing', path: s.sharedProfilePath };
  }
  const incoming = normalize(readJson(s.sharedProfilePath, null));
  const hash = sharedHash(incoming);
  if (s.sharedProfileHash === hash) return null;

  const cur = s.lastAppliedShared || { aliases: [], map: [] };
  const key = (a) => JSON.stringify(a);
  const curAliases = new Set((cur.aliases || []).map(key));
  const curMap = new Set((cur.map || []).map((m) => `${m.drive}=>${m.nas}`));
  return {
    status: 'updated',
    path: s.sharedProfilePath,
    hash,
    name: incoming.name,
    updatedAt: incoming.updatedAt,
    updatedBy: incoming.updatedBy,
    incoming: incoming.shared,
    added: {
      aliases: (incoming.shared.aliases || []).filter((a) => !curAliases.has(key(a))),
      map: (incoming.shared.map || []).filter((m) => !curMap.has(`${m.drive}=>${m.nas}`)),
    },
  };
}

function markSharedApplied(app, hash, shared) {
  const s = getSettings(app);
  s.sharedProfileHash = hash;
  s.lastAppliedShared = shared;
  writeSettings(app, s);
}

function setSharedPath(app, p) {
  const s = getSettings(app);
  if (p) s.sharedProfilePath = p; else { delete s.sharedProfilePath; delete s.sharedProfileHash; }
  writeSettings(app, s);
}

module.exports = {
  SCHEMA, empty, normalize, list, save, load, remove,
  getSettings, setDefault, exportProfile, checkShared, markSharedApplied,
  setSharedPath, sharedHash,
};
