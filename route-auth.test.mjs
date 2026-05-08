import { describe, it, expect, beforeEach } from 'vitest';
import { parseTokenPath, authoriseRequest } from './route-auth.js';
import { FailedAuthLimiter, tokensMatch } from './auth.js';

const TOKEN = 'kiwifx';

describe('parseTokenPath', () => {
  it('parses /<6-lower>/sub into { token, subPath }', () => {
    expect(parseTokenPath('/kiwifx/cover/abc123')).toEqual({
      token: 'kiwifx',
      subPath: '/cover/abc123',
    });
  });

  it('treats bare /<6-lower> as subPath /', () => {
    expect(parseTokenPath('/kiwifx')).toEqual({ token: 'kiwifx', subPath: '/' });
  });

  it('treats /<6-lower>/ as subPath /', () => {
    expect(parseTokenPath('/kiwifx/')).toEqual({ token: 'kiwifx', subPath: '/' });
  });

  it('rejects an empty path', () => {
    expect(parseTokenPath('/')).toBeNull();
  });

  it('rejects an uppercase or mixed-case token', () => {
    expect(parseTokenPath('/KIWIFX/foo')).toBeNull();
    expect(parseTokenPath('/Kiwifx/foo')).toBeNull();
  });

  it('rejects a too-short or too-long token', () => {
    expect(parseTokenPath('/abc/foo')).toBeNull();
    expect(parseTokenPath('/abcdefg/foo')).toBeNull();
  });

  it('rejects digits in the token', () => {
    expect(parseTokenPath('/abc1ef/foo')).toBeNull();
  });

  it('rejects a non-leading slash before the token', () => {
    expect(parseTokenPath('//kiwifx/foo')).toBeNull();
  });
});

describe('authoriseRequest', () => {
  let limiter;
  beforeEach(() => {
    limiter = new FailedAuthLimiter({ maxFails: 5, windowMs: 60_000, blockMs: 60_000 });
  });

  it('allows a well-formed request and reports the subPath', () => {
    const r = authoriseRequest({
      pathname: '/kiwifx/cover/abc123',
      ip: '127.0.0.1',
      expectedToken: TOKEN,
      limiter,
      tokensMatch,
    });
    expect(r).toEqual({ allow: true, subPath: '/cover/abc123', ip: '127.0.0.1' });
  });

  it('returns 404 (not 401) when the path has no token segment', () => {
    const r = authoriseRequest({
      pathname: '/just/a/random/url',
      ip: '127.0.0.1',
      expectedToken: TOKEN,
      limiter,
      tokensMatch,
    });
    expect(r).toEqual({ allow: false, status: 404, reason: 'no-token' });
  });

  it('returns 404 for a wrong token', () => {
    const r = authoriseRequest({
      pathname: '/wrongx/index.html',
      ip: '127.0.0.1',
      expectedToken: TOKEN,
      limiter,
      tokensMatch,
    });
    expect(r).toEqual({ allow: false, status: 404, reason: 'bad-token' });
  });

  it('records a failure for missing-token requests', () => {
    authoriseRequest({
      pathname: '/no-token',
      ip: '10.0.0.5',
      expectedToken: TOKEN,
      limiter,
      tokensMatch,
    });
    // 4 more failures pushes the IP to the threshold (maxFails: 5 → blocked on 5th).
    for (let i = 0; i < 4; i++) {
      authoriseRequest({
        pathname: '/no-token',
        ip: '10.0.0.5',
        expectedToken: TOKEN,
        limiter,
        tokensMatch,
      });
    }
    expect(limiter.isBlocked('10.0.0.5')).toBe(true);
  });

  it('clears the limiter on a successful request', () => {
    // 3 fails, then a success — limiter.isBlocked stays false and the
    // failure history clears so the next 5 fails restart the counter.
    for (let i = 0; i < 3; i++) {
      authoriseRequest({
        pathname: '/wrongx',
        ip: '10.0.0.6',
        expectedToken: TOKEN,
        limiter,
        tokensMatch,
      });
    }
    authoriseRequest({
      pathname: '/kiwifx/',
      ip: '10.0.0.6',
      expectedToken: TOKEN,
      limiter,
      tokensMatch,
    });
    expect(limiter.isBlocked('10.0.0.6')).toBe(false);
  });

  it('rejects (with a stealth 404) when the IP is already blocked', () => {
    const ip = '10.0.0.7';
    for (let i = 0; i < 5; i++) {
      limiter.recordFail(ip);
    }
    expect(limiter.isBlocked(ip)).toBe(true);
    const r = authoriseRequest({
      pathname: '/kiwifx/cover/abc123', // would otherwise be valid
      ip,
      expectedToken: TOKEN,
      limiter,
      tokensMatch,
    });
    expect(r).toEqual({ allow: false, status: 404, reason: 'rate-limited' });
  });

  it('isolates IPs from each other', () => {
    for (let i = 0; i < 5; i++) {
      authoriseRequest({
        pathname: '/wrongx',
        ip: '10.0.0.8',
        expectedToken: TOKEN,
        limiter,
        tokensMatch,
      });
    }
    expect(limiter.isBlocked('10.0.0.8')).toBe(true);
    expect(limiter.isBlocked('10.0.0.9')).toBe(false);
  });
});
