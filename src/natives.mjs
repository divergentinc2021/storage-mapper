/**
 * Google-native stub detection.
 *
 * Google Drive for Desktop does NOT place documents on disk. A Doc/Sheet/Slide
 * appears as a few-hundred-byte JSON file with a `.gdoc`/`.gsheet`/`.gslides`
 * extension containing only a URL and a doc id. Copy one to the NAS and you have
 * archived a dead link, not a document — and it looks like a real file in
 * Explorer, which is why this step exists.
 *
 * These can never be copied. They have to be exported through the Drive API
 * (or rclone --drive-export-formats). This module classifies them and says what
 * each one would have to become.
 */
import { readFileSync } from 'node:fs';

/** extension → { kind, exportAs }. exportAs null = Google offers no export path. */
export const NATIVE_KINDS = {
  '.gdoc':    { kind: 'Google Docs',       exportAs: 'docx' },
  '.gsheet':  { kind: 'Google Sheets',     exportAs: 'xlsx' },
  '.gslides': { kind: 'Google Slides',     exportAs: 'pptx' },
  '.gdraw':   { kind: 'Google Drawings',   exportAs: 'svg'  },
  '.gjam':    { kind: 'Google Jamboard',   exportAs: 'pdf'  },
  '.gscript': { kind: 'Apps Script',       exportAs: 'json' },
  '.gform':   { kind: 'Google Forms',      exportAs: null   },
  '.gsite':   { kind: 'Google Sites',      exportAs: null   },
  '.gmap':    { kind: 'Google My Maps',    exportAs: null   },
  '.gtable':  { kind: 'Google Tables',     exportAs: null   },
  '.glink':   { kind: 'Drive shortcut',    exportAs: null   },
  /*
   * Google Vids. Missing from this table until a real copy tried to move six of
   * them to a NAS and robocopy failed every one with "Incorrect function" —
   * ERROR_INVALID_FUNCTION, which is what Drive for Desktop returns when asked
   * for the bytes of a file that has none. They are 174 bytes on disk and cannot
   * even be read, so unlike a .gdoc stub there is no doc id to recover.
   *
   * The note is spelled out rather than generated: Vids exports as MP4 from its
   * own editor, and claiming a Drive API export format here would send someone
   * after a path this tool has not verified exists.
   */
  '.gvid':    { kind: 'Google Vids',       exportAs: null,
                note: 'no file to copy — open it in Google Vids and use Download → MP4 if you need an archive copy' },
};

/** Stubs are tiny. Anything larger is a real file that merely shares the name. */
const MAX_STUB_BYTES = 16 * 1024;

export function isNativeExt(ext) {
  return Object.prototype.hasOwnProperty.call(NATIVE_KINDS, ext.toLowerCase());
}

/**
 * Pull the Drive file id out of a stub so it can be joined to the API manifest.
 * Never throws — a stub we cannot parse is still a stub.
 */
export function readStubDocId(absPath, size) {
  if (size > MAX_STUB_BYTES) return null;
  try {
    const raw = readFileSync(absPath, 'utf8');
    try {
      const j = JSON.parse(raw);
      if (j.doc_id) return String(j.doc_id);
      if (j.resource_id) return String(j.resource_id).replace(/^.*:/, '');
    } catch {
      // Some stubs are INI-ish rather than JSON; fall through to the regex.
    }
    const m = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(raw) || /"doc_id"\s*:\s*"([^"]+)"/.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function classifyNative(ext, absPath, size) {
  const spec = NATIVE_KINDS[ext.toLowerCase()];
  if (!spec) return null;
  return {
    kind: spec.kind,
    exportAs: spec.exportAs,
    docId: readStubDocId(absPath, size),
    note: spec.note || (spec.exportAs
      ? `export via Drive API as .${spec.exportAs} — copying the stub archives a dead link`
      : 'no export path exists; this must stay in Google Drive'),
  };
}
