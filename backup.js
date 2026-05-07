const { isSafeBasename } = require('./safety.js');

// Manifest version bump = breaking change to the backup format. Older apps
// must refuse to restore newer versions; newer apps may accept older ones if
// they handle the diff. v1 = initial format described in #32.
const MANIFEST_VERSION = 1;

function buildManifest({ bookCount, createdAt = new Date().toISOString() } = {}) {
  return {
    version: MANIFEST_VERSION,
    app: 'airshelf',
    createdAt,
    bookCount,
  };
}

// Pure validator over a parsed-zip view: caller extracts manifest.json and
// books.json from the archive, plus the list of relative names under books/,
// and hands them in. Keeping I/O at the boundary makes this trivially
// testable without on-disk fixtures and lets the same checks run on a
// stream-decompressed zip later if we move off adm-zip.
//
// Returns { ok: true } or { ok: false, error }.
function validateBackup({ manifest, meta, fileNames }) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'Not an Airshelf backup (no manifest.json).' };
  }
  if (manifest.app !== 'airshelf') {
    return { ok: false, error: 'Not an Airshelf backup.' };
  }
  if (typeof manifest.version !== 'number') {
    return { ok: false, error: 'Backup manifest is corrupt (missing version).' };
  }
  if (manifest.version > MANIFEST_VERSION) {
    return {
      ok: false,
      error: `Backup format v${manifest.version} is newer than this app supports (v${MANIFEST_VERSION}). Update Airshelf and try again.`,
    };
  }
  if (!meta || !Array.isArray(meta.books)) {
    return { ok: false, error: 'Backup books.json is malformed.' };
  }
  // Path-traversal defence: reject any metadata entry whose file/originalFile/
  // cover isn't a single safe basename. Mirrors the loadMeta() filter — a
  // tampered backup with `file: "../../etc/passwd"` would otherwise leak.
  for (const b of meta.books) {
    if (!b || !isSafeBasename(b.file)) {
      return { ok: false, error: `Backup contains unsafe entry: file=${b && b.file}` };
    }
    if (b.originalFile != null && !isSafeBasename(b.originalFile)) {
      return { ok: false, error: `Backup contains unsafe entry: originalFile=${b.originalFile}` };
    }
    if (b.cover != null && !isSafeBasename(b.cover)) {
      return { ok: false, error: `Backup contains unsafe entry: cover=${b.cover}` };
    }
  }
  if (!Array.isArray(fileNames)) {
    return { ok: false, error: 'Backup file list is malformed.' };
  }
  // Reject any file under books/ that isn't a flat basename — adm-zip will
  // happily extract `books/../../etc/passwd` if we don't gate the entries.
  for (const name of fileNames) {
    if (!isSafeBasename(name)) {
      return { ok: false, error: `Backup contains unsafe path: books/${name}` };
    }
  }
  return { ok: true };
}

module.exports = { MANIFEST_VERSION, buildManifest, validateBackup };
