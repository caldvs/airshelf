import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tokensMatch,
  loadOrCreateServerToken,
  rotateServerToken,
  generatePronounceableToken,
  FailedAuthLimiter,
  TOKEN_RE,
} from './auth.js';

describe('tokensMatch', () => {
  it('matches identical strings', () => {
    expect(tokensMatch('abcdef', 'abcdef')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(tokensMatch('abcdef', 'abcdeg')).toBe(false);
  });

  it('rejects different lengths (no timingSafeEqual throw)', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(tokensMatch(null, 'x')).toBe(false);
    expect(tokensMatch('x', undefined)).toBe(false);
    expect(tokensMatch(123, '123')).toBe(false);
  });
});

describe('generatePronounceableToken', () => {
  it('returns a 6-char string matching TOKEN_RE', () => {
    for (let i = 0; i < 50; i++) {
      const t = generatePronounceableToken();
      expect(t).toMatch(TOKEN_RE);
    }
  });

  it('alternates consonant-vowel (positions 0,2,4 consonant; 1,3,5 vowel)', () => {
    const VOWELS = 'aeiou';
    for (let i = 0; i < 50; i++) {
      const t = generatePronounceableToken();
      for (let p = 0; p < 6; p++) {
        const isVowelPos = p % 2 === 1;
        const isVowel = VOWELS.includes(t[p]);
        expect(isVowel).toBe(isVowelPos);
      }
    }
  });

  it('produces varied output across many calls', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(generatePronounceableToken());
    // 50 draws from a 1.16M keyspace: collisions are astronomically rare.
    expect(seen.size).toBe(50);
  });
});

describe('loadOrCreateServerToken', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-auth-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a CVCVCV token on first call and persists it', () => {
    const t = loadOrCreateServerToken(dir);
    expect(t).toMatch(TOKEN_RE);
    const onDisk = fs.readFileSync(path.join(dir, 'server-token'), 'utf8').trim();
    expect(onDisk).toBe(t);
  });

  it('reuses the persisted token on subsequent calls', () => {
    const a = loadOrCreateServerToken(dir);
    const b = loadOrCreateServerToken(dir);
    expect(b).toBe(a);
  });

  it('regenerates if persisted token does not match the new format', () => {
    // Legacy 32-hex format — should be rotated to 6-char.
    fs.writeFileSync(path.join(dir, 'server-token'), '0123456789abcdef0123456789abcdef');
    const t = loadOrCreateServerToken(dir);
    expect(t).toMatch(TOKEN_RE);
    expect(t).not.toBe('0123456789abcdef0123456789abcdef');
  });

  it('regenerates on garbage contents', () => {
    fs.writeFileSync(path.join(dir, 'server-token'), 'not-a-token');
    expect(loadOrCreateServerToken(dir)).toMatch(TOKEN_RE);
  });

  it('writes the file with 0600 permissions', () => {
    loadOrCreateServerToken(dir);
    const stat = fs.statSync(path.join(dir, 'server-token'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('narrows perms on an existing valid token written with looser mode', () => {
    // Simulate an older app version that wrote without `mode: 0o600`. The
    // load path should chmod it down to 0600 even though the contents are
    // already valid.
    const tokenFile = path.join(dir, 'server-token');
    fs.writeFileSync(tokenFile, 'badera', { mode: 0o644 });
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o644);
    const t = loadOrCreateServerToken(dir);
    expect(t).toBe('badera');
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
});

describe('rotateServerToken', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-rotate-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces an existing token with a freshly-generated different one', () => {
    const a = loadOrCreateServerToken(dir);
    const b = rotateServerToken(dir);
    expect(b).toMatch(TOKEN_RE);
    // Guaranteed by the rotate() bounded-retry loop, not statistical.
    expect(b).not.toBe(a);
    const onDisk = fs.readFileSync(path.join(dir, 'server-token'), 'utf8').trim();
    expect(onDisk).toBe(b);
  });

  it('preserves 0600 permissions after rotation', () => {
    rotateServerToken(dir);
    const stat = fs.statSync(path.join(dir, 'server-token'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writes atomically — no .tmp file lingers on success', () => {
    rotateServerToken(dir);
    const entries = fs.readdirSync(dir);
    expect(entries).toContain('server-token');
    expect(entries.some(n => n.endsWith('.tmp'))).toBe(false);
  });
});

describe('FailedAuthLimiter', () => {
  it('does not block a fresh IP', () => {
    const l = new FailedAuthLimiter();
    expect(l.isBlocked('1.2.3.4')).toBe(false);
  });

  it('blocks after maxFails within the window', () => {
    const l = new FailedAuthLimiter({ windowMs: 60_000, maxFails: 3, blockMs: 60_000 });
    const now = 10_000;
    l.recordFail('1.2.3.4', now);
    l.recordFail('1.2.3.4', now + 100);
    l.recordFail('1.2.3.4', now + 200);
    expect(l.isBlocked('1.2.3.4', now + 300)).toBe(true);
  });

  it('lifts the block after blockMs elapses', () => {
    const l = new FailedAuthLimiter({ windowMs: 60_000, maxFails: 2, blockMs: 1_000 });
    const now = 10_000;
    l.recordFail('1.2.3.4', now);
    l.recordFail('1.2.3.4', now + 100);
    expect(l.isBlocked('1.2.3.4', now + 500)).toBe(true);
    expect(l.isBlocked('1.2.3.4', now + 1_500)).toBe(false);
  });

  it('drops failures older than the window before counting', () => {
    const l = new FailedAuthLimiter({ windowMs: 1_000, maxFails: 3, blockMs: 60_000 });
    const now = 10_000;
    l.recordFail('1.2.3.4', now);
    l.recordFail('1.2.3.4', now + 100);
    // First two age out before this third one arrives.
    l.recordFail('1.2.3.4', now + 2_000);
    expect(l.isBlocked('1.2.3.4', now + 2_100)).toBe(false);
  });

  it('isolates IPs from each other', () => {
    const l = new FailedAuthLimiter({ windowMs: 60_000, maxFails: 2, blockMs: 60_000 });
    l.recordFail('1.1.1.1');
    l.recordFail('1.1.1.1');
    expect(l.isBlocked('1.1.1.1')).toBe(true);
    expect(l.isBlocked('2.2.2.2')).toBe(false);
  });

  it('clears failures on success', () => {
    const l = new FailedAuthLimiter({ windowMs: 60_000, maxFails: 3, blockMs: 60_000 });
    l.recordFail('1.2.3.4');
    l.recordFail('1.2.3.4');
    l.recordSuccess('1.2.3.4');
    l.recordFail('1.2.3.4');
    l.recordFail('1.2.3.4');
    expect(l.isBlocked('1.2.3.4')).toBe(false);
  });
});
