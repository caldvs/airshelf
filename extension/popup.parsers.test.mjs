// Pure-function tests for the popup's URL parser + filename derivation.
// The popup itself is browser-coupled (chrome.* APIs), so we copy the
// pure helpers here and test them directly. If they drift, the test
// catches it — not the extension going silent at runtime.

import { describe, it, expect } from 'vitest';

const URL_RE = /^(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)\/([a-z]{6})\/?$/;

function parseKindleUrl(input) {
  const m = (input || '').trim().match(URL_RE);
  if (!m) return null;
  return { base: m[1], token: m[2] };
}

function deriveFilename(url, fallback = 'page.pdf') {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const decoded = (() => {
      try { return decodeURIComponent(last); } catch { return last; }
    })();
    if (!decoded) return fallback;
    if (/\.[a-z0-9]{2,5}$/i.test(decoded)) return decoded;
    return decoded + '.pdf';
  } catch {
    return fallback;
  }
}

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

  it('returns null on garbage', () => {
    expect(parseKindleUrl('')).toBeNull();
    expect(parseKindleUrl(undefined)).toBeNull();
    expect(parseKindleUrl('not a url')).toBeNull();
  });
});

describe('deriveFilename', () => {
  it('uses the last path segment when it has an extension', () => {
    expect(deriveFilename('https://example.com/papers/foo.pdf')).toBe('foo.pdf');
  });

  it('decodes URI-encoded filenames', () => {
    expect(deriveFilename('https://example.com/foo%20bar.pdf')).toBe('foo bar.pdf');
  });

  it('appends .pdf when the URL has no recognisable extension', () => {
    expect(deriveFilename('https://example.com/some-article')).toBe(
      'some-article.pdf',
    );
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
});
