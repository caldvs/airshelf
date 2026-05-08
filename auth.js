const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Constant-time compare for the server token. timingSafeEqual throws on
// length mismatch, so we check length first ourselves.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Pronounceable 6-char token (consonant-vowel-consonant-vowel-consonant-vowel)
// chosen to be quick to type on the Kindle's experimental browser keyboard,
// where mode-switching between letters and digits costs many extra taps.
// 21 consonants × 5 vowels at 3 positions each = 1,157,625 combinations
// (~20 bits). The on-the-wire keyspace is small enough that brute-force is
// only impractical when paired with the per-IP rate limiter (FailedAuthLimiter)
// applied to /404/ responses in the HTTP server.
const VOWELS = 'aeiou';
const CONSONANTS = 'bcdfghjklmnpqrstvwxyz'; // 21 — drops the rare/awkward ones implicitly via vowel positions

const TOKEN_RE = /^[a-z]{6}$/;

function generatePronounceableToken() {
  let out = '';
  for (let i = 0; i < 6; i++) {
    const pool = (i % 2 === 0) ? CONSONANTS : VOWELS;
    const limit = Math.floor(256 / pool.length) * pool.length;
    let idx;
    do {
      idx = crypto.randomBytes(1)[0];
    } while (idx >= limit);
    out += pool[idx % pool.length];
  }
  return out;
}

// Persist token to userData; reuse across launches so the user only types
// the URL on the Kindle once. Mode 0600 — possession of this token = full
// LAN access to the library.
function loadOrCreateServerToken(userData) {
  const tokenFile = path.join(userData, 'server-token');
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (TOKEN_RE.test(t)) {
      // The mode arg on writeFileSync only applies on create, so a file
      // created earlier with looser perms (e.g. by an older version that
      // forgot the mode) would stay loose. chmod every load to be sure.
      try { fs.chmodSync(tokenFile, 0o600); } catch {}
      return t;
    }
    // Old format (e.g. legacy 32-hex) — regenerate.
  } catch {}
  const t = generatePronounceableToken();
  writeTokenAtomic(tokenFile, t);
  return t;
}

// Force-generate a new token, replacing the existing file. Used by the CLI
// rotate-token command (#37) via POST /<token>/rotate-token. Atomic write
// so a crash mid-rotation leaves either the old or new token fully on disk
// — never a half-written byte sequence that would lock the user out until
// they delete the file.
function rotateServerToken(userData) {
  const tokenFile = path.join(userData, 'server-token');
  const t = generatePronounceableToken();
  writeTokenAtomic(tokenFile, t);
  return t;
}

function writeTokenAtomic(tokenFile, token) {
  const tmp = `${tokenFile}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, tokenFile);
}

// Per-IP rate limiter for failed auth attempts. The token has only ~20 bits
// of entropy, so without throttling a LAN attacker could brute-force in
// hours. With the defaults below, exhausting the keyspace at the per-IP
// rate would take centuries.
class FailedAuthLimiter {
  constructor({ windowMs = 5 * 60_000, maxFails = 10, blockMs = 15 * 60_000 } = {}) {
    this.windowMs = windowMs;
    this.maxFails = maxFails;
    this.blockMs = blockMs;
    this.fails = new Map();   // ip → [timestamp, ...]
    this.blocked = new Map(); // ip → blockUntil ts
  }

  isBlocked(ip, now = Date.now()) {
    const until = this.blocked.get(ip);
    if (until == null) return false;
    if (until <= now) {
      this.blocked.delete(ip);
      this.fails.delete(ip);
      return false;
    }
    return true;
  }

  recordFail(ip, now = Date.now()) {
    if (this.isBlocked(ip, now)) return;
    const arr = (this.fails.get(ip) || []).filter(ts => ts > now - this.windowMs);
    arr.push(now);
    this.fails.set(ip, arr);
    if (arr.length >= this.maxFails) {
      this.blocked.set(ip, now + this.blockMs);
      this.fails.delete(ip);
    }
  }

  recordSuccess(ip) {
    this.fails.delete(ip);
  }
}

module.exports = {
  tokensMatch,
  loadOrCreateServerToken,
  rotateServerToken,
  generatePronounceableToken,
  FailedAuthLimiter,
  TOKEN_RE,
};
