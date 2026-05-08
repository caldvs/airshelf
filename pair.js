// Short-lived pairing codes for the Kindle pairing flow (#34).
//
// The user types `<lan-ip>:6790/pair/<CODE>` on their Kindle. The server
// validates the code, sets a cookie carrying the long server token, and
// redirects to the library. The code itself is short, single-use, and
// expires fast — the security perimeter is the rate-limited LAN.
//
// Alphabet excludes ambiguous characters (0/O, 1/I/L, 2/Z, 5/S, 8/B, 6/G)
// so a user reading the code off the Mac screen is unlikely to mistype it
// on the Kindle's clunky on-screen keyboard.

const crypto = require('crypto');

const PAIR_ALPHABET = 'ACDEFHJKMNPQRTVWXY3479';
const PAIR_CODE_LEN = 4;
const PAIR_CODE_RE = new RegExp(`^[${PAIR_ALPHABET}]{${PAIR_CODE_LEN}}$`);
const PAIR_TTL_MS = 60_000;

function generatePairCode() {
  // Rejection sampling so the alphabet's length doesn't have to divide 256.
  const limit = Math.floor(256 / PAIR_ALPHABET.length) * PAIR_ALPHABET.length;
  let out = '';
  while (out.length < PAIR_CODE_LEN) {
    const b = crypto.randomBytes(1)[0];
    if (b >= limit) continue;
    out += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  }
  return out;
}

class PairCodeStore {
  // `generator` is injectable for deterministic tests; defaults to the
  // crypto-backed random generator used in production.
  constructor({ ttlMs = PAIR_TTL_MS, now = Date.now, generator = generatePairCode } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.generator = generator;
    // code (uppercased) → expiresAt
    this.codes = new Map();
  }

  // Returns the code; replaces any existing one — there's only ever one
  // active code at a time, since two codes wouldn't help the user (they'd
  // type whichever the screen showed last anyway) and would double the
  // server's exposure to brute-force attempts during the TTL.
  issue() {
    this.codes.clear();
    // Normalize+validate the generator's output so a future generator that
    // returns lowercase (or chars outside the alphabet) can't produce an
    // unconsumable code — consume() compares against the uppercase PAIR_CODE_RE.
    const raw = this.generator();
    const code = typeof raw === 'string' ? raw.toUpperCase() : '';
    if (!PAIR_CODE_RE.test(code)) {
      throw new Error(`PairCodeStore generator returned invalid code: ${JSON.stringify(raw)}`);
    }
    this.codes.set(code, this.now() + this.ttlMs);
    return code;
  }

  // Returns the active code without rotating it, or null if none / expired.
  // The renderer polls this so the user can see the same code update its
  // remaining lifetime, rather than getting a fresh code on every refresh.
  peek() {
    this._sweep();
    const [code] = this.codes.keys();
    if (!code) return null;
    const expiresAt = this.codes.get(code);
    return { code, expiresAt };
  }

  // Single-use: returns true and consumes if the code matches an unexpired
  // entry; false otherwise. Best-effort timing-safety on the value compare
  // (we use timingSafeEqual rather than ===), but the regex / type checks
  // above short-circuit on malformed input — those callers can already be
  // distinguished by timing. The defence here is the per-IP rate limiter
  // and the 60-second TTL, not constant-time validation.
  consume(input) {
    if (typeof input !== 'string') return false;
    const upper = input.toUpperCase();
    if (!PAIR_CODE_RE.test(upper)) return false;
    this._sweep();
    let matched = false;
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= this.now()) continue;
      const a = Buffer.from(code);
      const b = Buffer.from(upper);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        matched = true;
      }
    }
    if (matched) this.codes.clear();
    return matched;
  }

  _sweep() {
    const t = this.now();
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= t) this.codes.delete(code);
    }
  }
}

module.exports = {
  PAIR_ALPHABET,
  PAIR_CODE_LEN,
  PAIR_CODE_RE,
  PAIR_TTL_MS,
  generatePairCode,
  PairCodeStore,
};
