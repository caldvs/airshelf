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

function cmdHelp() {
  process.stdout.write(
    `airshelf — read-only CLI for the Airshelf Mac app\n` +
    `\n` +
    `Usage:\n` +
    `  airshelf url     print the Kindle URL (http://<lan-ip>:6790/<token>/)\n` +
    `  airshelf list    print the library as TSV (id, title, author, size)\n` +
    `  airshelf -h      this help\n` +
    `\n` +
    `Both commands read state from\n` +
    `  ${userDataDir()}\n` +
    `so Airshelf must have been launched at least once.\n`,
  );
}

function main(argv) {
  const cmd = argv[2];
  switch (cmd) {
    case 'url':  return cmdUrl();
    case 'list': return cmdList();
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
