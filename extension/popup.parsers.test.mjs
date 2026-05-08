// Pure-function tests for the popup's URL parser + filename derivation.
// Imports from the shared parsers module so popup.js and the test stay
// in lockstep — addressing the duplication noted in #73's review.

import { describe, it, expect } from 'vitest';
import { parseKindleUrl, deriveFilename, errorMessage } from './parsers.js';

describe('parseKindleUrl', () => {
  it('parses http://127.0.0.1:6790/<token>/', () => {
    expect(parseKindleUrl('http://127.0.0.1:6790/abcdef/')).toEqual({
      base: 'http://127.0.0.1:6790',
      token: 'abcdef',
    });
  });

  it('parses without a trailing slash', () => {
    expect(parseKindleUrl('http://127.0.0.1:6790/abcdef')).toEqual({
      base: 'http://127.0.0.1:6790',
      token: 'abcdef',
    });
  });

  it('accepts localhost as well as 127.0.0.1', () => {
    const r = parseKindleUrl('http://localhost:6790/abcdef/');
    expect(r.base).toBe('http://localhost:6790');
  });

  it('trims surrounding whitespace', () => {
    expect(parseKindleUrl('  http://127.0.0.1:6790/abcdef/ ')).toEqual({
      base: 'http://127.0.0.1:6790',
      token: 'abcdef',
    });
  });

  it('rejects an uppercase or wrong-length token', () => {
    expect(parseKindleUrl('http://127.0.0.1:6790/ABCDEF/')).toBeNull();
    expect(parseKindleUrl('http://127.0.0.1:6790/abc/')).toBeNull();
    expect(parseKindleUrl('http://127.0.0.1:6790/abcdefg/')).toBeNull();
  });

  it('rejects non-loopback hosts (would defeat the loopback-only /upload)', () => {
    expect(parseKindleUrl('http://192.168.1.5:6790/abcdef/')).toBeNull();
    expect(parseKindleUrl('http://example.com/abcdef/')).toBeNull();
  });

  it('rejects https:// (host_permissions are http only)', () => {
    expect(parseKindleUrl('https://127.0.0.1:6790/abcdef/')).toBeNull();
  });

  it('rejects non-6790 ports (host_permissions pin to 6790)', () => {
    expect(parseKindleUrl('http://127.0.0.1:8080/abcdef/')).toBeNull();
  });

  it('returns null on garbage', () => {
    expect(parseKindleUrl('')).toBeNull();
    expect(parseKindleUrl(undefined)).toBeNull();
    expect(parseKindleUrl('not a url')).toBeNull();
  });
});

describe('deriveFilename', () => {
  it('uses the last path segment when it has an allowed extension', () => {
    expect(deriveFilename('https://example.com/papers/foo.pdf')).toBe('foo.pdf');
  });

  it('decodes URI-encoded filenames', () => {
    expect(deriveFilename('https://example.com/foo%20bar.pdf')).toBe('foo bar.pdf');
  });

  it('appends .pdf when the URL has no recognisable extension', () => {
    expect(deriveFilename('https://example.com/some-article')).toBe('some-article.pdf');
  });

  it('appends .pdf when the URL extension is not in the ebook allowlist', () => {
    expect(deriveFilename('https://example.com/page.html')).toBe('page.html.pdf');
  });

  it('falls back when the URL has no path', () => {
    expect(deriveFilename('https://example.com/')).toBe('page.pdf');
  });

  it('falls back on a malformed URL', () => {
    expect(deriveFilename('not a url')).toBe('page.pdf');
  });

  it('preserves a known ebook extension (.epub) without doubling it', () => {
    expect(deriveFilename('https://example.com/book.epub')).toBe('book.epub');
  });

  it('replaces path separators in a decoded filename (%2F → _)', () => {
    expect(deriveFilename('https://example.com/foo%2Fbar.pdf')).toBe('foo_bar.pdf');
  });

  it('replaces NUL bytes in a decoded filename (%00 → _)', () => {
    expect(deriveFilename('https://example.com/foo%00.pdf')).toBe('foo_.pdf');
  });

  it('caps very long filenames so the X-Filename header stays sane', () => {
    const url = 'https://example.com/' + 'x'.repeat(500) + '.pdf';
    expect(deriveFilename(url).length).toBeLessThanOrEqual(204); // 200 + .pdf
  });
});

describe('errorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the string itself for thrown strings', () => {
    expect(errorMessage('nope')).toBe('nope');
  });

  it('serialises arbitrary objects', () => {
    expect(errorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it('falls back to String() for non-serialisable values', () => {
    const circ = {};
    circ.self = circ;
    expect(typeof errorMessage(circ)).toBe('string');
  });
});
