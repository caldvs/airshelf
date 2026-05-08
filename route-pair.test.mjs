import { describe, it, expect } from 'vitest';
import {
  parsePairPath,
  buildPairCookie,
  handlePairRequest,
} from './route-pair.js';

describe('PAIR_PATH_RE / parsePairPath', () => {
  it('matches /pair/<code>', () => {
    expect(parsePairPath('/pair/ABCD')).toEqual({ code: 'ABCD' });
  });

  it('matches with a trailing slash', () => {
    expect(parsePairPath('/pair/ABCD/')).toEqual({ code: 'ABCD' });
  });

  it('rejects nested paths', () => {
    expect(parsePairPath('/pair/ABCD/extra')).toBeNull();
    expect(parsePairPath('/pair/')).toBeNull();
    expect(parsePairPath('/pair')).toBeNull();
  });

  it('rejects non-pair paths', () => {
    expect(parsePairPath('/abcdef/')).toBeNull();
    expect(parsePairPath('/')).toBeNull();
    expect(parsePairPath('')).toBeNull();
  });

  it('captures the raw code without lower/uppercasing', () => {
    // Normalisation is the store's job (see pair.js consume()); the route
    // just hands the raw segment over.
    expect(parsePairPath('/pair/abcd').code).toBe('abcd');
    expect(parsePairPath('/pair/AbCd').code).toBe('AbCd');
  });
});

describe('buildPairCookie', () => {
  it('contains the token, HttpOnly, SameSite=Lax, Path=/, and a year-long Max-Age', () => {
    const c = buildPairCookie('badera');
    expect(c).toMatch(/^airshelf_token=badera/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\//);
    // 31_536_000 = seconds in 365 days.
    expect(c).toMatch(/Max-Age=31536000/);
  });
});

function makeStore({ consumeReturns = false } = {}) {
  const calls = [];
  return {
    consume(code) {
      calls.push(code);
      return consumeReturns;
    },
    calls,
  };
}

describe('handlePairRequest', () => {
  it('returns null for non-pair paths', () => {
    const store = makeStore();
    expect(handlePairRequest({
      pathname: '/abcdef/',
      pairStore: store,
      serverToken: 'badera',
    })).toBeNull();
    // Should not have probed the store.
    expect(store.calls).toEqual([]);
  });

  it('on bad code: returns ok:false with 404, AFTER consuming', () => {
    const store = makeStore({ consumeReturns: false });
    const r = handlePairRequest({
      pathname: '/pair/9999',
      pairStore: store,
      serverToken: 'badera',
    });
    expect(r).toEqual({ match: true, ok: false, status: 404 });
    expect(store.calls).toEqual(['9999']);
  });

  it('on valid code: returns ok:true with redirect target + Set-Cookie', () => {
    const store = makeStore({ consumeReturns: true });
    const r = handlePairRequest({
      pathname: '/pair/ACDE',
      pairStore: store,
      serverToken: 'badera',
    });
    expect(r.match).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.location).toBe('/badera/');
    expect(r.setCookie).toBe(buildPairCookie('badera'));
    expect(store.calls).toEqual(['ACDE']);
  });

  it('treats trailing-slash and bare forms identically', () => {
    const store = makeStore({ consumeReturns: true });
    const a = handlePairRequest({
      pathname: '/pair/ACDE',
      pairStore: makeStore({ consumeReturns: true }),
      serverToken: 'badera',
    });
    const b = handlePairRequest({
      pathname: '/pair/ACDE/',
      pairStore: store,
      serverToken: 'badera',
    });
    expect(a).toEqual(b);
  });
});
