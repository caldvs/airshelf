const dns = require('dns/promises');
const net = require('net');
const path = require('path');

// --- IP range checks --------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function inV4Range(ip, cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  '0.0.0.0/8',          // "this network"
  '10.0.0.0/8',         // RFC1918
  '100.64.0.0/10',      // CGNAT
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local
  '172.16.0.0/12',      // RFC1918
  '192.0.0.0/24',       // IETF protocol assignments
  '192.168.0.0/16',     // RFC1918
  '198.18.0.0/15',      // benchmarking
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4',        // reserved
  '255.255.255.255/32', // broadcast
];

function isPrivateIpv4(ip) {
  return PRIVATE_V4.some(cidr => inV4Range(ip, cidr));
}

function isPrivateIpv6(ip) {
  const lc = ip.toLowerCase();
  if (lc === '::' || lc === '::1') return true;
  if (lc.startsWith('fe80:')) return true;       // link-local
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // ULA
  if (lc.startsWith('ff')) return true;          // multicast
  // IPv4-mapped IPv6: ::ffff:1.2.3.4
  const m = lc.match(/^::ffff:([\d.]+)$/);
  if (m && net.isIPv4(m[1])) return isPrivateIpv4(m[1]);
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true; // unknown / unparseable — fail closed
}

// --- URL validation ---------------------------------------------------------

const INTERNAL_HOST_SUFFIXES = ['.localhost', '.local'];

// Throws if the URL would target an internal address. Catches the common
// cases (literal IP, "localhost", *.local, *.localhost) synchronously,
// then DNS-resolves and rejects if any returned address is private.
//
// TOCTOU caveat: between this lookup and the actual fetch, DNS could change
// (DNS rebinding). Sufficient defense for a personal app that isn't a
// high-value target; harden further with a custom undici dispatcher if the
// threat model grows.
async function assertExternalUrl(input, { lookup = dns.lookup } = {}) {
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('Invalid URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must be http(s).');
  }
  const host = parsed.hostname;
  if (!host) throw new Error('URL has no host.');

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Refusing to fetch from internal address.');
    return;
  }
  const lcHost = host.toLowerCase();
  if (lcHost === 'localhost') throw new Error('Refusing to fetch from internal address.');
  if (INTERNAL_HOST_SUFFIXES.some(s => lcHost.endsWith(s))) {
    throw new Error('Refusing to fetch from internal address.');
  }

  const addrs = await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('Refusing to fetch from internal address.');
  }
}

// Validates a URL is safe to hand to shell.openExternal. Synchronous,
// scheme-only — we don't restrict the host because the user's browser
// (not us) makes the request, and they may legitimately want to open
// e.g. a router admin page.
function isSafeExternalScheme(input) {
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// --- Path-traversal guard ---------------------------------------------------

// True iff `name` is a single path component (no separators, no traversal,
// no NUL). Used on metadata fields that get joined with the books directory
// and served over HTTP — a tampered books.json with `book.file = "../etc"`
// would otherwise leak files outside the library.
function isSafeBasename(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return path.basename(name) === name;
}

module.exports = {
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  assertExternalUrl,
  isSafeExternalScheme,
  isSafeBasename,
};
