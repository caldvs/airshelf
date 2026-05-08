import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DOWNLOAD_PATH_RE, sanitiseBaseName, prepareDownloadResponse } from './route-download.js';

describe('DOWNLOAD_PATH_RE', () => {
  it('matches /download/<hex>', () => {
    expect(DOWNLOAD_PATH_RE.test('/download/abc123')).toBe(true);
  });

  it('matches /download/<hex>.<ext> (legacy form)', () => {
    expect(DOWNLOAD_PATH_RE.test('/download/abc123.azw3')).toBe(true);
  });

  it('rejects non-hex ids', () => {
    expect(DOWNLOAD_PATH_RE.test('/download/abc-123')).toBe(false);
    expect(DOWNLOAD_PATH_RE.test('/download/abc_123')).toBe(false);
  });

  it('rejects subdirectories', () => {
    expect(DOWNLOAD_PATH_RE.test('/download/abc123/extra')).toBe(false);
  });
});

describe('sanitiseBaseName', () => {
  it('keeps alphanumerics, dot, underscore, space, dash', () => {
    expect(sanitiseBaseName('Foo Bar.1-2_3')).toBe('Foo Bar.1-2_3');
  });

  it('replaces unsafe characters with _', () => {
    expect(sanitiseBaseName('Foo/Bar?Baz')).toBe('Foo_Bar_Baz');
    expect(sanitiseBaseName('A&B C:D')).toBe('A_B C_D');
  });

  it('caps at 80 characters', () => {
    const long = 'a'.repeat(200);
    expect(sanitiseBaseName(long)).toHaveLength(80);
  });

  it('falls back to "book" for missing/empty title', () => {
    expect(sanitiseBaseName(undefined)).toBe('book');
    expect(sanitiseBaseName(null)).toBe('book');
    expect(sanitiseBaseName('')).toBe('book');
  });
});

describe('prepareDownloadResponse', () => {
  const books = [
    { id: 'abc123', title: 'My Book', file: 'abc123.azw3', ext: 'azw3' },
    { id: 'def456', title: 'Path/Trick: A "Story"', file: 'def456.azw3', ext: 'azw3' },
  ];

  it('returns null for a non-matching subPath', () => {
    expect(
      prepareDownloadResponse({ subPath: '/cover/abc123', books, booksDir: '/tmp' }),
    ).toBeNull();
  });

  it('404s on an unknown book id', () => {
    const r = prepareDownloadResponse({
      subPath: '/download/0badf00d',
      books,
      booksDir: '/tmp',
    });
    expect(r).toEqual({ status: 404, body: 'Not found' });
  });

  it('returns 200 with octet-stream and the on-disk filePath', () => {
    const r = prepareDownloadResponse({
      subPath: '/download/abc123',
      books,
      booksDir: '/lib',
    });
    expect(r.status).toBe(200);
    expect(r.filePath).toBe(path.join('/lib', 'abc123.azw3'));
    expect(r.headers['Content-Type']).toBe('application/octet-stream');
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="My Book.azw3"');
  });

  it('sanitises filename characters that would break Content-Disposition', () => {
    const r = prepareDownloadResponse({
      subPath: '/download/def456',
      books,
      booksDir: '/lib',
    });
    expect(r.headers['Content-Disposition']).toBe(
      'attachment; filename="Path_Trick_ A _Story_.azw3"',
    );
  });

  it('lowercases the URL id before lookup (route regex is case-insensitive)', () => {
    const r = prepareDownloadResponse({
      subPath: '/download/ABC123',
      books,
      booksDir: '/lib',
    });
    expect(r.status).toBe(200);
    expect(r.filePath).toBe(path.join('/lib', 'abc123.azw3'));
  });

  it('accepts the legacy /download/<id>.<ext> form and ignores the extension', () => {
    const r = prepareDownloadResponse({
      subPath: '/download/abc123.zip',
      books,
      booksDir: '/lib',
    });
    expect(r.status).toBe(200);
    expect(r.filePath).toBe(path.join('/lib', 'abc123.azw3'));
  });
});
