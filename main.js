const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');

const PORT = parseInt(process.env.PORT, 10) || 6790;

// Files the Kindle experimental browser can download directly
const KINDLE_NATIVE_EXTS = ['.mobi', '.prc', '.azw', '.txt'];
// Extra formats Calibre can convert to MOBI for us
const CONVERTIBLE_EXTS = [
  '.epub', '.azw3', '.fb2', '.fbz', '.lit', '.lrf', '.pdb', '.pdf',
  '.rtf', '.docx', '.odt', '.html', '.htm', '.htmlz', '.chm', '.cbz', '.cbr',
];
const SUPPORTED_EXTS = [...KINDLE_NATIVE_EXTS, ...CONVERTIBLE_EXTS];

// Locate Calibre's ebook-convert binary
function findEbookConvert() {
  const candidates = [
    '/opt/homebrew/bin/ebook-convert',
    '/usr/local/bin/ebook-convert',
    '/Applications/calibre.app/Contents/MacOS/ebook-convert',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Downsize a cover image in place using macOS sips (or ignore if unavailable).
// Kindle browser renders large JPEGs slowly line-by-line, so we keep them small.
function resizeCoverInPlace(filePath, maxDim = 500) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    // Skip if already small
    try {
      const size = fs.statSync(filePath).size;
      if (size < 60 * 1024) return resolve(false); // already small
    } catch { return resolve(false); }

    execFile('/usr/bin/sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', filePath, '--out', filePath], { timeout: 30000 }, (err) => {
      resolve(!err);
    });
  });
}

function convertToMobi(srcPath, outPath) {
  return new Promise((resolve, reject) => {
    const bin = findEbookConvert();
    if (!bin) return reject(new Error('Calibre ebook-convert not found. Install Calibre.'));
    execFile(bin, [srcPath, outPath, '--output-profile', 'kindle_pw3'], {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
}

let mainWindow = null;
let server = null;
let booksDir = null;
let metaFile = null;

// ---------- Book storage ----------

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    return { books: [] };
  }
}

function saveMeta(meta) {
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

function extractEpubCover(epubPath, outPath) {
  try {
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries();

    // Look in container.xml for OPF path
    const containerEntry = entries.find(e => e.entryName === 'META-INF/container.xml');
    if (!containerEntry) return false;
    const containerXml = containerEntry.getData().toString('utf8');
    const opfMatch = containerXml.match(/full-path="([^"]+)"/);
    if (!opfMatch) return false;
    const opfPath = opfMatch[1];
    const opfEntry = entries.find(e => e.entryName === opfPath);
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
      const m = opfXml.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/)
        || opfXml.match(/<item[^>]+href="([^"]+)"[^>]+properties="cover-image"/);
      if (m) coverHref = m[1];
    }
    // Last fallback: any image with "cover" in href
    if (!coverHref) {
      const m = opfXml.match(/<item[^>]+href="([^"]*cover[^"]*\.(?:jpe?g|png))"[^>]*media-type="image\//i);
      if (m) coverHref = m[1];
    }
    if (!coverHref) return false;

    const fullCoverPath = opfDir && opfDir !== '.' ? path.posix.join(opfDir, coverHref) : coverHref;
    const coverEntry = entries.find(e => e.entryName === fullCoverPath);
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
    const containerEntry = entries.find(e => e.entryName === 'META-INF/container.xml');
    if (!containerEntry) return {};
    const opfMatch = containerEntry.getData().toString('utf8').match(/full-path="([^"]+)"/);
    if (!opfMatch) return {};
    const opfEntry = entries.find(e => e.entryName === opfMatch[1]);
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

function extractEpubTitle(epubPath) {
  return extractEpubMeta(epubPath).title;
}

// Loose title matching: returns true if one title is effectively a prefix of the other.
function titlesMatch(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Prefix match at word boundaries with a minimum length
  if (na.length >= 4 && nb.startsWith(na + ' ')) return true;
  if (nb.length >= 4 && na.startsWith(nb + ' ')) return true;
  return false;
}

// Clean a raw title/filename into something searchable.
// Strips extensions, author separators, series markers, underscores, etc.
function cleanTitle(raw) {
  if (!raw) return '';
  let t = String(raw);
  // Drop extension if present
  t = t.replace(/\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i, '');
  // Split off " -- Author" or " - Author" — common filename convention
  t = t.split(/\s+--?\s+/)[0];
  // Drop parenthetical series/book markers "(The Foo Book 1)"
  t = t.replace(/\s*\([^)]*\)\s*$/g, '');
  // Replace underscores and extra whitespace
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// Attempt to pull an author out of a raw filename like "Title -- Author.epub"
function guessAuthorFromFilename(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i, '');
  const parts = stripped.split(/\s+--?\s+/);
  if (parts.length >= 2) {
    // Authors are often written "Last, First" — swap if so
    const candidate = parts[parts.length - 1].trim();
    if (/,/.test(candidate)) {
      const [last, first] = candidate.split(',').map(s => s.trim());
      if (first && last) return `${first} ${last}`;
    }
    return candidate;
  }
  return null;
}

// Query Open Library search for a book. Returns the first matching doc or null.
// Tries multiple query variants so that messy filename-derived titles still match.
async function searchOpenLibrary(title, author) {
  if (!title) return null;
  const variants = new Set();
  const cleaned = cleanTitle(title);
  if (cleaned) variants.add(cleaned);
  // Try the portion before a colon subtitle
  if (cleaned.includes(':')) variants.add(cleaned.split(':')[0].trim());
  // Fall back to the raw title
  variants.add(title);

  for (const variant of variants) {
    if (!variant || variant.length < 2) continue;
    try {
      const q = new URLSearchParams({ title: variant });
      if (author) q.set('author', author);
      q.set('limit', '1');
      const res = await fetch(`https://openlibrary.org/search.json?${q.toString()}`, {
        headers: { 'User-Agent': 'Airshelf/0.1 (ebook helper)' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const doc = data.docs && data.docs[0];
      if (doc && doc.cover_i) return doc; // prefer docs with a cover
      if (doc && !data.docs[0]._seen) data.docs[0]._seen = true;
    } catch {}
  }
  // Second pass — accept matches without cover_i
  for (const variant of variants) {
    if (!variant || variant.length < 2) continue;
    try {
      const q = new URLSearchParams({ title: variant });
      if (author) q.set('author', author);
      q.set('limit', '1');
      const res = await fetch(`https://openlibrary.org/search.json?${q.toString()}`, {
        headers: { 'User-Agent': 'Airshelf/0.1 (ebook helper)' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const doc = data.docs && data.docs[0];
      if (doc) return doc;
    } catch {}
  }
  return null;
}

// Download a cover image for an Open Library doc. Returns true on success.
async function downloadOpenLibraryCover(doc, outPath) {
  if (!doc) return false;
  const attempts = [];
  if (doc.cover_i) attempts.push(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`);
  if (doc.isbn && doc.isbn[0]) attempts.push(`https://covers.openlibrary.org/b/isbn/${doc.isbn[0]}-L.jpg`);
  if (doc.edition_key && doc.edition_key[0]) attempts.push(`https://covers.openlibrary.org/b/olid/${doc.edition_key[0]}-L.jpg`);
  for (const url of attempts) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Airshelf/0.1 (ebook helper)' },
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // Open Library returns a tiny placeholder when no cover exists
      if (buf.length < 1000) continue;
      fs.writeFileSync(outPath, buf);
      return true;
    } catch {}
  }
  return false;
}

// Legacy helper: fetch + rescue cover in one shot
async function fetchCoverFromOpenLibrary(title, author, outPath) {
  const doc = await searchOpenLibrary(title, author);
  return doc ? await downloadOpenLibraryCover(doc, outPath) : false;
}

async function addBook(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    return { error: `Unsupported format: ${ext}` };
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
  // Fall back to the filename and clean it up
  const rawBase = path.basename(srcPath, ext);
  if (!title) title = rawBase;
  title = cleanTitle(title);
  if (!author) author = guessAuthorFromFilename(rawBase);
  if (author) author = author.replace(/\s+/g, ' ').trim();

  // Always query Open Library — use the canonical title/author/year when we get
  // a confident match, and rescue missing covers.
  try {
    const doc = await searchOpenLibrary(title, author);
    if (doc) {
      const olTitle = doc.title;
      if (olTitle && titlesMatch(olTitle, title)) {
        // Strong match. Use OL's title only if it's as short or shorter
        // than ours (otherwise ours is probably the cleaner trimmed version).
        if (olTitle.length <= title.length + 4) {
          title = olTitle;
        }
        if (doc.author_name && doc.author_name[0]) author = doc.author_name[0];
        if (doc.first_publish_year) year = doc.first_publish_year;
      } else {
        // Weak match: still use OL data only for missing fields
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
    }
  } catch (e) {
    console.warn(`Metadata enrichment failed for "${title}":`, e.message);
  }

  // Ensure we have a Kindle-compatible file to serve
  let kindleFile;
  let kindleExt;
  let converted = false;
  if (KINDLE_NATIVE_EXTS.includes(ext)) {
    kindleFile = originalFileName;
    kindleExt = ext.slice(1);
  } else {
    const mobiName = `${id}.mobi`;
    const mobiPath = path.join(booksDir, mobiName);
    try {
      await convertToMobi(originalPath, mobiPath);
    } catch (e) {
      // Clean up the copied original and bail
      try { fs.unlinkSync(originalPath); } catch {}
      if (coverFile) { try { fs.unlinkSync(path.join(booksDir, coverFile)); } catch {} }
      return { error: `Conversion failed: ${e.message}` };
    }
    kindleFile = mobiName;
    kindleExt = 'mobi';
    converted = true;
  }

  const kindleSize = fs.statSync(path.join(booksDir, kindleFile)).size;

  const meta = loadMeta();
  const book = {
    id,
    title,
    author,
    year,
    originalName: path.basename(srcPath),
    originalFile: originalFileName,
    file: kindleFile,          // what we serve to the Kindle
    cover: coverFile,
    size: kindleSize,
    ext: kindleExt,
    sourceExt: ext.slice(1),
    converted,
    addedAt: Date.now(),
  };
  meta.books.push(book);
  saveMeta(meta);
  return { book };
}

function deleteBook(id) {
  const meta = loadMeta();
  const idx = meta.books.findIndex(b => b.id === id);
  if (idx === -1) return false;
  const book = meta.books[idx];
  for (const f of [book.file, book.originalFile, book.cover]) {
    if (!f) continue;
    try { fs.unlinkSync(path.join(booksDir, f)); } catch {}
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

    if (book.cover && book.author && book.year) continue;
    try {
      console.log(`Enriching "${book.title}"…`);
      const doc = await searchOpenLibrary(book.title, book.author);
      if (!doc) continue;
      let dirty = false;
      // Strong match → normalise canonical title (only if OL's isn't bloated)
      if (doc.title && titlesMatch(doc.title, book.title) && doc.title !== book.title && doc.title.length <= book.title.length + 4) {
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
        console.log(`Resized cover "${book.title}": ${(sizeBefore/1024).toFixed(0)}KB → ${(sizeAfter/1024).toFixed(0)}KB`);
      }
    } catch {}
  }
  if (mainWindow) mainWindow.webContents.send('books:changed');
}

// ---------- Networking ----------

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Renders a static mock of the Electron bookshelf UI — used only for the
// README screenshot. It is served from /screenshot in the same HTTP server.
function renderScreenshotHtml() {
  const books = listBooks().slice(0, 8);
  const rendered = books.map(b => {
    const coverMarkup = b.cover
      ? `<img src="/cover/${b.id}" alt="">`
      : `<div class="book-cover placeholder" style="font-size:11px;">${escapeHtml(b.title.slice(0, 30))}</div>`;
    return `
      <div class="book-card">
        <div class="book-cover">${b.cover ? `<img src="/cover/${b.id}" alt="">` : escapeHtml(b.title.slice(0, 24))}</div>
        <div class="book-title">${escapeHtml(b.title)}</div>
        <div class="book-size">${b.ext.toUpperCase()} &middot; ${humanSize(b.size)}</div>
      </div>
    `;
  }).join('');

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

function renderIndexHtml() {
  const books = listBooks();
  const total = books.length;
  const rows = books.map((b, i) => {
    const authorLine = b.author ? `<div class="author">${escapeHtml(b.author)}${b.year ? ` &middot; ${b.year}` : ''}</div>` : (b.year ? `<div class="author">${b.year}</div>` : '');
    return `
    <table class="book" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td colspan="3" class="index-cell">${i + 1} of ${total}</td>
      </tr>
      <tr>
        <td class="cover-cell" valign="middle" width="190">
          ${b.cover
            ? `<div class="cover-frame" style="background-image:url('/cover/${b.id}')"></div>`
            : `<div class="cover-frame cover-fallback">${escapeHtml(b.title.slice(0, 40))}</div>`}
        </td>
        <td class="info-cell" valign="middle">
          <div class="title">${escapeHtml(b.title)}</div>
          ${authorLine}
          <div class="meta">${b.ext.toUpperCase()} &middot; ${humanSize(b.size)}</div>
        </td>
        <td class="btn-cell" valign="middle" align="right">
          <a class="dl-btn" href="/download/${b.id}.${b.ext}">Download</a>
        </td>
      </tr>
      <tr><td colspan="3" class="spacer"></td></tr>
    </table>
  `;
  }).join('');
  const count = books.length;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>Airshelf</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    -webkit-text-size-adjust: none;
  }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 20px;
    line-height: 1.35;
    padding: 24px 20px 40px 20px;
  }

  /* Header */
  h1 { font-size: 42px; margin: 0 0 6px 0; font-weight: bold; }
  .sub { font-size: 20px; margin: 0 0 8px 0; }
  .count { font-size: 18px; margin: 0 0 16px 0; color: #333; }
  .head-rule { border: 0; border-top: 2px solid #000; margin: 0 0 12px 0; height: 0; }

  /* Book rows */
  table.book { margin: 0; width: 100%; }
  td.index-cell {
    padding: 22px 0 6px 0;
    font-size: 18px;
    font-weight: bold;
    color: #666;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  td.cover-cell { width: 190px; padding: 8px 24px 28px 0; vertical-align: middle; }
  td.info-cell  { padding: 8px 16px 28px 0; vertical-align: middle; }
  td.btn-cell   { padding: 8px 0 28px 0; vertical-align: middle; text-align: right; white-space: nowrap; }
  td.spacer {
    border-top: 1px solid #ccc;
    height: 0;
    line-height: 0;
    font-size: 0;
    padding: 0;
  }

  /* Cover: fixed 180x252 frame (20% larger), image fills entire area */
  .cover-frame {
    display: block;
    width: 180px;
    height: 252px;
    background-color: #fff;
    background-position: center center;
    background-repeat: no-repeat;
    background-size: cover;
    overflow: hidden;
  }
  .cover-fallback {
    line-height: 1.3;
    padding: 14px;
    box-sizing: border-box;
    text-align: center;
    font-weight: bold;
    font-size: 16px;
    background-color: #f0f0f0;
    background-image: none;
  }

  /* Title, author, meta */
  .title  { font-size: 30px; font-weight: bold; line-height: 1.2; margin: 0 0 8px 0; color: #000; }
  .author { font-size: 22px; line-height: 1.3; margin: 0 0 10px 0; color: #333; font-style: italic; }
  .meta   { font-size: 20px; color: #333; margin: 0; }

  /* Download button — 2x size, right-aligned next to info */
  a.dl-btn {
    display: inline-block;
    padding: 28px 44px;
    border: 2px solid #000;
    background: #000;
    color: #fff;
    text-decoration: none;
    font-weight: bold;
    font-size: 24px;
    text-align: center;
    white-space: nowrap;
  }

  .empty {
    text-align: center;
    padding: 60px 20px;
    font-size: 22px;
    border-top: 2px solid #000;
    border-bottom: 2px solid #000;
  }
  .footer { margin-top: 28px; font-size: 16px; color: #555; text-align: center; }
</style>
</head>
<body>
  <h1>Airshelf</h1>
  <div class="sub">Tap a book to download.</div>
  ${count ? `<div class="count">${count} ${count === 1 ? 'book' : 'books'} available</div>` : ''}
  <hr class="head-rule">
  ${count ? rows : `<div class="empty">No books yet.<br>Add some in the Airshelf app on your Mac.</div>`}
  <div class="footer">Airshelf</div>
</body>
</html>`;
}

function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/screenshot') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(renderScreenshotHtml());
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        res.end(renderIndexHtml());
        return;
      }
      const coverMatch = url.pathname.match(/^\/cover\/([a-f0-9]+)$/);
      if (coverMatch) {
        const id = coverMatch[1];
        const book = listBooks().find(b => b.id === id);
        if (!book || !book.cover) { res.writeHead(404); res.end('No cover'); return; }
        const coverPath = path.join(booksDir, book.cover);
        if (!fs.existsSync(coverPath)) { res.writeHead(404); res.end('Missing'); return; }
        const stat = fs.statSync(coverPath);
        const etag = `"${id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
        const lastModified = stat.mtime.toUTCString();

        // 304 if the client already has it
        if (req.headers['if-none-match'] === etag ||
            req.headers['if-modified-since'] === lastModified) {
          res.writeHead(304, {
            'ETag': etag,
            'Cache-Control': 'public, max-age=2592000, immutable',
          });
          res.end();
          return;
        }

        const buf = fs.readFileSync(coverPath);
        // sniff image type
        let type = 'image/jpeg';
        if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png';
        else if (buf[0] === 0x47 && buf[1] === 0x49) type = 'image/gif';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=2592000, immutable',
          'ETag': etag,
          'Last-Modified': lastModified,
          'Expires': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString(),
        });
        res.end(buf);
        return;
      }
      const dlMatch = url.pathname.match(/^\/download\/([a-f0-9]+)(?:\.[a-z0-9]+)?$/);
      if (dlMatch) {
        const id = dlMatch[1];
        const book = listBooks().find(b => b.id === id);
        if (!book) { res.writeHead(404); res.end('Not found'); return; }
        const filePath = path.join(booksDir, book.file);
        const stat = fs.statSync(filePath);
        // Use the book title + the Kindle-compatible extension so Kindle accepts the download
        const baseName = (book.title || 'book').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 80);
        const downloadName = `${baseName}.${book.ext}`;
        const mimeByExt = {
          mobi: 'application/x-mobipocket-ebook',
          prc: 'application/x-mobipocket-ebook',
          azw: 'application/vnd.amazon.ebook',
          txt: 'text/plain',
        };
        res.writeHead(200, {
          'Content-Type': mimeByExt[book.ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${downloadName}"`,
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      res.writeHead(500); res.end('Error');
    }
  });
  server.listen(PORT, '0.0.0.0');
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
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.icns')); } catch {}
  }
  const userData = app.getPath('userData');
  booksDir = path.join(userData, 'books');
  fs.mkdirSync(booksDir, { recursive: true });
  metaFile = path.join(userData, 'books.json');

  startServer();
  createWindow();
  migrateExistingBooks().catch(e => console.error('migration error', e));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) { server.close(); server = null; }
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

ipcMain.handle('books:list', () => {
  return listBooks().map(b => ({
    ...b,
    coverUrl: b.cover ? `file://${path.join(booksDir, b.cover)}` : null,
    sizeHuman: humanSize(b.size),
  }));
});

ipcMain.handle('books:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Books',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Ebooks', extensions: SUPPORTED_EXTS.map(e => e.slice(1)) }],
  });
  if (result.canceled) return { added: [], errors: [] };
  return await addManyBooks(result.filePaths);
});

ipcMain.handle('books:addPaths', async (_e, paths) => {
  return await addManyBooks(paths);
});

async function addManyBooks(paths) {
  const added = [];
  const errors = [];
  for (const p of paths) {
    try {
      const result = await addBook(p);
      if (result.book) added.push(result.book);
      else if (result.error) errors.push({ path: path.basename(p), error: result.error });
    } catch (e) {
      errors.push({ path: path.basename(p), error: e.message });
    }
  }
  return { added, errors };
}

ipcMain.handle('books:delete', (_e, id) => deleteBook(id));

ipcMain.handle('server:info', () => {
  return {
    ip: getLocalIP(),
    port: PORT,
    url: `http://${getLocalIP()}:${PORT}`,
    running: !!server,
  };
});

ipcMain.handle('open:external', (_e, url) => shell.openExternal(url));

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
            filters: [{ name: 'Ebooks', extensions: SUPPORTED_EXTS.map(x => x.slice(1)) }],
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

  const book = listBooks().find(b => b.id === id);
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
        const url = `http://${getLocalIP()}:${PORT}/download/${book.id}.${book.ext}`;
        require('electron').clipboard.writeText(url);
      },
    },
    { type: 'separator' },
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
            const target = meta.books.find(x => x.id === book.id);
            if (target) {
              target.cover = `${book.id}.cover`;
              if (!target.author && doc.author_name && doc.author_name[0]) target.author = doc.author_name[0];
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
