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

import { randomBytes, timingSafeEqual } from 'crypto';

export const PAIR_ALPHABET = 'ACDEFHJKMNPQRTVWXY3479';
export const PAIR_CODE_LEN = 4;
export const PAIR_CODE_RE = new RegExp(`^[${PAIR_ALPHABET}]{${PAIR_CODE_LEN}}$`);
export const PAIR_TTL_MS = 60_000;

export function generatePairCode(): string {
  // Rejection sampling so the alphabet's length doesn't have to divide 256.
  const limit = Math.floor(256 / PAIR_ALPHABET.length) * PAIR_ALPHABET.length;
  let out = '';
  while (out.length < PAIR_CODE_LEN) {
    const b = randomBytes(1)[0];
    if (b >= limit) continue;
    out += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  }
  return out;
}

interface PairCodeStoreOptions {
  ttlMs?: number;
  now?: () => number;
  generator?: () => string;
}

export interface ActivePairCode {
  code: string;
  expiresAt: number;
}

export class PairCodeStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generator: () => string;
  private readonly codes: Map<string, number>;

  // `generator` is injectable for deterministic tests; defaults to the
  // crypto-backed random generator used in production.
  constructor({
    ttlMs = PAIR_TTL_MS,
    now = Date.now,
    generator = generatePairCode,
  }: PairCodeStoreOptions = {}) {
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
  issue(): string {
    // Normalize+validate the generator's output BEFORE clearing the existing
    // entry, so a thrown validation error doesn't leave the store empty (the
    // previously-active code remains usable instead of being silently wiped).
    // consume() compares against the uppercase PAIR_CODE_RE, so we uppercase
    // here too.
    const raw = this.generator();
    const code = typeof raw === 'string' ? raw.toUpperCase() : '';
    if (!PAIR_CODE_RE.test(code)) {
      throw new Error(`PairCodeStore generator returned invalid code: ${JSON.stringify(raw)}`);
    }
    this.codes.clear();
    this.codes.set(code, this.now() + this.ttlMs);
    return code;
  }

  // Returns the active code without rotating it, or null if none / expired.
  // The renderer polls this so the user can see the same code update its
  // remaining lifetime, rather than getting a fresh code on every refresh.
  peek(): ActivePairCode | null {
    this._sweep();
    const [code] = this.codes.keys();
    if (!code) return null;
    const expiresAt = this.codes.get(code)!;
    return { code, expiresAt };
  }

  // Single-use: returns true and consumes if the code matches an unexpired
  // entry; false otherwise. Best-effort timing-safety on the value compare
  // (we use timingSafeEqual rather than ===), but the regex / type checks
  // above short-circuit on malformed input — those callers can already be
  // distinguished by timing. The defence here is the per-IP rate limiter
  // and the 60-second TTL, not constant-time validation.
  consume(input: unknown): boolean {
    if (typeof input !== 'string') return false;
    // Length-check before uppercasing so a megabyte-long /pair/<…> doesn't
    // allocate an O(N) uppercased copy just to be rejected by the regex.
    if (input.length !== PAIR_CODE_LEN) return false;
    const upper = input.toUpperCase();
    if (!PAIR_CODE_RE.test(upper)) return false;
    this._sweep();
    let matched = false;
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= this.now()) continue;
      const a = Buffer.from(code);
      const b = Buffer.from(upper);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        matched = true;
      }
    }
    if (matched) this.codes.clear();
    return matched;
  }

  private _sweep(): void {
    const t = this.now();
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= t) this.codes.delete(code);
    }
  }
}
