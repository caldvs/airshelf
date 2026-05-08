#!/usr/bin/env node
//
// `airshelf` CLI — read-only commands that inspect a running (or recently-run)
// Airshelf instance via the on-disk state. All shipped commands are pure
// reads against userData; mutating commands (e.g. `send`, `rotate-token`)
// are deliberately deferred — they need a privileged HTTP surface or risk
// racing with the running app.
//
// Usage:
//   airshelf url   # print the Kindle URL for the running token
//   airshelf list  # print the library (id, title, author, size)
//   airshelf -h    # help

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PRODUCT_NAME = 'Airshelf';
const PORT = parseInt(process.env.PORT, 10) || 6790;

// Replicates Electron's `app.getPath('userData')` for the platforms we ship
// on. Hard-coded rather than spawning Electron because spinning up the full
// runtime to read a JSON file is silly.
function userDataDir(name = PRODUCT_NAME) {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), name);
}

function readToken(userData) {
  const tokenFile = path.join(userData, 'server-token');
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (/^[a-z]{6}$/.test(t)) return t;
  } catch {}
  return null;
}

function readBooks(userData) {
  const metaFile = path.join(userData, 'books.json');
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return Array.isArray(raw && raw.books) ? raw.books : [];
  } catch {
    return [];
  }
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function humanSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cmdUrl() {
  const userData = userDataDir();
  const token = readToken(userData);
  if (!token) {
    process.stderr.write(
      `airshelf: no server token found in ${userData}\n` +
      `Launch Airshelf at least once so the token file is created.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`http://${getLocalIP()}:${PORT}/${token}/\n`);
}

function cmdList() {
  const userData = userDataDir();
  const books = readBooks(userData);
  if (!books.length) {
    process.stderr.write(`airshelf: no books found in ${userData}/books.json\n`);
    process.exit(1);
  }
  // TSV — easy to pipe into `awk`, `column -t -s $'\t'`, or `sort`. Headers
  // sent to stderr so they don't pollute pipelines.
  process.stderr.write(`id\ttitle\tauthor\tsize\n`);
  for (const b of books) {
    const line = [
      b.id || '',
      (b.title || '').replace(/\t/g, ' '),
      (b.author || '').replace(/\t/g, ' '),
      humanSize(typeof b.size === 'number' ? b.size : NaN),
    ].join('\t');
    process.stdout.write(`${line}\n`);
  }
}

// Send each path to the running Airshelf via POST /<token>/upload. The
// running app's HTTP server runs the same addBook pipeline used by the
// drag-drop and "Add books" flows — hash dedup, cover extraction, AZW3
// conversion, books.json update — so we get the full feature set without
// re-implementing it CLI-side.
async function cmdSend(paths) {
  if (!paths.length) {
    process.stderr.write(`airshelf: send needs at least one file path\n`);
    process.exit(2);
  }
  const userData = userDataDir();
  const token = readToken(userData);
  if (!token) {
    process.stderr.write(`airshelf: no server token found in ${userData}\n`);
    process.exit(1);
  }
  const baseUrl = `http://127.0.0.1:${PORT}/${token}`;
  let okCount = 0;
  let dupCount = 0;
  let errCount = 0;
  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (e) {
      process.stdout.write(`${p}\terror\tCannot read: ${e.message}\n`);
      errCount += 1;
      continue;
    }
    if (!stat.isFile()) {
      process.stdout.write(`${p}\terror\tNot a regular file\n`);
      errCount += 1;
      continue;
    }
    const filename = path.basename(p);
    const stream = fs.createReadStream(p);
    let res;
    try {
      res = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(stat.size),
          'X-Filename': filename,
        },
        body: stream,
        // Node's fetch requires duplex: 'half' for streamed bodies.
        duplex: 'half',
      });
    } catch (e) {
      // Node's fetch wraps the network error as `TypeError: fetch failed`
      // and pins the original on .cause. We unwrap to give the user a
      // concrete "is Airshelf running?" instead of the opaque message.
      const code = e?.code ?? e?.cause?.code;
      const hint = code === 'ECONNREFUSED'
        ? `is Airshelf running on port ${PORT}?`
        : e?.cause?.message || e?.message || String(e);
      process.stdout.write(`${p}\terror\t${hint}\n`);
      errCount += 1;
      continue;
    }
    let payload = null;
    try { payload = await res.json(); } catch {}
    if (res.ok && payload && payload.book) {
      process.stdout.write(`${p}\tadded\t${payload.book.id}\n`);
      okCount += 1;
    } else if (res.ok && payload && payload.duplicate) {
      process.stdout.write(`${p}\tduplicate\t${payload.duplicate.id || ''}\n`);
      dupCount += 1;
    } else {
      const msg = (payload && payload.error) || `HTTP ${res.status}`;
      process.stdout.write(`${p}\terror\t${msg}\n`);
      errCount += 1;
    }
  }
  process.stderr.write(`added ${okCount}, duplicate ${dupCount}, error ${errCount}\n`);
  process.exit(errCount > 0 ? 1 : 0);
}

function cmdHelp() {
  process.stdout.write(
    `airshelf — CLI for the Airshelf Mac app\n` +
    `\n` +
    `Usage:\n` +
    `  airshelf url           print the Kindle URL (http://<lan-ip>:6790/<token>/)\n` +
    `  airshelf list          print the library as TSV (id, title, author, size)\n` +
    `  airshelf send <file…>  upload one or more ebooks (TSV: path<TAB>status<TAB>info)\n` +
    `  airshelf -h            this help\n` +
    `\n` +
    `url and list read state from\n` +
    `  ${userDataDir()}\n` +
    `send requires Airshelf to be running on this machine.\n`,
  );
}

function main(argv) {
  const cmd = argv[2];
  switch (cmd) {
    case 'url':  return cmdUrl();
    case 'list': return cmdList();
    case 'send': return cmdSend(argv.slice(3));
    case '-h':
    case '--help':
    case 'help':
    case undefined: return cmdHelp();
    default:
      process.stderr.write(`airshelf: unknown command "${cmd}". Try \`airshelf -h\`.\n`);
      process.exit(2);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { userDataDir, humanSize, readToken, readBooks };
