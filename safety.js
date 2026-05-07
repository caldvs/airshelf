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

// Parse any valid IPv6 string into an 8-group array of 16-bit ints.
// Handles `::` shorthand and the IPv4-in-IPv6 dotted form (`::ffff:1.2.3.4`).
// Returns null on invalid input.
function parseIpv6(s) {
  if (!net.isIPv6(s)) return null;
  const lc = s.toLowerCase();
  let head, tail;
  if (lc.includes('::')) {
    const [h, t] = lc.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = lc.split(':');
    tail = [];
  }
  // Decode a trailing IPv4 form (`::ffff:1.2.3.4`) into two hex groups.
  const decodeTrailingV4 = (arr) => {
    const last = arr[arr.length - 1];
    if (!last || !last.includes('.')) return arr;
    if (!net.isIPv4(last)) return null;
    const [a, b, c, d] = last.split('.').map(Number);
    return [...arr.slice(0, -1),
      (((a << 8) | b) >>> 0).toString(16),
      (((c << 8) | d) >>> 0).toString(16)];
  };
  if (tail.length) tail = decodeTrailingV4(tail); else head = decodeTrailingV4(head);
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map(g => parseInt(g, 16));
  if (groups.length !== 8 || groups.some(g => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isPrivateIpv6(ip) {
  const g = parseIpv6(ip);
  if (!g) return false;
  // :: (unspecified) and ::1 (loopback)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
      g[4] === 0 && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
  // ::ffff:0:0/96 — IPv4-mapped. Decode and re-check via the v4 ranges so
  // hex-form spoofs like ::ffff:7f00:1 (= 127.0.0.1) can't sneak through.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const a = (g[6] >> 8) & 0xff, b = g[6] & 0xff;
    const c = (g[7] >> 8) & 0xff, d = g[7] & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }
  // fe80::/10 (link-local). First 10 bits = 1111111010, so first hextet
  // ranges fe80–febf when masked with 0xffc0. The earlier impl only matched
  // the literal "fe80:" prefix, letting fe90/fea0/feb0 slip past.
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // fc00::/7 (ULA). First 7 bits = 1111110.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // ff00::/8 (multicast)
  if ((g[0] & 0xff00) === 0xff00) return true;
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
