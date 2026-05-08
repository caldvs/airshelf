const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { Bonjour } = require('bonjour-service');
const { hashFileSha1 } = require('./lib/hash.js');
const { mapWithConcurrency, createSerialQueue } = require('./lib/concurrency.js');
const { readCalibreLibrary } = require('./calibre.js');

// FIFO around the two atomic load-then-write blocks in addBook (the
// dedup check at the start, and the push-to-meta at the end). Concurrent
// addBooks were racing each other: both load the same snapshot, both push
// their own book, the second save overwrites the first. Serialising those
// two bookends keeps both books in the file. Long file work (hash, copy,
// Calibre conversion) runs OUTSIDE the queue so addManyBooks concurrency
// isn't bottlenecked on this lock. The queue is NOT applied to every
// loadMeta/saveMeta call site in main.js — read-only paths and migration
// loops bypass it.
const metaQueue = createSerialQueue();

// Set the app name before anything else — this controls the bold label
// in the macOS menu bar (which otherwise reads "Electron" during dev).
app.name = 'Airshelf';

// Customise the About panel so it shows our icon and name instead of Electron's
app.setAboutPanelOptions({
  applicationName: 'Airshelf',
  applicationVersion: '0.1.0',
  version: '',
  copyright: 'Send ebooks to your Kindle over Wi-Fi',
  iconPath: path.join(__dirname, 'build', 'icon_256.png'),
});

const PORT = parseInt(process.env.PORT, 10) || 6790;

// Files the Kindle experimental browser can download directly
const { normalizeKindleMetadata } = require('./inject-asin.js');
const { titlesMatch, cleanTitle, extractSeries, guessAuthorFromFilename } = require('./titles.js');

const KINDLE_NATIVE_EXTS = ['.azw3', '.mobi', '.prc', '.azw', '.txt'];
// Extra formats Calibre can convert to MOBI for us
const CONVERTIBLE_EXTS = [
  '.epub',
  '.azw3',
  '.fb2',
  '.fbz',
  '.lit',
  '.lrf',
  '.pdb',
  '.pdf',
  '.rtf',
  '.docx',
  '.odt',
  '.html',
  '.htm',
  '.htmlz',
  '.chm',
  '.cbz',
  '.cbr',
];
const SUPPORTED_EXTS = [...KINDLE_NATIVE_EXTS, ...CONVERTIBLE_EXTS];

// Locate Calibre's ebook-convert / ebook-meta binaries.
//
// Auto-probe a few well-known macOS install locations; if the user has pointed
// us at a custom directory via the settings file (e.g. Calibre installed to
// ~/Applications), check that first. We resolve the *binary* path each call
// rather than caching, because the user may relocate Calibre while the app is
// running and we want the next conversion to pick up the new path.
const AUTO_CALIBRE_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Applications/calibre.app/Contents/MacOS',
];

function isExistingFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Probe order: user-saved dir first, then well-known auto locations. Both
// binaries must come from the same directory — a userDir that has only
// ebook-convert (e.g. partially broken install) shouldn't silently let
// ebook-meta fall through to /opt/homebrew/bin and produce a half-resolved
// "found" state where binDir doesn't actually own both tools.
function findCalibreBinDir() {
  const userDir = getCalibreUserBinDir();
  const dirs = userDir ? [userDir, ...AUTO_CALIBRE_BIN_DIRS] : AUTO_CALIBRE_BIN_DIRS;
  for (const dir of dirs) {
    if (
      isExistingFile(path.join(dir, 'ebook-convert')) &&
      isExistingFile(path.join(dir, 'ebook-meta'))
    )
      return dir;
  }
  return null;
}

function findEbookConvert() {
  const d = findCalibreBinDir();
  return d ? path.join(d, 'ebook-convert') : null;
}
function findEbookMeta() {
  const d = findCalibreBinDir();
  return d ? path.join(d, 'ebook-meta') : null;
}

// Returns the directory the user explicitly chose, or null if none / invalid.
// Validation is per-read because `ebook-convert` could have been moved/deleted
// since the path was saved.
function getCalibreUserBinDir() {
  const dir = loadSettings().calibreBinDir;
  if (!dir || typeof dir !== 'string') return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

// Inject a cover into an existing MOBI/EPUB using Calibre's ebook-meta.
// This is the reliable way to make the Kindle library show a thumbnail.
function setCoverMetadata(filePath, coverPath) {
  return new Promise((resolve) => {
    const bin = findEbookMeta();
    if (!bin || !fs.existsSync(filePath) || !fs.existsSync(coverPath)) {
      return resolve(false);
    }
    execFile(
      bin,
      [filePath, '--cover', coverPath],
      {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`ebook-meta cover inject failed for ${filePath}:`, stderr || err.message);
          return resolve(false);
        }
        resolve(true);
      },
    );
  });
}

// Extract a cover from any Calibre-supported format (AZW3, MOBI, PDF, etc.)
// via `ebook-meta --get-cover`. EPUB has its own direct zip-based extractor;
// this is the fallback for everything else.
function extractCoverViaCalibre(filePath, outPath) {
  return new Promise((resolve) => {
    const bin = findEbookMeta();
    if (!bin || !fs.existsSync(filePath)) return resolve(false);
    execFile(
      bin,
      [filePath, `--get-cover=${outPath}`],
      {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err) => {
        if (err) return resolve(false);
        try {
          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
            return resolve(true);
          }
        } catch {}
        resolve(false);
      },
    );
  });
}

// Downsize a cover image in place using macOS sips (or ignore if unavailable).
// Kindle browser renders large JPEGs slowly line-by-line, so we keep them small.
//
// Atomic: sips writes to a sibling .tmp path, then we rename over the original.
// Previously the source and destination were the same path; sips supports that,
// but a crash mid-write would have corrupted the cover with no backup.
function resizeCoverInPlace(filePath, maxDim = 500) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    try {
      const size = fs.statSync(filePath).size;
      if (size < 60 * 1024) return resolve(false); // already small
    } catch {
      return resolve(false);
    }

    const tmp = `${filePath}.resize.tmp`;
    execFile(
      '/usr/bin/sips',
      [
        '-Z',
        String(maxDim),
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '80',
        filePath,
        '--out',
        tmp,
      ],
      { timeout: 30000 },
      (err) => {
        if (err) {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          return resolve(false);
        }
        try {
          fs.renameSync(tmp, filePath);
          resolve(true);
        } catch (renameErr) {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          console.warn('resizeCoverInPlace: rename failed', renameErr.message);
          resolve(false);
        }
      },
    );
  });
}

// Convert any input to AZW3 (Amazon's KF8 format). We use AZW3 instead of
// MOBI because Kindle's library indexer treats .azw3 files as native
// Amazon ebooks and reliably generates library thumbnails for them, whereas
// .mobi files are treated as "Personal Documents" and thumbnail generation
// is best-effort.
function convertToAzw3(srcPath, outPath, coverPath = null) {
  return new Promise((resolve, reject) => {
    const bin = findEbookConvert();
    if (!bin) return reject(new Error('Calibre ebook-convert not found. Install Calibre.'));
    const args = [srcPath, outPath, '--output-profile', 'kindle_pw3'];
    if (coverPath && fs.existsSync(coverPath)) {
      args.push('--cover', coverPath);
    }
    execFile(
      bin,
      args,
      {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      },
    );
  });
}

// Backwards-compat alias used by older code paths
const convertToMobi = convertToAzw3;

// Build an EPUB for the in-app reader. epubjs needs raw EPUB; books that
// arrived as MOBI/AZW3/PDF get converted on first open and cached as
// `<id>.reader.epub`.
function convertToEpub(srcPath, outPath) {
  return new Promise((resolve, reject) => {
    const bin = findEbookConvert();
    if (!bin) return reject(new Error('Calibre ebook-convert not found. Install Calibre.'));
    execFile(
      bin,
      [srcPath, outPath, '--no-default-epub-cover'],
      {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      },
    );
  });
}

// In-flight conversion promises so concurrent /epub/<id> requests share work.
const epubBuildPromises = new Map();

async function getOrBuildReaderEpub(book) {
  // Prefer the original if it's already EPUB.
  const origRel = book.originalFile || `${book.id}.epub`;
  const origPath = path.join(booksDir, origRel);
  if (origPath.toLowerCase().endsWith('.epub') && fs.existsSync(origPath)) {
    return origPath;
  }
  // Cached conversion.
  const cached = path.join(booksDir, `${book.id}.reader.epub`);
  if (fs.existsSync(cached)) return cached;

  // De-dupe concurrent builds.
  if (epubBuildPromises.has(book.id)) return epubBuildPromises.get(book.id);

  // Pick a source to convert from: prefer the original (best fidelity);
  // fall back to the served kindle file.
  let src = fs.existsSync(origPath) ? origPath : null;
  if (!src && book.file) {
    const f = path.join(booksDir, book.file);
    if (fs.existsSync(f)) src = f;
  }
  if (!src) throw new Error('No source file to convert');

  const tmp = path.join(booksDir, `${book.id}.reader.tmp.epub`);
  const p = (async () => {
    try {
      await convertToEpub(src, tmp);
      fs.renameSync(tmp, cached);
      return cached;
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
      epubBuildPromises.delete(book.id);
    }
  })();
  epubBuildPromises.set(book.id, p);
  return p;
}

const { assertExternalUrl, isSafeExternalScheme, isSafeBasename } = require('./safety.js');
const { buildManifest, validateBackup } = require('./backup.js');
const {
  tokensMatch,
  loadOrCreateServerToken,
  rotateServerToken,
  FailedAuthLimiter,
} = require('./lib/auth.js');
const { PairCodeStore, PAIR_TTL_MS } = require('./pair.js');
const { authoriseRequest } = require('./route-auth.js');
const { handlePairRequest } = require('./route-pair.js');
const { validateUploadRequest, MAX_UPLOAD_BYTES } = require('./route-upload.js');
const { humanSize, escapeHtml, getLocalIP } = require('./lib/utils.js');
const { handleCoverRequest } = require('./route-cover.js');
const { handleEpubRequest } = require('./route-epub.js');
const { renderShelfHtml } = require('./route-index.js');
const { prepareDownloadResponse } = require('./route-download.js');

// Scan the Cookie header for any host-only `airshelf_token` value matching the
// current server token. Browsers can send duplicate cookie names (for example
// differing Path scopes), so callers shouldn't trust first/last ordering.
function hasMatchingCookieToken(header, expectedToken) {
  if (!header || typeof header !== 'string') return false;
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    if (name !== 'airshelf_token') continue;
    if (tokensMatch(piece.slice(eq + 1).trim(), expectedToken)) return true;
  }
  return false;
}
const authLimiter = new FailedAuthLimiter();

let mainWindow = null;
let server = null;
let booksDir = null;
let metaFile = null;
let serverToken = null;
let userDataPath = null;
const pairStore = new PairCodeStore();
let bonjour = null;
// Stable hostname registered over mDNS. Resolves to `airshelf.local` on the
// LAN, so the Kindle browser doesn't need the Mac's ever-changing DHCP IP.
const MDNS_HOST = 'airshelf';

// ---------- Settings (small key/value store, separate from books.json) ----------
//
// Implementation moved to ./settings.js. Start with an in-memory store so
// any caller that runs before app.whenReady (defensive — none today) gets
// real load/save semantics rather than a no-op shim. Once userData is
// known, swap to a file-backed store and migrate any pre-init writes
// across so nothing is lost.

const { createSettingsStore } = require('./settings.js');
let settingsStore = createSettingsStore(null);

function loadSettings() {
  return settingsStore.load();
}

function saveSettings(patch) {
  return settingsStore.save(patch);
}

function initSettingsStore(filePath) {
  const fileStore = createSettingsStore(filePath);
  // Carry over any pre-init writes. The file-backed store's load() picks
  // up whatever is already on disk; merging the in-memory snapshot on top
  // means in-memory writes win (they're more recent).
  const pending = settingsStore.load();
  if (Object.keys(pending).length > 0) fileStore.save(pending);
  settingsStore = fileStore;
}

// ---------- Book storage ----------

// In-memory cache of the books.json contents. Populated on first loadMeta()
// call and kept in sync with disk via saveMeta(). Subsequent loadMeta()s are
// O(1) — no disk read, no JSON.parse. This eliminates the per-HTTP-request
// + per-IPC-call disk hit that was the dominant runtime cost (HTTP /cover,
// /download, /epub all funnel through listBooks() → loadMeta()).
let metaCache = null;

function loadMeta() {
  if (metaCache) return metaCache;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    raw = { books: [] };
  }
  if (!raw || !Array.isArray(raw.books)) raw = { books: [] };
  // Defense in depth: every metadata field that gets joined with booksDir
  // and served over HTTP must be a single path component. A tampered
  // books.json with `book.file = "../../etc/passwd"` would otherwise leak
  // arbitrary disk contents through /download or /epub.
  const books = raw.books.filter((b) => {
    if (!b || !isSafeBasename(b.file)) {
      console.warn('books.json: dropping entry with unsafe `file`:', b && b.file);
      return false;
    }
    if (b.originalFile != null && !isSafeBasename(b.originalFile)) {
      console.warn('books.json: dropping entry with unsafe `originalFile`:', b.originalFile);
      return false;
    }
    if (b.cover != null && !isSafeBasename(b.cover)) {
      console.warn('books.json: dropping entry with unsafe `cover`:', b.cover);
      return false;
    }
    return true;
  });
  metaCache = { ...raw, books };
  return metaCache;
}

function saveMeta(meta) {
  // Mutate the cache in place if a different object was passed (e.g. test
  // code calling saveMeta({ books: [...] }) directly). Normal callers pass
  // the same object loadMeta returned, so this is a no-op for them.
  if (meta !== metaCache) metaCache = meta;
  // Atomic write: tmp + rename. A crash mid-write leaves either the old
  // file intact or the new file complete — never a half-written books.json.
  const tmp = `${metaFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaFile);
}

function extractEpubCover(epubPath, outPath) {
  try {
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries();

    // Look in container.xml for OPF path
    const containerEntry = entries.find((e) => e.entryName === 'META-INF/container.xml');
    if (!containerEntry) return false;
    const containerXml = containerEntry.getData().toString('utf8');
    const opfMatch = containerXml.match(/full-path="([^"]+)"/);
    if (!opfMatch) return false;
    const opfPath = opfMatch[1];
    const opfEntry = entries.find((e) => e.entryName === opfPath);
    if (!opfEntry) return false;
    const opfXml = opfEntry.getData().toString('utf8');
    const opfDir = path.posix.dirname(opfPath);

    // Try <meta name="cover" content="ID"> then find <item id="ID" href="...">
    let coverHref = null;
    const metaCoverMatch = opfXml.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/);
    if (metaCoverMatch) {
      const coverId = metaCoverMatch[1];
      const itemRe = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`);
      const m = opfXml.match(itemRe);
      if (m) coverHref = m[1];
    }
    // Fallback: item with properties="cover-image"
    if (!coverHref) {
      const m =
        opfXml.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/) ||
        opfXml.match(/<item[^>]+href="([^"]+)"[^>]+properties="cover-image"/);
      if (m) coverHref = m[1];
    }
    // Last fallback: any image with "cover" in href
    if (!coverHref) {
      const m = opfXml.match(
        /<item[^>]+href="([^"]*cover[^"]*\.(?:jpe?g|png))"[^>]*media-type="image\//i,
      );
      if (m) coverHref = m[1];
    }
    if (!coverHref) return false;

    const fullCoverPath = opfDir && opfDir !== '.' ? path.posix.join(opfDir, coverHref) : coverHref;
    const coverEntry = entries.find((e) => e.entryName === fullCoverPath);
    if (!coverEntry) return false;

    fs.writeFileSync(outPath, coverEntry.getData());
    return true;
  } catch {
    return false;
  }
}

function extractEpubMeta(epubPath) {
  try {
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries();
    const containerEntry = entries.find((e) => e.entryName === 'META-INF/container.xml');
    if (!containerEntry) return {};
    const opfMatch = containerEntry
      .getData()
      .toString('utf8')
      .match(/full-path="([^"]+)"/);
    if (!opfMatch) return {};
    const opfEntry = entries.find((e) => e.entryName === opfMatch[1]);
    if (!opfEntry) return {};
    const opfXml = opfEntry.getData().toString('utf8');
    const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
    const authorMatch = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/);
    const dateMatch = opfXml.match(/<dc:date[^>]*>([^<]+)<\/dc:date>/);
    let year = null;
    if (dateMatch) {
      const y = dateMatch[1].match(/\d{4}/);
      if (y) year = parseInt(y[0], 10);
    }
    return {
      title: titleMatch ? titleMatch[1].trim() : null,
      author: authorMatch ? authorMatch[1].trim() : null,
      year,
    };
  } catch {
    return {};
  }
}

// titlesMatch / cleanTitle / guessAuthorFromFilename moved to ./titles.js
// — single canonical impl, requires above.

// Open Library client moved to ./openlibrary.js — same network behaviour,
// now unit-tested with stubbed `fetch`. The functions remain in this scope
// under the same names so addBook / migrateExistingBooks call sites don't
// have to change. fetchCoverFromOpenLibrary is exported by openlibrary.js
// but main.js doesn't currently call it (the search + download halves are
// invoked separately so the doc is reused for description fetching too).
const {
  searchOpenLibrary,
  downloadOpenLibraryCover,
  fetchOpenLibraryDescription,
} = require('./openlibrary.js');

// `displayName` lets the /upload route preserve the user's filename for
// title/author fallback even though the actual srcPath is a randomised
// staging file. Defaults to the srcPath's basename so existing callers
// (drag-drop, IPC, calibre-import) keep their current behaviour.
async function addBook(srcPath, displayName = path.basename(srcPath)) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    return { error: `Unsupported format: ${ext}` };
  }

  // Hash the source file to detect duplicates. Stream-hash so big PDFs/
  // AZW3s don't load fully into memory + block the event loop.
  let srcHash = null;
  try {
    srcHash = await hashFileSha1(srcPath);
  } catch (e) {
    return { error: `Could not read file: ${e.message}` };
  }
  const existing = await metaQueue(async () => loadMeta().books.find((b) => b.hash === srcHash));
  if (existing) {
    return { duplicate: existing };
  }

  const id = crypto.randomBytes(8).toString('hex');
  const originalFileName = `${id}${ext}`;
  const originalPath = path.join(booksDir, originalFileName);
  fs.copyFileSync(srcPath, originalPath);

  // Extract metadata from EPUB before any conversion
  let title = null;
  let author = null;
  let year = null;
  let coverFile = null;
  const coverCandidate = path.join(booksDir, `${id}.cover`);
  if (ext === '.epub') {
    const m = extractEpubMeta(originalPath);
    title = m.title;
    author = m.author;
    year = m.year;
    if (extractEpubCover(originalPath, coverCandidate)) {
      coverFile = `${id}.cover`;
      await resizeCoverInPlace(coverCandidate);
    }
  }
  // Fallback for non-EPUB formats (AZW3, MOBI, PDF…): ask Calibre for the
  // embedded cover before resorting to Open Library.
  if (!coverFile && (await extractCoverViaCalibre(originalPath, coverCandidate))) {
    coverFile = `${id}.cover`;
    await resizeCoverInPlace(coverCandidate);
  }
  // Fall back to the filename and clean it up. We strip from displayName
  // (not srcPath) so the /upload route's randomised staging filename
  // doesn't leak into the title. Use path.extname(displayName) for the
  // strip so a mixed-case extension (e.g. "BOOK.EPUB") is removed even
  // though the lowercased `ext` we computed earlier doesn't match —
  // path.basename's second argument is case-sensitive.
  const rawBase = path.basename(displayName, path.extname(displayName));
  if (!title) title = rawBase;
  // Extract series before cleanTitle strips the parenthetical — extractSeries
  // returns the cleaned title plus any `(Series #N)` info found in the raw form.
  const seriesInfo = extractSeries(title);
  title = seriesInfo.title;
  let series = seriesInfo.series;
  let seriesIndex = seriesInfo.seriesIndex;
  // Also try the filename if the title-derived path had no parenthetical —
  // file metadata sometimes stores a clean title while the filename keeps the
  // series marker.
  if (!series) {
    const fromFile = extractSeries(rawBase);
    if (fromFile.series) {
      series = fromFile.series;
      seriesIndex = fromFile.seriesIndex;
    }
  }
  if (!author) author = guessAuthorFromFilename(rawBase);
  if (author) author = author.replace(/\s+/g, ' ').trim();

  // Always query Open Library — use the canonical title/author/year when we get
  // a confident match, and rescue missing covers + descriptions.
  let description = null;
  try {
    const doc = await searchOpenLibrary(title, author);
    if (doc) {
      const olTitle = doc.title;
      if (olTitle && titlesMatch(olTitle, title)) {
        if (olTitle.length <= title.length + 4) {
          title = olTitle;
        }
        if (doc.author_name && doc.author_name[0]) author = doc.author_name[0];
        if (doc.first_publish_year) year = doc.first_publish_year;
      } else {
        if (!author && doc.author_name && doc.author_name[0]) author = doc.author_name[0];
        if (!year && doc.first_publish_year) year = doc.first_publish_year;
      }
      if (!coverFile) {
        const ok = await downloadOpenLibraryCover(doc, coverCandidate);
        if (ok) {
          coverFile = `${id}.cover`;
          await resizeCoverInPlace(coverCandidate);
        }
      }
      // Grab description from first_sentence or fetch from works API
      if (doc.first_sentence && doc.first_sentence[0]) {
        description = doc.first_sentence[0];
      } else {
        description = await fetchOpenLibraryDescription(doc);
      }
    }
  } catch (e) {
    console.warn(`Metadata enrichment failed for "${title}":`, e.message);
  }

  // Ensure we have a Kindle-compatible file to serve.
  // We convert non-Kindle formats to .mobi. We also re-convert native Kindle
  // formats when we have a rescued cover to inject (so the Kindle library
  // shows the right thumbnail).
  let kindleFile;
  let kindleExt;
  let converted = false;
  const coverFullPath = coverFile ? path.join(booksDir, coverFile) : null;

  // Convert everything to AZW3 (Amazon's KF8). The .azw3 extension and
  // format make Kindle's library indexer treat the file as a native Amazon
  // ebook, which is the only reliable way to get library thumbnails for
  // sideloaded books on PW3-era hardware.
  if (ext !== '.azw3') {
    const azwName = `${id}.azw3`;
    const azwPath = path.join(booksDir, azwName);
    try {
      await convertToAzw3(originalPath, azwPath, coverFullPath);
    } catch (e) {
      try {
        fs.unlinkSync(originalPath);
      } catch {}
      if (coverFile) {
        try {
          fs.unlinkSync(path.join(booksDir, coverFile));
        } catch {}
      }
      return { error: `Conversion failed: ${e.message}` };
    }
    kindleFile = azwName;
    kindleExt = 'azw3';
    converted = true;
  } else {
    kindleFile = originalFileName;
    kindleExt = 'azw3';
  }

  // Patch the cover into the served file via ebook-meta — this is the
  // reliable way to make sure the Kindle library shows the thumbnail.
  let coverEmbedded = false;
  const servedPath = path.join(booksDir, kindleFile);
  if (coverFullPath) {
    coverEmbedded = await setCoverMetadata(servedPath, coverFullPath);
  }

  // Normalise EXTH so Kindle treats the file as a Personal Document and
  // generates a cover thumbnail from the embedded EXTH 201 image.
  let exthNormalized = false;
  try {
    exthNormalized = normalizeKindleMetadata(servedPath);
  } catch (e) {
    console.warn(`EXTH normalize failed for "${title}":`, e.message);
  }

  const kindleSize = fs.statSync(path.join(booksDir, kindleFile)).size;

  const book = {
    id,
    title,
    author,
    year,
    series,
    seriesIndex,
    originalName: displayName,
    originalFile: originalFileName,
    file: kindleFile, // what we serve to the Kindle
    cover: coverFile,
    size: kindleSize,
    ext: kindleExt,
    sourceExt: ext.slice(1),
    converted,
    description,
    hash: srcHash,
    coverEmbedded,
    exthNormalized,
    addedAt: Date.now(),
  };
  // Atomic load → re-check race → push → save. If we lose a race against
  // another addBook for the same file, this book's disk artifacts get
  // orphaned (small leak, user-visible only as stranded files in books/).
  // Full fix lives in #3 once the in-memory cache lands.
  return await metaQueue(async () => {
    const meta = loadMeta();
    const winner = meta.books.find((b) => b.hash === srcHash);
    if (winner) return { duplicate: winner };
    meta.books.push(book);
    saveMeta(meta);
    return { book };
  });
}

function deleteBook(id) {
  const meta = loadMeta();
  const idx = meta.books.findIndex((b) => b.id === id);
  if (idx === -1) return false;
  const book = meta.books[idx];
  for (const f of [book.file, book.originalFile, book.cover]) {
    if (!f) continue;
    try {
      fs.unlinkSync(path.join(booksDir, f));
    } catch {}
  }
  meta.books.splice(idx, 1);
  saveMeta(meta);
  return true;
}

function listBooks() {
  return loadMeta().books.sort((a, b) => b.addedAt - a.addedAt);
}

// Convert any existing books that aren't Kindle-native to .mobi
async function migrateExistingBooks() {
  const meta = loadMeta();
  let changed = false;

  // Backfill hashes for books that predate dedup tracking
  for (const book of meta.books) {
    if (book.hash) continue;
    const srcFile = book.originalFile || book.file;
    if (!srcFile) continue;
    const srcPath = path.join(booksDir, srcFile);
    if (!fs.existsSync(srcPath)) continue;
    try {
      book.hash = await hashFileSha1(srcPath);
      changed = true;
    } catch {}
  }
  if (changed) saveMeta(meta);

  // Backfill series + seriesIndex from the original filename for books
  // added before #42. The fields default to null; only books where they
  // are still undefined (predate the schema) get touched, so a manual
  // null doesn't get re-derived. originalName preserves the raw filename
  // including the (Series #N) parenthetical, so we extract from there.
  let seriesChanged = false;
  for (const book of meta.books) {
    if (book.series !== undefined) continue;
    book.series = null;
    book.seriesIndex = null;
    const source = book.originalName || book.title;
    if (source) {
      const info = extractSeries(source);
      if (info.series) {
        book.series = info.series;
        book.seriesIndex = info.seriesIndex;
      }
    }
    seriesChanged = true;
  }
  if (seriesChanged) saveMeta(meta);

  for (const book of meta.books) {
    const ext = `.${book.ext}`;
    if (KINDLE_NATIVE_EXTS.includes(ext)) continue;
    const srcPath = path.join(booksDir, book.file);
    if (!fs.existsSync(srcPath)) continue;
    const mobiName = `${book.id}.mobi`;
    const mobiPath = path.join(booksDir, mobiName);
    if (fs.existsSync(mobiPath)) continue; // already migrated
    try {
      console.log(`Migrating ${book.title} (${book.ext} → mobi)…`);
      await convertToMobi(srcPath, mobiPath);
      book.originalFile = book.file;
      book.file = mobiName;
      book.sourceExt = book.ext;
      book.ext = 'mobi';
      book.converted = true;
      book.size = fs.statSync(mobiPath).size;
      changed = true;
      saveMeta(meta);
      if (mainWindow) mainWindow.webContents.send('books:changed');
    } catch (e) {
      console.error(`Failed to migrate ${book.title}:`, e.message);
    }
  }
  if (changed && mainWindow) mainWindow.webContents.send('books:changed');

  // Enrichment pass: backfill cover / author / year for existing books
  const meta2 = loadMeta();
  let enrichChanged = false;
  for (const book of meta2.books) {
    // Clean messy titles derived from filenames
    const cleaned = cleanTitle(book.title);
    if (cleaned && cleaned !== book.title) {
      if (!book.author) {
        const guessed = guessAuthorFromFilename(book.title);
        if (guessed) book.author = guessed;
      }
      book.title = cleaned;
      enrichChanged = true;
      saveMeta(meta2);
    }

    // Try to rescue a missing cover from the original file itself before
    // falling back to Open Library. Handles AZW3/MOBI/PDF via Calibre and
    // EPUB via the direct zip extractor.
    if (!book.cover && book.originalFile) {
      const origPath = path.join(booksDir, book.originalFile);
      if (fs.existsSync(origPath)) {
        const coverCandidate = path.join(booksDir, `${book.id}.cover`);
        const origExt = path.extname(book.originalFile).toLowerCase();
        let ok = false;
        if (origExt === '.epub') ok = extractEpubCover(origPath, coverCandidate);
        if (!ok) ok = await extractCoverViaCalibre(origPath, coverCandidate);
        if (ok) {
          await resizeCoverInPlace(coverCandidate);
          book.cover = `${book.id}.cover`;
          enrichChanged = true;
          saveMeta(meta2);
          if (mainWindow) mainWindow.webContents.send('books:changed');
        }
      }
    }

    if (book.cover && book.author && book.year && book.description) continue;
    try {
      console.log(`Enriching "${book.title}"…`);
      const doc = await searchOpenLibrary(book.title, book.author);
      if (!doc) continue;
      let dirty = false;
      if (
        doc.title &&
        titlesMatch(doc.title, book.title) &&
        doc.title !== book.title &&
        doc.title.length <= book.title.length + 4
      ) {
        book.title = doc.title;
        dirty = true;
      }
      if (!book.author && doc.author_name && doc.author_name[0]) {
        book.author = doc.author_name[0];
        dirty = true;
      }
      if (!book.year && doc.first_publish_year) {
        book.year = doc.first_publish_year;
        dirty = true;
      }
      if (!book.cover) {
        const coverCandidate = path.join(booksDir, `${book.id}.cover`);
        const ok = await downloadOpenLibraryCover(doc, coverCandidate);
        if (ok) {
          await resizeCoverInPlace(coverCandidate);
          book.cover = `${book.id}.cover`;
          dirty = true;
        }
      }
      if (!book.description) {
        if (doc.first_sentence && doc.first_sentence[0]) {
          book.description = doc.first_sentence[0];
          dirty = true;
        } else {
          const desc = await fetchOpenLibraryDescription(doc);
          if (desc) {
            book.description = desc;
            dirty = true;
          }
        }
      }
      if (dirty) {
        enrichChanged = true;
        saveMeta(meta2);
        if (mainWindow) mainWindow.webContents.send('books:changed');
      }
    } catch (e) {
      console.warn(`Enrichment failed for "${book.title}":`, e.message);
    }
  }
  if (enrichChanged && mainWindow) mainWindow.webContents.send('books:changed');

  // Resize any existing oversized cover files in place
  for (const book of loadMeta().books) {
    if (!book.cover) continue;
    const coverPath = path.join(booksDir, book.cover);
    if (!fs.existsSync(coverPath)) continue;
    try {
      const sizeBefore = fs.statSync(coverPath).size;
      const resized = await resizeCoverInPlace(coverPath);
      if (resized) {
        const sizeAfter = fs.statSync(coverPath).size;
        console.log(
          `Resized cover "${book.title}": ${(sizeBefore / 1024).toFixed(0)}KB → ${(sizeAfter / 1024).toFixed(0)}KB`,
        );
      }
    } catch {}
  }
  if (mainWindow) mainWindow.webContents.send('books:changed');

  // EXTH normalisation backfill: rewrite every book's served file so its
  // metadata matches Kindle's Personal Document pipeline (501=PDOC, no
  // 504). Runs before the AZW3 rebuild so already-AZW3 books get patched.
  // The `exthNormalized` flag supersedes the legacy `asinInjected` flag —
  // any book that was processed under the old EBOK+ASIN scheme needs to be
  // rewritten, so we deliberately ignore the old flag here.
  {
    const m = loadMeta();
    for (const book of m.books) {
      if (book.exthNormalized) continue;
      if (!book.file) continue;
      const fp = path.join(booksDir, book.file);
      if (!fs.existsSync(fp)) continue;
      try {
        console.log(`Normalising EXTH for "${book.title}"…`);
        normalizeKindleMetadata(fp);
        book.exthNormalized = true;
        delete book.asinInjected;
        try {
          book.size = fs.statSync(fp).size;
        } catch {}
        saveMeta(m);
        if (mainWindow) mainWindow.webContents.send('books:changed');
      } catch (e) {
        console.warn(`EXTH backfill failed for "${book.title}":`, e.message);
      }
    }
  }

  // Rebuild backfill: re-convert any book whose served file isn't AZW3 yet.
  // The .azw3 extension is what makes Kindle's library indexer treat the
  // file as a real Amazon ebook and reliably generate cover thumbnails.
  const meta3 = loadMeta();
  for (const book of meta3.books) {
    if (book.azw3Built) continue;
    if (!book.file) continue;
    const coverPath = book.cover ? path.join(booksDir, book.cover) : null;
    const origRel = book.originalFile || book.file;
    const origPath = path.join(booksDir, origRel);
    if (!fs.existsSync(origPath)) continue;

    const azwName = `${book.id}.azw3`;
    const tmpOut = path.join(booksDir, `${book.id}_rebuild.azw3`);
    try {
      console.log(`Rebuilding "${book.title}" as AZW3…`);
      await convertToAzw3(
        origPath,
        tmpOut,
        coverPath && fs.existsSync(coverPath) ? coverPath : null,
      );
      if (!fs.existsSync(tmpOut)) {
        throw new Error(`Calibre did not produce ${tmpOut}`);
      }
      fs.renameSync(tmpOut, path.join(booksDir, azwName));
      // Clean up the old .mobi if it's no longer the served file
      const oldFile = book.file;
      if (oldFile && oldFile !== azwName) {
        try {
          fs.unlinkSync(path.join(booksDir, oldFile));
        } catch {}
      }
      book.file = azwName;
      book.ext = 'azw3';
      book.azw3Built = true;
      book.coverEmbedded = !!coverPath;
      // Normalise EXTH on the freshly-built AZW3 so the cover thumbnail
      // flows through Kindle's PDOC pipeline.
      try {
        normalizeKindleMetadata(path.join(booksDir, azwName));
        book.exthNormalized = true;
        delete book.asinInjected;
      } catch (e) {
        console.warn(`EXTH normalize failed for "${book.title}":`, e.message);
      }
      try {
        book.size = fs.statSync(path.join(booksDir, azwName)).size;
      } catch {}
      saveMeta(meta3);
      if (mainWindow) mainWindow.webContents.send('books:changed');
    } catch (e) {
      try {
        fs.unlinkSync(tmpOut);
      } catch {}
      console.warn(`AZW3 rebuild failed for "${book.title}":`, e.message);
    }
  }
}

// ---------- Networking ----------

// Loopback gate for write-side endpoints (#37 /upload). The server listens
// on 0.0.0.0 so the Kindle can read; we don't want to expose mutating
// routes on the LAN under just the ~20-bit token.
function isLoopback(addr) {
  if (typeof addr !== 'string') return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Renders a static mock of the Electron bookshelf UI — used only for the
// README screenshot. It is served from /screenshot in the same HTTP server.
function renderScreenshotHtml() {
  const books = listBooks().slice(0, 8);
  const rendered = books
    .map((b) => {
      return `
      <div class="book-card">
        <div class="book-cover">${b.cover ? `<img src="/${serverToken}/cover/${b.id}" alt="">` : escapeHtml(b.title.slice(0, 24))}</div>
        <div class="book-title">${escapeHtml(b.title)}</div>
        <div class="book-size">${b.ext.toUpperCase()} &middot; ${humanSize(b.size)}</div>
      </div>
    `;
    })
    .join('');

  const cssPath = path.join(__dirname, 'renderer', 'style.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Airshelf — screenshot</title>
<style>${css}</style>
<style>
  html, body { background: #f2f2f4; }
  .frame { display: flex; height: 720px; }
</style>
</head>
<body>
  <div class="app frame">
    <aside class="sidebar">
      <div class="titlebar-drag"></div>
      <div class="sidebar-section-label">Books</div>
      <button class="nav-item active">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <span>Bookshelf</span>
      </button>
      <button class="nav-item">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span>Transfer</span>
      </button>
      <div class="sidebar-section-label">General</div>
      <button class="nav-item">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </button>
    </aside>
    <main class="content">
      <section class="view">
        <header class="view-header">
          <div class="view-titles">
            <h1>Bookshelf</h1>
            <p class="subtitle">EPUB, MOBI, AZW3, PDF, DOCX, FB2, RTF, TXT &amp; more &mdash; auto-converted to Kindle-friendly MOBI</p>
          </div>
          <div class="header-actions">
            <button class="icon-btn"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
            <button class="icon-btn primary"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
          </div>
        </header>
        <div class="shelf">
          ${rendered}
        </div>
      </section>
    </main>
  </div>
</body>
</html>`;
}

function startServer() {
  if (server) return;

  function pipeStreamToResponse(stream, req, res) {
    req.on('close', () => stream.destroy());
    stream.on('error', (e) => {
      console.error('[server] stream failed', req.method, req.url, '\n', e);
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      res.writeHead(500);
      res.end(process.env.NODE_ENV === 'production' ? 'Error' : `Error: ${e.message}`);
    });
    stream.pipe(res);
  }

  server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    // Short-circuit blocked IPs BEFORE parsing the URL so a malformed
    // req.url can't tip a blocked client into the catch path's 500
    // response — that would break the stealth-404 behavior.
    if (authLimiter.isBlocked(ip)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // Pairing flow (#34): the path-shape match, single-use code consume,
      // and redirect/cookie payload all live in route-pair.js for unit
      // testability. We keep the rate-limit + writeHead glue here so the
      // pure module stays free of Node-server coupling (mirrors how
      // route-auth.js is structured).
      const pairResult = handlePairRequest({
        pathname: url.pathname,
        pairStore,
        serverToken,
      });
      if (pairResult) {
        if (pairResult.ok) {
          authLimiter.recordSuccess(ip);
          res.writeHead(302, {
            Location: pairResult.location,
            'Set-Cookie': pairResult.setCookie,
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        authLimiter.recordFail(ip);
        res.writeHead(pairResult.status);
        res.end('Not found');
        return;
      }

      // Bare-URL fallback (post-pair): if the request has no /<token>/
      // prefix but carries a valid cookie, redirect to the canonical
      // /<token>/ entry point. Lets the user bookmark http://<lan-ip>:PORT/
      // instead of the longer token URL.
      if (url.pathname === '/' || url.pathname === '') {
        if (hasMatchingCookieToken(req.headers.cookie, serverToken)) {
          authLimiter.recordSuccess(ip);
          res.writeHead(302, { Location: `/${serverToken}/`, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
      }

      // Token + per-IP rate-limit gate. See route-auth.js for the rules; a
      // bad/missing token returns a stealth 404 (not 401) so the server is
      // indistinguishable from no server at all to a port-scan.
      const auth = authoriseRequest({
        pathname: url.pathname,
        ip,
        expectedToken: serverToken,
        limiter: authLimiter,
        tokensMatch,
      });
      if (!auth.allow) {
        res.writeHead(auth.status);
        res.end('Not found');
        return;
      }
      const subPath = auth.subPath;
      // CLI / future-extension upload (#37). Same token as the rest of the
      // server, but only honoured for POST and only from loopback — the
      // server itself listens on 0.0.0.0 for the Kindle's read traffic, but
      // a write surface protected only by the ~20-bit token is too thin a
      // perimeter for LAN exposure. Body is the raw bytes of one ebook;
      // the original filename comes in via X-Filename so the saved file
      // can pick up the right extension and (via cleanTitle) a sensible
      // fallback title. Cap is generous (1 GB) — large PDFs are common,
      // but we won't accept multi-GB blobs by accident.
      // Rotate the server token (#37 `airshelf rotate-token`). Same
      // loopback-only gate as /upload — the running app's serverToken
      // updates atomically so existing /<old-token>/ requests start
      // returning 404 immediately. Connected Kindles need to re-pair;
      // the airshelf_token cookie set by the pair flow holds the *old*
      // token, so the bare-URL fallback fails until the device pairs
      // again with a fresh code.
      if (subPath === '/rotate-token' && req.method === 'POST') {
        if (!isLoopback(req.socket.remoteAddress)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        let next;
        try {
          next = rotateServerToken(userDataPath);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(process.env.NODE_ENV === 'production' ? 'Error' : `Rotate failed: ${e.message}`);
          return;
        }
        serverToken = next;
        // `ip` in the enclosing scope is the *remote* client IP for rate
        // limiting; rename here so future readers don't conflate the two.
        const localIp = getLocalIP();
        const newUrl = `http://${localIp}:${PORT}/${next}/`;
        if (mainWindow)
          mainWindow.webContents.send('server:tokenRotated', { token: next, url: newUrl });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true, token: next, url: newUrl }));
        return;
      }

      if (subPath === '/upload') {
        // All synchronous validation lives in route-upload.js so it can be
        // unit-tested without booting the server. The streaming/disk-write
        // half stays here because it's tightly coupled to req/res streams
        // and the addBook closure.
        const validation = validateUploadRequest({
          method: req.method,
          remoteAddress: req.socket.remoteAddress,
          headers: req.headers,
          supportedExtensions: SUPPORTED_EXTS,
          isSafeBasename,
          isLoopback,
        });
        if (!validation.ok) {
          res.writeHead(validation.status, { 'Content-Type': 'text/plain' });
          res.end(validation.message);
          return;
        }
        const { filename, ext } = validation;
        // Tmp filename keeps the *extension* so addBook's format probe and
        // cleanTitle work, but drops the user-supplied basename — which
        // could leak metadata into a world-readable temp dir, and (even
        // after isSafeBasename) be long enough to ENAMETOOLONG on some
        // filesystems. The unique random hex is the new stem; mode 0o600
        // restricts read access to this user.
        const tmpPath = path.join(
          os.tmpdir(),
          `airshelf-upload-${crypto.randomBytes(8).toString('hex')}${ext}`,
        );
        const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
        let received = 0;
        let aborted = false;
        req.on('data', (chunk) => {
          if (aborted) return;
          received += chunk.length;
          if (received > MAX_UPLOAD_BYTES) {
            aborted = true;
            out.destroy();
            try {
              req.destroy();
            } catch {}
            try {
              fs.unlinkSync(tmpPath);
            } catch {}
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Upload exceeded size limit mid-stream.');
          }
        });
        try {
          await new Promise((resolve, reject) => {
            req.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            req.on('error', reject);
            // 'aborted' fires when the client closes mid-upload before
            // 'end'. Without this the promise never settles and the
            // handler hangs forever, leaving a partial tmp file behind.
            req.on('aborted', () => reject(new Error('client aborted upload')));
          });
        } catch (e) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {}
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            // Match the leak-suppression posture used elsewhere in the
            // request handler (see the catch blocks at the bottom).
            res.end(
              process.env.NODE_ENV === 'production' ? 'Error' : `Upload write failed: ${e.message}`,
            );
          }
          return;
        }
        if (aborted) return; // 413 already sent
        let result;
        try {
          // Pass the validated X-Filename so the user's original name flows
          // into title-fallback / book.originalName, even though the on-disk
          // path is the randomised staging file.
          result = await addBook(tmpPath, filename);
        } catch (e) {
          result = { error: e.message };
        } finally {
          try {
            fs.unlinkSync(tmpPath);
          } catch {}
        }
        if (result.book && mainWindow) mainWindow.webContents.send('books:changed');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result));
        return;
      }
      if (subPath === '/screenshot') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(renderScreenshotHtml());
        return;
      }
      if (subPath === '/' || subPath === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(renderShelfHtml({ books: listBooks(), serverToken }));
        return;
      }
      const coverDecision = handleCoverRequest({
        subPath,
        books: listBooks(),
        booksDir,
        ifNoneMatch: req.headers['if-none-match'],
        ifModifiedSince: req.headers['if-modified-since'],
      });
      if (coverDecision) {
        if (coverDecision.body !== undefined) {
          res.writeHead(coverDecision.status, coverDecision.headers || {});
          res.end(coverDecision.body);
        } else {
          res.writeHead(coverDecision.status, coverDecision.headers || {});
          res.end();
        }
        return;
      }
      const dlDecision = prepareDownloadResponse({ subPath, books: listBooks(), booksDir });
      if (dlDecision) {
        if (dlDecision.status !== 200) {
          res.writeHead(dlDecision.status);
          res.end(dlDecision.body);
          return;
        }
        const stat = fs.statSync(dlDecision.filePath);
        res.writeHead(200, { ...dlDecision.headers, 'Content-Length': stat.size });
        // Kindle aborts mid-download more than you'd expect (sleep, network
        // flap). pipeStreamToResponse destroys the read stream on req close
        // so we don't keep pumping bytes to a dead socket.
        const dlStream = fs.createReadStream(dlDecision.filePath);
        pipeStreamToResponse(dlStream, req, res);
        return;
      }
      // keeps epubjs happy on big books. The decision logic lives in
      // route-epub.js so it can be tested without booting an HTTP server.
      const epubDecision = await handleEpubRequest({
        subPath,
        books: listBooks(),
        getReaderEpubPath: getOrBuildReaderEpub,
        rangeHeader: req.headers.range,
      });
      if (epubDecision) {
        res.writeHead(epubDecision.status, epubDecision.headers || {});
        if (epubDecision.stream) {
          const { path: streamPath, start, end } = epubDecision.stream;
          const opts = start !== undefined ? { start, end } : {};
          pipeStreamToResponse(fs.createReadStream(streamPath, opts), req, res);
        } else if (epubDecision.body !== undefined) {
          res.end(epubDecision.body);
        } else {
          res.end();
        }
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      // Server-level catch was returning a generic "Error" body with no log
      // — debugging download failures was blind. Log the stack to the main-
      // process console and surface the message to the client (only in
      // non-production; production builds shouldn't leak internals).
      console.error('[server] request failed', req.method, req.url, '\n', e);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(process.env.NODE_ENV === 'production' ? 'Error' : `Error: ${e.message}`);
    }
  });
  // Start mDNS only once `listen` actually succeeds — listen is async and
  // we don't want to advertise a hostname that isn't accepting connections
  // yet (or at all, if listen errors out). On error, undo any advertise
  // that may have happened on a retry path.
  server.listen(PORT, '0.0.0.0', () => startMdns());
  server.on('error', (e) => {
    console.error('[server] listen error', e);
    stopMdns();
  });
}

// Advertise the HTTP server over mDNS as `airshelf._http._tcp.local.` and
// register an A record for `airshelf.local` pointing at this machine. Lets
// the Kindle's browser hit `http://airshelf.local:6790/<token>/` instead of
// a typed-in DHCP IP that drifts across reconnects. Failures are logged
// and swallowed — the IP-based URL still works as a fallback.
function startMdns() {
  if (bonjour) return;
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: 'Airshelf',
      type: 'http',
      port: PORT,
      host: MDNS_HOST,
    });
  } catch (e) {
    console.warn('[mdns] publish failed:', e.message);
    bonjour = null;
  }
}

function stopMdns() {
  if (!bonjour) return;
  // Capture the instance *before* nulling the global so the unpublishAll
  // callback can still call destroy() — without this, the closure reads
  // the (now null) global and the mDNS sockets are never torn down,
  // which means goodbye packets aren't sent.
  const b = bonjour;
  bonjour = null;
  try {
    b.unpublishAll(() => b.destroy());
  } catch {}
}

// ---------- Electron ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ececec',
    icon: path.join(__dirname, 'build', 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, 'build', 'icon.icns'));
    } catch {}
  }
  const userData = app.getPath('userData');
  userDataPath = userData;
  booksDir = path.join(userData, 'books');
  fs.mkdirSync(booksDir, { recursive: true });
  metaFile = path.join(userData, 'books.json');
  initSettingsStore(path.join(userData, 'settings.json'));
  serverToken = loadOrCreateServerToken(userData);

  // startServer() also wires startMdns() into the `listening` callback so
  // we don't advertise a hostname before the HTTP server is accepting
  // connections.
  startServer();
  createWindow();
  migrateExistingBooks().catch((e) => console.error('migration error', e));
  scheduleAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Auto-update via electron-updater + GitHub Releases. The packaged app
// checks once on launch and every 24h after, downloads in the background,
// and prompts the user to relaunch when a build is ready. No-op when run
// via `npm start` because electron-updater throws on dev because there's
// no signed code to compare against.
function scheduleAutoUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('[updater] electron-updater missing, skipping:', e.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Push update events to the renderer so it can render a non-blocking
  // toast (the issue's "non-blocking Update available toast in-app").
  // If no window is up yet, the event is dropped — the next periodic
  // check will resurface the same update.
  function notifyRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send(channel, payload);
      } catch {}
    }
  }

  autoUpdater.on('error', (e) => console.warn('[updater] error:', e?.message || e));
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info?.version);
    notifyRenderer('updater:available', { version: info?.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded:', info?.version);
    notifyRenderer('updater:downloaded', { version: info?.version });
  });

  // Renderer-initiated relaunch — fired by the toast's "Restart" button.
  // quitAndInstall false-false skips the prompt + reopens the app.
  ipcMain.handle('updater:install', () => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.warn('[updater] quitAndInstall failed:', e?.message || e);
    }
  });

  autoUpdater.checkForUpdatesAndNotify().catch((e) => {
    console.warn('[updater] initial check failed:', e?.message || e);
  });
  // Re-check daily for long-lived sessions.
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch((e) => {
        console.warn('[updater] periodic check failed:', e?.message || e);
      });
    },
    24 * 60 * 60 * 1000,
  );
}

app.on('window-all-closed', () => {
  stopMdns();
  if (server) {
    server.close();
    server = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

// Send mDNS goodbye packets before exit so the LAN sees the service drop
// immediately instead of waiting for the TTL to expire.
app.on('before-quit', stopMdns);

// ---------- IPC ----------

ipcMain.handle('books:list', () => {
  return listBooks().map((b) => {
    let coverUrl = null;
    if (b.cover) {
      const p = path.join(booksDir, b.cover);
      // Append mtime as a cache-buster so replaced covers actually re-render;
      // the filename itself is stable (`<id>.cover`) across re-fetches.
      let v = '';
      try {
        v = `?v=${fs.statSync(p).mtimeMs | 0}`;
      } catch {}
      coverUrl = `file://${p}${v}`;
    }
    return { ...b, coverUrl, sizeHuman: humanSize(b.size) };
  });
});

ipcMain.handle('books:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Books',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Ebooks', extensions: SUPPORTED_EXTS.map((e) => e.slice(1)) }],
  });
  if (result.canceled) return { added: [], errors: [], duplicates: [] };
  const out = await addManyBooks(result.filePaths);
  // Notify renderer so the shelf re-fetches without the renderer having to
  // remember to refresh after every add. The drag-drop and context-menu
  // paths already do this; the dialog path was the odd one out.
  if (out.added.length && mainWindow) mainWindow.webContents.send('books:changed');
  return out;
});

ipcMain.handle('books:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Books',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Ebooks', extensions: SUPPORTED_EXTS.map((e) => e.slice(1)) }],
  });
  if (result.canceled) return { paths: [] };
  return { paths: result.filePaths };
});

ipcMain.handle('books:addPaths', async (_e, paths) => {
  return await addManyBooks(paths);
});

// Bulk-import every supported ebook from a Calibre library. The user
// picks the library root (a folder containing `metadata.db`), we enumerate
// books via Calibre's own sqlite, then run them through the regular
// addBook pipeline so dedup / cover extraction / EXTH normalize all
// behave identically to a manual drag-drop. Per-book progress events
// stream to the renderer over the `library:importProgress` channel so
// the UI can render an X/N counter without blocking on the whole batch.
ipcMain.handle('library:importCalibre', async () => {
  const defaultPath = path.join(os.homedir(), 'Calibre Library');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Calibre Library folder',
    defaultPath: fs.existsSync(defaultPath) ? defaultPath : os.homedir(),
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const libraryRoot = result.filePaths[0];

  let books;
  try {
    books = readCalibreLibrary(libraryRoot);
  } catch (e) {
    return { error: `Couldn't read Calibre library at ${libraryRoot}: ${e.message}` };
  }
  if (books.length === 0) {
    return { error: 'No AZW3, MOBI or EPUB files found in this Calibre library.' };
  }

  const out = await addManyBooks(
    books.map((b) => b.filePath),
    ({ done, total }) => {
      if (mainWindow) {
        mainWindow.webContents.send('library:importProgress', { done, total });
      }
    },
  );

  if (out.added.length && mainWindow) mainWindow.webContents.send('books:changed');
  return { ...out, total: books.length };
});

async function addManyBooks(paths, onProgress) {
  const added = [];
  const errors = [];
  const duplicates = [];
  let done = 0;
  // Bounded parallelism. Each addBook spawns 1–3 Calibre processes
  // (convert, ebook-meta, sips); 2 in flight = up to ~6 child processes
  // peak, enough to feel snappy on a 10-book drop without thrashing.
  // Sequential await was sum-of-wall-times; this is roughly max-of-wall-
  // times divided by the limit.
  await mapWithConcurrency(paths, 2, async (p) => {
    try {
      const result = await addBook(p);
      if (result.book) added.push(result.book);
      else if (result.duplicate)
        duplicates.push({ path: path.basename(p), title: result.duplicate.title });
      else if (result.error) errors.push({ path: path.basename(p), error: result.error });
    } catch (e) {
      errors.push({ path: path.basename(p), error: e.message });
    }
    done += 1;
    if (onProgress) {
      try {
        onProgress({ done, total: paths.length });
      } catch {}
    }
  });
  return { added, errors, duplicates };
}

ipcMain.handle('books:delete', (_e, id) => deleteBook(id));

ipcMain.handle('server:info', () => {
  const ip = getLocalIP();
  const mdnsHost = bonjour ? `${MDNS_HOST}.local` : null;
  return {
    ip,
    port: PORT,
    token: serverToken,
    url: `http://${ip}:${PORT}/${serverToken}/`,
    mdnsHost,
    mdnsUrl: mdnsHost ? `http://${mdnsHost}:${PORT}/${serverToken}/` : null,
    running: !!server,
  };
});

// Pairing code (#34): peek issues a fresh code only when there isn't a
// live one — otherwise the same code is returned with its remaining TTL,
// so the renderer can poll without rotating the user out from under
// themselves. rotate forces a new code (e.g. user typed it wrong on the
// Kindle and wants to start over).
function pairInfoPayload() {
  let entry = pairStore.peek();
  if (!entry) {
    const code = pairStore.issue();
    entry = pairStore.peek();
    if (!entry) entry = { code, expiresAt: Date.now() + PAIR_TTL_MS };
  }
  const ip = getLocalIP();
  return {
    code: entry.code,
    expiresAt: entry.expiresAt,
    ttlMs: PAIR_TTL_MS,
    pairUrl: `http://${ip}:${PORT}/pair/${entry.code}`,
  };
}

ipcMain.handle('pair:current', () => pairInfoPayload());

ipcMain.handle('pair:rotate', () => {
  pairStore.issue();
  return pairInfoPayload();
});

// ---------- Calibre detection ----------
//
// `source` distinguishes a directory the user explicitly chose ("user") from
// one we found by probing well-known locations ("auto"), so the settings UI
// can offer to forget the saved path without also wiping an auto-detection.

function calibreStatusPayload() {
  // userPathSaved reflects whether settings has *any* calibreBinDir entry,
  // even if the directory no longer exists or is missing binaries. The UI
  // uses this to surface "Forget saved path" when a user-saved value has
  // become stale and auto-detection took over (source === 'auto'); without
  // this signal there's no way to clear the dead entry from settings.json.
  const rawSaved = loadSettings().calibreBinDir;
  const userPathSaved = typeof rawSaved === 'string' && rawSaved.length > 0;
  const userDir = getCalibreUserBinDir();
  const binDir = findCalibreBinDir();
  if (!binDir) return { found: false, binDir: null, source: null, userPathSaved };
  return {
    found: true,
    binDir,
    source: userDir && binDir === userDir ? 'user' : 'auto',
    userPathSaved,
  };
}

ipcMain.handle('calibre:status', () => calibreStatusPayload());

ipcMain.handle('calibre:locate', async () => {
  // No `filters` array — macOS NSOpenPanel without filters lets the user
  // pick a no-extension binary like ebook-convert. A filter of ['*'] hides
  // extensionless files on some macOS versions.
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate Calibre’s ebook-convert',
    message: 'Select the ebook-convert binary inside your Calibre install.',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const picked = result.filePaths[0];
  if (path.basename(picked) !== 'ebook-convert') {
    return { error: 'Pick the ebook-convert binary itself, not a wrapper or alias.' };
  }
  if (!isExistingFile(picked)) {
    return { error: 'That path is not a regular file.' };
  }
  const binDir = path.dirname(picked);
  // ebook-meta lives next to ebook-convert in every Calibre install we know
  // of; refuse to save a directory that's missing it rather than discover
  // half-broken Calibre at cover-extraction time.
  if (!isExistingFile(path.join(binDir, 'ebook-meta'))) {
    return { error: 'That folder is missing ebook-meta — not a complete Calibre install.' };
  }
  saveSettings({ calibreBinDir: binDir });
  return { ok: true, ...calibreStatusPayload() };
});

ipcMain.handle('calibre:clear', () => {
  saveSettings({ calibreBinDir: null });
  return calibreStatusPayload();
});

ipcMain.handle('open:external', async (_e, url) => {
  if (!isSafeExternalScheme(url)) {
    console.warn('open:external: refusing non-http(s) URL:', url);
    return { ok: false, error: 'Only http(s) URLs are allowed.' };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Write a new cover for an existing book from an in-memory buffer. Shared
// by the "set cover from URL" and "choose cover image" flows. Resizes,
// re-injects the cover into the served file so the Kindle thumbnail refreshes,
// and saves metadata.
async function setBookCoverFromBuffer(bookId, buf) {
  if (!buf || buf.length < 1000) return { error: 'Image too small — likely a placeholder.' };
  const meta = loadMeta();
  const target = meta.books.find((b) => b.id === bookId);
  if (!target) return { error: 'Book not found.' };
  const coverPath = path.join(booksDir, `${bookId}.cover`);
  try {
    fs.writeFileSync(coverPath, buf);
  } catch (e) {
    return { error: `Could not write cover: ${e.message}` };
  }
  await resizeCoverInPlace(coverPath);
  target.cover = `${bookId}.cover`;
  // Re-inject into the served Kindle file so the device thumbnail updates
  const servedPath = target.file ? path.join(booksDir, target.file) : null;
  if (servedPath && fs.existsSync(servedPath)) {
    target.coverEmbedded = await setCoverMetadata(servedPath, coverPath);
  }
  saveMeta(meta);
  if (mainWindow) mainWindow.webContents.send('books:changed');
  return { ok: true };
}

ipcMain.handle('cover:setFromUrl', async (_e, bookId, url) => {
  if (!url || typeof url !== 'string') return { error: 'No URL provided.' };
  // Validates scheme + DNS-resolves to block SSRF against LAN/loopback/
  // metadata services (e.g. http://router.local, http://169.254.169.254).
  try {
    await assertExternalUrl(url);
  } catch (e) {
    return { error: e.message };
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Airshelf/0.1' } });
    if (!res.ok) return { error: `Server returned ${res.status}.` };
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return { error: `Not an image (got ${ct || 'unknown'}).` };
    const buf = Buffer.from(await res.arrayBuffer());
    return await setBookCoverFromBuffer(bookId, buf);
  } catch (e) {
    return { error: `Download failed: ${e.message}` };
  }
});

ipcMain.handle('cover:setFromFile', async (_e, bookId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose cover image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    const buf = fs.readFileSync(result.filePaths[0]);
    return await setBookCoverFromBuffer(bookId, buf);
  } catch (e) {
    return { error: `Could not read file: ${e.message}` };
  }
});

// ---------- Backup / restore ----------

ipcMain.handle('library:backup', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Back up library',
    defaultPath: `airshelf-backup-${today}.zip`,
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const meta = loadMeta();
    const zip = new AdmZip();
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify(buildManifest({ bookCount: meta.books.length }), null, 2)),
    );
    // Write the sanitized meta (filtered by loadMeta) rather than raw
    // metaFile bytes. If books.json contains entries that loadMeta would
    // drop (unsafe basename, etc.), the backup would otherwise capture
    // the bad entries and fail validateBackup on restore — and
    // manifest.bookCount would mismatch the archived books.json.
    zip.addFile('books.json', Buffer.from(JSON.stringify(meta, null, 2)));
    if (fs.existsSync(booksDir)) zip.addLocalFolder(booksDir, 'books');
    zip.writeZip(result.filePath);
    const size = fs.statSync(result.filePath).size;
    return { ok: true, path: result.filePath, size, bookCount: meta.books.length };
  } catch (e) {
    console.error('Backup failed:', e);
    return { error: e.message };
  }
});

ipcMain.handle('library:restore', async () => {
  const open = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore library from backup',
    properties: ['openFile'],
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
  });
  if (open.canceled || !open.filePaths[0]) return { canceled: true };
  const zipPath = open.filePaths[0];

  // Confirm before clobbering the current library. We don't peek inside the
  // zip first because validation will reject it with a more useful error
  // (manifest mismatch, traversal entry) than a count would convey.
  const confirm = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Restore'],
    defaultId: 0,
    cancelId: 0,
    title: 'Replace current library?',
    message: 'This will replace your current library with the contents of the backup.',
    detail:
      'Your existing books and metadata are renamed aside (with a `.backup-<timestamp>` suffix) so you can recover them manually if needed.',
  });
  if (confirm.response !== 1) return { canceled: true };

  let stagingDir = null;
  try {
    let zip;
    try {
      zip = new AdmZip(zipPath);
    } catch (e) {
      return { error: `Could not read zip: ${e.message}` };
    }
    const entries = zip.getEntries();

    // Quota guards against a zip bomb or accidentally selected non-backup
    // file. Numbers are generous so a real personal library never trips
    // them; the goal is to refuse pathological inputs before we start
    // decompressing 1000x ratios into memory.
    const MAX_ENTRIES = 50_000;
    const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024 * 1024; // 50 GB
    const MAX_JSON_BYTES = 4 * 1024 * 1024; // 4 MB for manifest/books.json
    if (entries.length > MAX_ENTRIES) {
      return { error: `Backup has too many entries (${entries.length} > ${MAX_ENTRIES}).` };
    }
    let totalUncompressed = 0;
    for (const e of entries) {
      const size = (e.header && Number(e.header.size)) || 0;
      if (size < 0) return { error: 'Backup entry has invalid size.' };
      totalUncompressed += size;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
        return { error: 'Backup uncompressed size exceeds limit (50 GB).' };
      }
    }

    const manifestEntry = entries.find((e) => e.entryName === 'manifest.json');
    let manifest = null;
    if (manifestEntry) {
      if ((manifestEntry.header && Number(manifestEntry.header.size)) > MAX_JSON_BYTES) {
        return { error: 'Backup manifest.json is unreasonably large.' };
      }
      try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
      } catch {
        return { error: 'Backup manifest.json is corrupt.' };
      }
    }
    const booksJsonEntry = entries.find((e) => e.entryName === 'books.json');
    let backupMeta = null;
    if (booksJsonEntry) {
      if ((booksJsonEntry.header && Number(booksJsonEntry.header.size)) > MAX_JSON_BYTES) {
        return { error: 'Backup books.json is unreasonably large.' };
      }
      try {
        backupMeta = JSON.parse(booksJsonEntry.getData().toString('utf8'));
      } catch {
        return { error: 'Backup books.json is corrupt.' };
      }
    }
    // Pull every flat file under books/ from the archive. Reject directory
    // entries upfront — the validator only handles single basenames.
    const fileNames = [];
    const fileEntries = [];
    for (const e of entries) {
      if (!e.entryName.startsWith('books/')) continue;
      if (e.isDirectory) continue;
      const rel = e.entryName.slice('books/'.length);
      fileNames.push(rel);
      fileEntries.push(e);
    }
    const v = validateBackup({ manifest, meta: backupMeta, fileNames });
    if (!v.ok) return { error: v.error };

    // Stage the restore under userData so the eventual rename is same-volume
    // and atomic. If any write fails, we abort before touching live state.
    const userData = app.getPath('userData');
    stagingDir = path.join(userData, `restore-staging-${Date.now()}`);
    const stagingBooks = path.join(stagingDir, 'books');
    fs.mkdirSync(stagingBooks, { recursive: true });
    // extractEntryTo streams to disk instead of buffering the full
    // decompressed file in memory via getData(). With multi-GB ebooks
    // a single getData() call could OOM the main process even though
    // the total-size quota above passed.
    for (const e of fileEntries) {
      zip.extractEntryTo(e, stagingBooks, /*maintainEntryPath*/ false, /*overwrite*/ true);
    }
    fs.writeFileSync(path.join(stagingDir, 'books.json'), booksJsonEntry.getData());

    // Swap with rollback. The four renames are not atomic as a group, but
    // we track which steps succeeded so a mid-sequence failure can undo
    // them and leave the library at its original paths. If rollback
    // itself fails, the .backup-<ts> aside files remain for manual
    // recovery and we surface explicit instructions in the error.
    const ts = Date.now();
    const oldBooksAside = `${booksDir}.backup-${ts}`;
    const oldMetaAside = `${metaFile}.backup-${ts}`;
    const stagedBooksJson = path.join(stagingDir, 'books.json');
    let stage = 0;
    try {
      if (fs.existsSync(booksDir)) {
        fs.renameSync(booksDir, oldBooksAside);
        stage = 1;
      }
      if (fs.existsSync(metaFile)) {
        fs.renameSync(metaFile, oldMetaAside);
        stage = 2;
      }
      fs.renameSync(stagingBooks, booksDir);
      stage = 3;
      fs.renameSync(stagedBooksJson, metaFile);
      stage = 4;
    } catch (swapErr) {
      try {
        if (stage >= 4) fs.renameSync(metaFile, stagedBooksJson);
        if (stage >= 3) fs.renameSync(booksDir, stagingBooks);
        if (stage >= 2) fs.renameSync(oldMetaAside, metaFile);
        if (stage >= 1) fs.renameSync(oldBooksAside, booksDir);
      } catch (rollbackErr) {
        return {
          error: `Restore swap failed (${swapErr.message}) and rollback also failed (${rollbackErr.message}). Recover manually: rename ${oldBooksAside} → ${path.basename(booksDir)} and ${oldMetaAside} → ${path.basename(metaFile)}.`,
        };
      }
      return { error: `Restore swap failed: ${swapErr.message}. Library left intact.` };
    }
    try {
      fs.rmdirSync(stagingDir);
    } catch {}
    stagingDir = null;

    metaCache = null;
    if (mainWindow) mainWindow.webContents.send('books:changed');
    return { ok: true, bookCount: backupMeta.books.length };
  } catch (e) {
    console.error('Restore failed:', e);
    if (stagingDir) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
    return { error: e.message };
  }
});

// ---------- Context menu ----------

ipcMain.handle('books:showContextMenu', (e, id) => {
  // General library menu when no specific book is selected
  if (!id) {
    const generalMenu = Menu.buildFromTemplate([
      {
        label: 'Add Books…',
        click: async () => {
          const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Add Books',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Ebooks', extensions: SUPPORTED_EXTS.map((x) => x.slice(1)) }],
          });
          if (!result.canceled) {
            await addManyBooks(result.filePaths);
            if (mainWindow) mainWindow.webContents.send('books:changed');
          }
        },
      },
      {
        label: 'Open library folder in Finder',
        click: () => shell.openPath(booksDir),
      },
      { type: 'separator' },
      {
        label: `${listBooks().length} book${listBooks().length === 1 ? '' : 's'} in library`,
        enabled: false,
      },
    ]);
    generalMenu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
    return;
  }

  const book = listBooks().find((b) => b.id === id);
  if (!book) return;
  const kindlePath = path.join(booksDir, book.file);
  const origPath = book.originalFile ? path.join(booksDir, book.originalFile) : null;

  const template = [
    {
      label: `${book.title}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Kindle file in Finder',
      enabled: fs.existsSync(kindlePath),
      click: () => shell.showItemInFolder(kindlePath),
    },
    {
      label: 'Show original in Finder',
      enabled: !!(origPath && fs.existsSync(origPath) && origPath !== kindlePath),
      click: () => origPath && shell.showItemInFolder(origPath),
    },
    {
      label: 'Open in default app',
      enabled: fs.existsSync(kindlePath),
      click: () => shell.openPath(kindlePath),
    },
    { type: 'separator' },
    {
      label: 'Copy title',
      click: () => require('electron').clipboard.writeText(book.title || ''),
    },
    {
      label: 'Copy download URL',
      click: () => {
        const url = `http://${getLocalIP()}:${PORT}/${serverToken}/download/${book.id}`;
        require('electron').clipboard.writeText(url);
      },
    },
    { type: 'separator' },
    {
      label: 'Set cover from URL…',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('cover:prompt-url', book.id);
      },
    },
    {
      label: 'Re-fetch cover from Open Library',
      click: async () => {
        try {
          const doc = await searchOpenLibrary(book.title, book.author);
          if (!doc) return;
          const coverCandidate = path.join(booksDir, `${book.id}.cover`);
          const ok = await downloadOpenLibraryCover(doc, coverCandidate);
          if (ok) {
            const meta = loadMeta();
            const target = meta.books.find((x) => x.id === book.id);
            if (target) {
              target.cover = `${book.id}.cover`;
              if (!target.author && doc.author_name && doc.author_name[0])
                target.author = doc.author_name[0];
              if (!target.year && doc.first_publish_year) target.year = doc.first_publish_year;
              saveMeta(meta);
              if (mainWindow) mainWindow.webContents.send('books:changed');
            }
          }
        } catch (err) {
          console.warn('Cover re-fetch failed:', err.message);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Remove from library',
      click: () => {
        deleteBook(id);
        if (mainWindow) mainWindow.webContents.send('books:changed');
      },
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
});
