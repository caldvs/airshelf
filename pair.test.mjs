import { describe, it, expect } from 'vitest';
import {
  PAIR_ALPHABET,
  PAIR_CODE_LEN,
  PAIR_CODE_RE,
  generatePairCode,
  PairCodeStore,
} from './pair.js';

describe('generatePairCode', () => {
  it('produces a code of the expected length and alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairCode();
      expect(code).toHaveLength(PAIR_CODE_LEN);
      expect(PAIR_CODE_RE.test(code)).toBe(true);
    }
  });

  it('uses only the unambiguous alphabet (no 0/O, 1/I/L, B, S, G…)', () => {
    const banned = '01OIL2Z5S8B6GU';
    for (let i = 0; i < 50; i++) {
      const code = generatePairCode();
      for (const ch of code) expect(banned.includes(ch)).toBe(false);
    }
  });
});

describe('PairCodeStore', () => {
  function fakeClock(start = 1_000_000) {
    let t = start;
    return {
      now: () => t,
      advance(ms) { t += ms; },
    };
  }

  it('issue() returns a valid code and peek() reflects it', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    const code = s.issue();
    expect(PAIR_CODE_RE.test(code)).toBe(true);
    const peeked = s.peek();
    expect(peeked.code).toBe(code);
    expect(peeked.expiresAt).toBe(clock.now() + 60_000);
  });

  it('issue() rotates — only the most recent code is valid', () => {
    const clock = fakeClock();
    // Inject a deterministic generator so the "two issued codes differ"
    // assertion can never flake on the (1 / 22^4) random collision case.
    // All chars must be in PAIR_ALPHABET — 'ABCD' would fail because B is
    // intentionally banned (looks like 8) and same for G in EFGH. Picking
    // codes from the unambiguous set keeps the regex check happy.
    const queue = ['ACDE', 'FHJK'];
    const s = new PairCodeStore({
      ttlMs: 60_000,
      now: clock.now,
      generator: () => queue.shift(),
    });
    const a = s.issue();
    const b = s.issue();
    expect(a).toBe('ACDE');
    expect(b).toBe('FHJK');
    expect(s.consume(a)).toBe(false);
    expect(s.consume(b)).toBe(true);
  });

  it('consume() is single-use', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    const code = s.issue();
    expect(s.consume(code)).toBe(true);
    expect(s.consume(code)).toBe(false);
  });

  it('consume() is case-insensitive on input', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    const code = s.issue();
    expect(s.consume(code.toLowerCase())).toBe(true);
  });

  it('consume() rejects after expiry', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    const code = s.issue();
    clock.advance(60_001);
    expect(s.consume(code)).toBe(false);
    expect(s.peek()).toBeNull();
  });

  it('peek() returns null when no code has been issued', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    expect(s.peek()).toBeNull();
  });

  it('issue() normalizes lowercase generator output to uppercase', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({
      ttlMs: 60_000,
      now: clock.now,
      generator: () => 'acde', // lowercase, would be unconsumable without normalisation
    });
    const code = s.issue();
    expect(code).toBe('ACDE');
    expect(s.consume('acde')).toBe(true); // case-insensitive consume still works
  });

  it('issue() throws on a generator that returns garbage', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({
      ttlMs: 60_000,
      now: clock.now,
      generator: () => '0OIL', // banned characters
    });
    expect(() => s.issue()).toThrow(/invalid code/);
  });

  it('issue() leaves the previous code intact if the new generator throws', () => {
    const clock = fakeClock();
    const codes = ['ACDE', '0OIL']; // first valid, second garbage
    const s = new PairCodeStore({
      ttlMs: 60_000,
      now: clock.now,
      generator: () => codes.shift(),
    });
    s.issue();
    expect(() => s.issue()).toThrow(/invalid code/);
    // Previous code should still be active and consumable.
    expect(s.consume('ACDE')).toBe(true);
  });

  it('consume() rejects long inputs without uppercasing them (DoS guard)', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    s.issue();
    // 1MB of "a" — a naive upper().test() would allocate O(N).
    const giant = 'a'.repeat(1_000_000);
    expect(s.consume(giant)).toBe(false);
  });

  it('consume() rejects malformed input without throwing', () => {
    const clock = fakeClock();
    const s = new PairCodeStore({ ttlMs: 60_000, now: clock.now });
    s.issue();
    expect(s.consume(null)).toBe(false);
    expect(s.consume('')).toBe(false);
    expect(s.consume('AB')).toBe(false);             // wrong length
    expect(s.consume('AB0X')).toBe(false);           // banned char
    expect(s.consume('abcdef')).toBe(false);         // not in alphabet (lowercase ok but length+chars must match)
    expect(s.consume(1234)).toBe(false);
  });
});
