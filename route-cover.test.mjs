import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleCoverRequest, sniffImageType } from './out/server/routes/cover.js';

// Tiny image fixtures by magic bytes — the route only needs to sniff the
// header. Padding with junk so each is more than two bytes.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

let booksDir;
beforeEach(() => {
  booksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-cover-'));
});
afterEach(() => {
  fs.rmSync(booksDir, { recursive: true, force: true });
});

function writeCover(id, bytes) {
  const name = `${id}.cover`;
  fs.writeFileSync(path.join(booksDir, name), bytes);
  return name;
}

describe('sniffImageType', () => {
  it('detects PNG by magic bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
  });

  it('detects GIF by magic bytes', () => {
    expect(sniffImageType(GIF)).toBe('image/gif');
  });

  it('falls back to JPEG for anything else', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from([0x00, 0x00]))).toBe('image/jpeg');
  });
});

describe('handleCoverRequest', () => {
  it('returns null when subPath does not match the route', () => {
    expect(handleCoverRequest({ subPath: '/index.html', books: [], booksDir })).toBeNull();
  });

  it('404s when the book is unknown', () => {
    const r = handleCoverRequest({ subPath: '/cover/abc123', books: [], booksDir });
    expect(r).toEqual({ status: 404, body: 'No cover' });
  });

  it('404s when the book has no cover field', () => {
    const r = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', title: 't' }],
      booksDir,
    });
    expect(r).toEqual({ status: 404, body: 'No cover' });
  });

  it('404s when the cover file is missing on disk', () => {
    const r = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', title: 't', cover: 'abc123.cover' }],
      booksDir, // empty tmpdir
    });
    expect(r).toEqual({ status: 404, body: 'Missing' });
  });

  it('serves a JPEG with the right content-type and immutable cache header', () => {
    const cover = writeCover('abc123', JPEG);
    const r = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
    });
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('image/jpeg');
    expect(r.headers['Content-Length']).toBe(JPEG.length);
    expect(r.headers['Cache-Control']).toContain('immutable');
    expect(r.headers.ETag).toMatch(/^"abc123-\d+-\d+"$/);
    // Caller streams from filePath; assert it points at the right cover.
    expect(fs.readFileSync(r.filePath).equals(JPEG)).toBe(true);
  });

  it('detects PNG and GIF magic bytes', () => {
    const cp = writeCover('aa11', PNG);
    expect(
      handleCoverRequest({
        subPath: '/cover/aa11',
        books: [{ id: 'aa11', cover: cp }],
        booksDir,
      }).headers['Content-Type'],
    ).toBe('image/png');

    const cg = writeCover('bb22', GIF);
    expect(
      handleCoverRequest({
        subPath: '/cover/bb22',
        books: [{ id: 'bb22', cover: cg }],
        booksDir,
      }).headers['Content-Type'],
    ).toBe('image/gif');
  });

  it('returns 304 when If-None-Match matches the etag', () => {
    const cover = writeCover('abc123', JPEG);
    const fresh = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
    });
    const cached = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
      ifNoneMatch: fresh.headers.ETag,
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.ETag).toBe(fresh.headers.ETag);
    expect(cached.body).toBeUndefined();
  });

  it('returns 304 when If-None-Match is a comma-separated list including the etag', () => {
    const cover = writeCover('abc123', JPEG);
    const fresh = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
    });
    // Browser sends `"a", "b", "<our-etag>"` — RFC 7232 allows.
    const cached = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
      ifNoneMatch: `"stale1", "stale2", ${fresh.headers.ETag}`,
    });
    expect(cached.status).toBe(304);
  });

  it('returns 304 when If-None-Match is the * wildcard', () => {
    const cover = writeCover('abc123', JPEG);
    const cached = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
      ifNoneMatch: '*',
    });
    expect(cached.status).toBe(304);
  });

  it('strips W/ weak prefix when matching If-None-Match', () => {
    const cover = writeCover('abc123', JPEG);
    const fresh = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
    });
    const cached = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
      ifNoneMatch: `W/${fresh.headers.ETag}`,
    });
    expect(cached.status).toBe(304);
  });

  it('returns 304 when If-Modified-Since matches', () => {
    const cover = writeCover('abc123', JPEG);
    const fresh = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
    });
    const cached = handleCoverRequest({
      subPath: '/cover/abc123',
      books: [{ id: 'abc123', cover }],
      booksDir,
      ifModifiedSince: fresh.headers['Last-Modified'],
    });
    expect(cached.status).toBe(304);
  });

  it('rejects bookIds with non-hex characters via the route regex', () => {
    expect(handleCoverRequest({ subPath: '/cover/abc-123', books: [], booksDir })).toBeNull();
    expect(handleCoverRequest({ subPath: '/cover/AbC123', books: [], booksDir })).toBeNull();
  });
});
