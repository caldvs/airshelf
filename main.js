const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

function extractEpubTitle(epubPath) {
  try {
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries();
    const containerEntry = entries.find(e => e.entryName === 'META-INF/container.xml');
    if (!containerEntry) return null;
    const opfMatch = containerEntry.getData().toString('utf8').match(/full-path="([^"]+)"/);
    if (!opfMatch) return null;
    const opfEntry = entries.find(e => e.entryName === opfMatch[1]);
    if (!opfEntry) return null;
    const opfXml = opfEntry.getData().toString('utf8');
    const m = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
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

  // Extract cover + title from EPUB before any conversion
  let title = null;
  let coverFile = null;
  if (ext === '.epub') {
    title = extractEpubTitle(originalPath);
    const coverCandidate = path.join(booksDir, `${id}.cover`);
    if (extractEpubCover(originalPath, coverCandidate)) {
      coverFile = `${id}.cover`;
    }
  }
  if (!title) title = path.basename(srcPath, ext);

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

function renderIndexHtml() {
  const books = listBooks();
  const total = books.length;
  const rows = books.map((b, i) => `
    <table class="book" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td colspan="3" class="index-cell">${i + 1} of ${total}</td>
      </tr>
      <tr>
        <td class="cover-cell" valign="middle" width="160">
          <a href="/download/${b.id}.${b.ext}">
            ${b.cover
              ? `<div class="cover-frame" style="background-image:url('/cover/${b.id}')"></div>`
              : `<div class="cover-frame cover-fallback">${escapeHtml(b.title.slice(0, 40))}</div>`}
          </a>
        </td>
        <td class="info-cell" valign="middle">
          <div class="title"><a href="/download/${b.id}.${b.ext}">${escapeHtml(b.title)}</a></div>
          <div class="meta">${b.ext.toUpperCase()} &middot; ${humanSize(b.size)}</div>
        </td>
        <td class="btn-cell" valign="middle" align="right">
          <a class="dl-btn" href="/download/${b.id}.${b.ext}">Download</a>
        </td>
      </tr>
      <tr><td colspan="3" class="spacer"></td></tr>
    </table>
  `).join('');
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
    padding: 18px 0 4px 0;
    font-size: 16px;
    font-weight: bold;
    color: #666;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  td.cover-cell { width: 160px; padding: 8px 20px 24px 0; vertical-align: middle; }
  td.info-cell  { padding: 8px 12px 24px 0; vertical-align: middle; }
  td.btn-cell   { padding: 8px 0 24px 0; vertical-align: middle; text-align: right; white-space: nowrap; }
  td.spacer {
    border-top: 1px solid #ccc;
    height: 0;
    line-height: 0;
    font-size: 0;
    padding: 0;
  }

  /* Cover: fixed 150x210 frame, image fills entire area (cropped to fit) */
  .cover-frame {
    display: block;
    width: 150px;
    height: 210px;
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
    font-size: 15px;
    background-color: #f0f0f0;
    background-image: none;
  }

  /* Title and meta */
  .title { font-size: 26px; font-weight: bold; line-height: 1.2; margin: 0 0 10px 0; }
  .title a { color: #000; text-decoration: none; }
  .meta { font-size: 18px; color: #333; margin: 0 0 18px 0; }

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
        const buf = fs.readFileSync(coverPath);
        // sniff image type
        let type = 'image/jpeg';
        if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png';
        else if (buf[0] === 0x47 && buf[1] === 0x49) type = 'image/gif';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=3600',
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
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
