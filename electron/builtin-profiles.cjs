/**
 * Profiles that ship with the app.
 *
 * Almost everyone here starts from the same three arrangements — the shared
 * drives, My Drive, and the whole projects tree — and rebuilding the root lists
 * by hand on each machine is both tedious and the easiest place to make a
 * mistake nobody notices until a compare reports thousands of false "new"
 * files.
 *
 * These are SEEDED, not hardcoded behaviour: on first run they are written into
 * the profiles folder as ordinary files. From that moment they belong to the
 * user — editable, renamable, deletable — and the app never rewrites them.
 * Anything else would mean losing your edits on every update.
 *
 * The paths are H:\ and Z:\ because that is the arrangement this is built for.
 * On a machine where they do not exist the profile simply lists roots that are
 * not there, which Compare already refuses loudly rather than treating as empty.
 */
const DRIVE = 'H:\\Shared drives';
const PROJECTS = `${DRIVE}\\UIZ - PROJECTS`;

/* The six project trees, and where each one lives on the NAS. */
const PROJECT_TREES = [
  'External Client Projects',
  'Internal UIZ Projects',
  'Meeting_Minutes_Clients',
  'Internal UWC Projects',
  'UIZ_DailyStandUps',
  'UIZ_Kitty-Fund',
];

const BUILTINS = [
  {
    name: 'ProjectsOnAllDrives',
    local: {
      driveRoots: PROJECT_TREES.map((t) => `${PROJECTS}\\${t}`),
      nasRoots: PROJECT_TREES.map((t) => `Z:\\${t}`),
      convertedRoots: ['H:\\My Drive\\_Converted for NAS'],
      manifestPath: null,
    },
  },
  {
    name: 'Shared drives',
    local: {
      driveRoots: [DRIVE],
      nasRoots: ['Z:\\SHARED DRIVES'],
      convertedRoots: ['H:\\My Drive\\_Converted for NAS'],
      manifestPath: null,
    },
  },
  {
    name: 'My Drive',
    local: {
      driveRoots: ['H:\\My Drive'],
      nasRoots: ['Z:\\MYDRIVE_Studiouih'],
      convertedRoots: ['H:\\My Drive\\_Converted for NAS'],
      manifestPath: null,
    },
  },
];

/**
 * Write the built-ins once, the first time the app runs.
 *
 * Keyed on a settings flag rather than "is the folder empty", so deleting a
 * profile you do not want does not bring it back on the next launch.
 */
function seed(app, profiles) {
  const settings = profiles.getSettings(app);
  if (settings.builtinsSeeded) return { seeded: 0 };

  let seeded = 0;
  const existing = new Set(profiles.list(app).map((p) => String(p.name).toLowerCase()));
  for (const b of BUILTINS) {
    if (existing.has(b.name.toLowerCase())) continue;   // never clobber a real one
    profiles.save(app, {
      name: b.name,
      shared: { aliases: [], map: [] },
      local: b.local,
    });
    seeded++;
  }

  const s = profiles.getSettings(app);
  s.builtinsSeeded = true;
  // Only pick a default if the user has none; otherwise theirs stands.
  if (!s.defaultProfile) {
    const mine = profiles.list(app).find((p) => p.name === 'ProjectsOnAllDrives');
    if (mine) s.defaultProfile = mine.file;
  }
  profiles.writeSettings(app, s);
  return { seeded };
}

module.exports = { BUILTINS, seed, PROJECT_TREES };
