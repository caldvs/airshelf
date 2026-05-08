import { isSafeBasename } from '../lib/safety.js';

// Manifest version bump = breaking change to the backup format. Older apps
// must refuse to restore newer versions; newer apps may accept older ones if
// they handle the diff. v1 = initial format described in #32.
export const MANIFEST_VERSION = 1;

export interface BackupManifest {
  version: number;
  app: 'airshelf';
  createdAt: string;
  bookCount: number;
}

interface BuildManifestArgs {
  bookCount: number;
  createdAt?: string;
}

export function buildManifest({
  bookCount,
  createdAt = new Date().toISOString(),
}: BuildManifestArgs): BackupManifest {
  return {
    version: MANIFEST_VERSION,
    app: 'airshelf',
    createdAt,
    bookCount,
  };
}

// Loose shapes — the inputs come from JSON.parse on untrusted backup
// archives, so we use `unknown` for the entry point and narrow in the body.
interface BackupBookEntry {
  file?: unknown;
  originalFile?: unknown;
  cover?: unknown;
}

interface ValidateBackupArgs {
  manifest: unknown;
  meta: unknown;
  fileNames: unknown;
}

export type ValidateBackupResult = { ok: true } | { ok: false; error: string };

// Pure validator over a parsed-zip view: caller extracts manifest.json and
// books.json from the archive, plus the list of relative names under books/,
// and hands them in. Keeping I/O at the boundary makes this trivially
// testable without on-disk fixtures and lets the same checks run on a
// stream-decompressed zip later if we move off adm-zip.
export function validateBackup({
  manifest,
  meta,
  fileNames,
}: ValidateBackupArgs): ValidateBackupResult {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'Not an Airshelf backup (no manifest.json).' };
  }
  const m = manifest as Partial<BackupManifest>;
  if (m.app !== 'airshelf') {
    return { ok: false, error: 'Not an Airshelf backup.' };
  }
  if (typeof m.version !== 'number') {
    return { ok: false, error: 'Backup manifest is corrupt (missing version).' };
  }
  if (m.version > MANIFEST_VERSION) {
    return {
      ok: false,
      error: `Backup format v${m.version} is newer than this app supports (v${MANIFEST_VERSION}). Update Airshelf and try again.`,
    };
  }
  if (!meta || typeof meta !== 'object' || !Array.isArray((meta as { books?: unknown }).books)) {
    return { ok: false, error: 'Backup books.json is malformed.' };
  }
  if (!Array.isArray(fileNames)) {
    return { ok: false, error: 'Backup file list is malformed.' };
  }
  // Reject any file under books/ that isn't a flat basename — adm-zip will
  // happily extract `books/../../etc/passwd` if we don't gate the entries.
  // Done before the metadata cross-checks so the error message points at
  // the unsafe file rather than at a "missing reference" caused by it.
  for (const name of fileNames) {
    if (!isSafeBasename(name)) {
      return { ok: false, error: `Backup contains unsafe path: books/${name}` };
    }
  }
  // macOS APFS/HFS+ default to case-insensitive: `Foo.epub` and `foo.epub`
  // would clobber each other on extraction. Refuse the backup outright so
  // restoring on macOS doesn't silently lose one of the pair.
  const lcSeen = new Set<string>();
  for (const name of fileNames as string[]) {
    const lc = name.toLowerCase();
    if (lcSeen.has(lc)) {
      return { ok: false, error: `Backup contains case-insensitive duplicate: books/${name}` };
    }
    lcSeen.add(lc);
  }
  const fileSet = new Set(fileNames as string[]);
  // Path-traversal defence + cross-reference. Reject any metadata entry
  // whose file/originalFile/cover isn't a single safe basename (mirrors the
  // loadMeta() filter), and require every referenced name to actually be
  // present under books/ in the archive — otherwise restore would produce
  // a broken library where /download throws on a missing file.
  for (const b of (meta as { books: BackupBookEntry[] }).books) {
    if (!b || !isSafeBasename(b.file)) {
      return { ok: false, error: `Backup contains unsafe entry: file=${b && b.file}` };
    }
    if (!fileSet.has(b.file)) {
      return { ok: false, error: `Backup is missing referenced file: ${b.file}` };
    }
    if (b.originalFile != null) {
      if (!isSafeBasename(b.originalFile)) {
        return {
          ok: false,
          error: `Backup contains unsafe entry: originalFile=${b.originalFile}`,
        };
      }
      if (!fileSet.has(b.originalFile)) {
        return {
          ok: false,
          error: `Backup is missing referenced originalFile: ${b.originalFile}`,
        };
      }
    }
    if (b.cover != null) {
      if (!isSafeBasename(b.cover)) {
        return { ok: false, error: `Backup contains unsafe entry: cover=${b.cover}` };
      }
      if (!fileSet.has(b.cover)) {
        return { ok: false, error: `Backup is missing referenced cover: ${b.cover}` };
      }
    }
  }
  return { ok: true };
}
