import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleEpubRequest, EPUB_PATH_RE } from './route-epub.js';

let dir;
let epubPath;

const BOOK = { id: 'abc123', title: 'Test', file: 'abc123.azw3' };
// 4 KiB of bytes. Enough to exercise range slicing without being slow.
const BYTES = Buffer.alloc(4096);
for (let i = 0; i < BYTES.length; i++) BYTES[i] = i & 0xff;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-epub-'));
  epubPath = path.join(dir, 'abc123.epub');
  fs.writeFileSync(epubPath, BYTES);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const okGet = () => Promise.resolve(epubPath);

describe('EPUB_PATH_RE', () => {
  it('matches /epub/<hex-id>', () => {
    expect(EPUB_PATH_RE.exec('/epub/abc123')[1]).toBe('abc123');
  });
  it('rejects non-hex ids', () => {
    expect(EPUB_PATH_RE.exec('/epub/zzz')).toBeNull();
  });
  it('rejects nested paths', () => {
    expect(EPUB_PATH_RE.exec('/epub/abc123/foo')).toBeNull();
  });
});

describe('handleEpubRequest', () => {
  it('returns null when subPath does not match', async () => {
    const r = await handleEpubRequest({
      subPath: '/cover/abc123', books: [BOOK], getReaderEpubPath: okGet,
    });
    expect(r).toBeNull();
  });

  it('404s with CORS when the book id is unknown', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/deadbeef', books: [BOOK], getReaderEpubPath: okGet,
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatch(/not found/i);
    // The reader iframe (Origin: null) can't read the body without CORS,
    // so error responses on this route consistently set Allow-Origin.
    expect(r.headers['Access-Control-Allow-Origin']).toBe('null');
  });

  it('500s with CORS when getReaderEpubPath rejects', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK],
      getReaderEpubPath: () => Promise.reject(new Error('calibre missing')),
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatch(/calibre missing/);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('null');
  });

  it('404s with CORS when the epub path is missing on disk', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK],
      getReaderEpubPath: () => Promise.resolve(path.join(dir, 'gone.epub')),
    });
    expect(r.status).toBe(404);
    expect(r.body).toBe('Missing');
    expect(r.headers['Access-Control-Allow-Origin']).toBe('null');
  });

  it('404s with CORS when getReaderEpubPath returns null', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK],
      getReaderEpubPath: () => Promise.resolve(null),
    });
    expect(r.status).toBe(404);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('null');
  });

  it('200s with full-file headers when no Range header is sent', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK], getReaderEpubPath: okGet,
    });
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/epub+zip');
    expect(r.headers['Accept-Ranges']).toBe('bytes');
    expect(r.headers['Content-Length']).toBe(BYTES.length);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('null');
    expect(r.stream).toEqual({ path: epubPath });
  });

  it('206s with the requested range when Range is valid', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK], getReaderEpubPath: okGet,
      rangeHeader: 'bytes=0-1023',
    });
    expect(r.status).toBe(206);
    expect(r.headers['Content-Range']).toBe(`bytes 0-1023/${BYTES.length}`);
    expect(r.headers['Content-Length']).toBe(1024);
    expect(r.stream).toEqual({ path: epubPath, start: 0, end: 1023 });
  });

  it('416s when Range is outside the file size', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK], getReaderEpubPath: okGet,
      rangeHeader: `bytes=${BYTES.length + 100}-`,
    });
    expect(r.status).toBe(416);
    expect(r.headers['Content-Range']).toBe(`bytes */${BYTES.length}`);
    expect(r.stream).toBeUndefined();
  });

  it('falls back to full file when Range header is malformed', async () => {
    const r = await handleEpubRequest({
      subPath: '/epub/abc123', books: [BOOK], getReaderEpubPath: okGet,
      rangeHeader: 'bytes=garbage',
    });
    // parseRangeHeader returns null for malformed input → handler returns
    // a 200 full-file response.
    expect(r.status).toBe(200);
    expect(r.stream).toEqual({ path: epubPath });
  });
});
