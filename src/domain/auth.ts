import { randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

// Constant-time compare for the server token. timingSafeEqual throws on
// length mismatch, so we check length first ourselves.
export function tokensMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
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

export const TOKEN_RE = /^[a-z]{6}$/;

export function generatePronounceableToken(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    const pool = i % 2 === 0 ? CONSONANTS : VOWELS;
    const limit = Math.floor(256 / pool.length) * pool.length;
    let idx: number;
    do {
      idx = randomBytes(1)[0];
    } while (idx >= limit);
    out += pool[idx % pool.length];
  }
  return out;
}

// Persist token to userData; reuse across launches so the user only types
// the URL on the Kindle once. Mode 0600 — possession of this token = full
// LAN access to the library.
export function loadOrCreateServerToken(userData: string): string {
  const tokenFile = join(userData, 'server-token');
  try {
    const t = readFileSync(tokenFile, 'utf8').trim();
    if (TOKEN_RE.test(t)) {
      // The mode arg on writeFileSync only applies on create, so a file
      // created earlier with looser perms (e.g. by an older version that
      // forgot the mode) would stay loose. chmod every load to be sure.
      try {
        chmodSync(tokenFile, 0o600);
      } catch {}
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
export function rotateServerToken(userData: string): string {
  const tokenFile = join(userData, 'server-token');
  // Read the current token (if any) so we can guarantee the rotation
  // actually rotates. Token entropy is ~20 bits, so a same-token redraw
  // would happen ~1 in 1.16M rotations — rare but real, and a "rotation"
  // that returns the same value is silently a no-op for the user.
  let current: string | null = null;
  try {
    const raw = readFileSync(tokenFile, 'utf8').trim();
    if (TOKEN_RE.test(raw)) current = raw;
  } catch {}
  // Bounded retry: collision odds are vanishing, but cap so a broken RNG
  // can't spin forever.
  let t = generatePronounceableToken();
  for (let attempt = 0; attempt < 8 && t === current; attempt++) {
    t = generatePronounceableToken();
  }
  writeTokenAtomic(tokenFile, t);
  return t;
}

function writeTokenAtomic(tokenFile: string, token: string): void {
  const tmp = `${tokenFile}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, tokenFile);
}

interface FailedAuthLimiterOptions {
  windowMs?: number;
  maxFails?: number;
  blockMs?: number;
}

// Per-IP rate limiter for failed auth attempts. The token has only ~20 bits
// of entropy, so without throttling a LAN attacker could brute-force in
// hours. With the defaults below, exhausting the keyspace at the per-IP
// rate would take centuries.
export class FailedAuthLimiter {
  private readonly windowMs: number;
  private readonly maxFails: number;
  private readonly blockMs: number;
  private readonly fails: Map<string, number[]>;
  private readonly blocked: Map<string, number>;

  constructor({
    windowMs = 5 * 60_000,
    maxFails = 10,
    blockMs = 15 * 60_000,
  }: FailedAuthLimiterOptions = {}) {
    this.windowMs = windowMs;
    this.maxFails = maxFails;
    this.blockMs = blockMs;
    this.fails = new Map();
    this.blocked = new Map();
  }

  isBlocked(ip: string, now: number = Date.now()): boolean {
    const until = this.blocked.get(ip);
    if (until == null) return false;
    if (until <= now) {
      this.blocked.delete(ip);
      this.fails.delete(ip);
      return false;
    }
    return true;
  }

  recordFail(ip: string, now: number = Date.now()): void {
    if (this.isBlocked(ip, now)) return;
    const arr = (this.fails.get(ip) || []).filter((ts) => ts > now - this.windowMs);
    arr.push(now);
    this.fails.set(ip, arr);
    if (arr.length >= this.maxFails) {
      this.blocked.set(ip, now + this.blockMs);
      this.fails.delete(ip);
    }
  }

  recordSuccess(ip: string): void {
    this.fails.delete(ip);
  }
}
