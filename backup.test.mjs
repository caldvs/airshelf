import { describe, it, expect } from 'vitest';
import { MANIFEST_VERSION, buildManifest, validateBackup } from './out/domain/backup.js';

const safeBook = {
  id: 'abc123',
  title: 'Test',
  file: 'abc123.azw3',
  originalFile: 'abc123.epub',
  cover: 'abc123.cover',
};

const okManifest = {
  version: MANIFEST_VERSION,
  app: 'airshelf',
  createdAt: '2026-05-07T00:00:00.000Z',
  bookCount: 1,
};

describe('buildManifest', () => {
  it('stamps version + app + bookCount', () => {
    const m = buildManifest({ bookCount: 3 });
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.app).toBe('airshelf');
    expect(m.bookCount).toBe(3);
    expect(typeof m.createdAt).toBe('string');
  });

  it('accepts an explicit createdAt', () => {
    const m = buildManifest({ bookCount: 0, createdAt: '2030-01-01T00:00:00Z' });
    expect(m.createdAt).toBe('2030-01-01T00:00:00Z');
  });
});

describe('validateBackup', () => {
  it('accepts a well-formed backup', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [safeBook] },
      fileNames: ['abc123.azw3', 'abc123.epub', 'abc123.cover'],
    });
    expect(r).toEqual({ ok: true });
  });

  it('rejects when manifest is missing', () => {
    const r = validateBackup({ manifest: null, meta: { books: [] }, fileNames: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no manifest/i);
  });

  it('rejects when manifest.app is wrong', () => {
    const r = validateBackup({
      manifest: { ...okManifest, app: 'something-else' },
      meta: { books: [] },
      fileNames: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Not an Airshelf backup/);
  });

  it('rejects future versions', () => {
    const r = validateBackup({
      manifest: { ...okManifest, version: MANIFEST_VERSION + 1 },
      meta: { books: [] },
      fileNames: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/newer than this app supports/);
  });

  it('rejects manifest with non-numeric version', () => {
    const r = validateBackup({
      manifest: { ...okManifest, version: 'one' },
      meta: { books: [] },
      fileNames: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing version/);
  });

  it('rejects malformed books.json', () => {
    const r = validateBackup({ manifest: okManifest, meta: { books: 'nope' }, fileNames: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed/);
  });

  it('rejects path traversal in book.file', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [{ ...safeBook, file: '../../etc/passwd' }] },
      fileNames: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsafe entry/);
  });

  it('rejects path traversal in originalFile / cover', () => {
    const r1 = validateBackup({
      manifest: okManifest,
      meta: { books: [{ ...safeBook, originalFile: 'a/b' }] },
      fileNames: ['abc123.azw3', 'abc123.cover'],
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/unsafe entry/);
    const r2 = validateBackup({
      manifest: okManifest,
      meta: { books: [{ ...safeBook, cover: '..' }] },
      fileNames: ['abc123.azw3', 'abc123.epub'],
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/unsafe entry/);
  });

  it('allows null originalFile / cover', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [{ id: 'x', title: 't', file: 'x.azw3', originalFile: null, cover: null }] },
      fileNames: ['x.azw3'],
    });
    expect(r).toEqual({ ok: true });
  });

  it('rejects nested paths under books/', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [safeBook] },
      fileNames: ['../etc/passwd'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsafe path/);
  });

  it('rejects subdirectory entries under books/', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [safeBook] },
      fileNames: ['nested/abc.azw3'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsafe path/);
  });

  it('rejects when book.file is referenced but missing from fileNames', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [{ id: 'x', title: 't', file: 'missing.azw3' }] },
      fileNames: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing referenced file/i);
  });

  it('rejects when originalFile is referenced but missing from fileNames', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [{ ...safeBook, cover: null, originalFile: 'orig.epub' }] },
      fileNames: ['abc123.azw3'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing referenced originalFile/i);
  });

  it('rejects when cover is referenced but missing from fileNames', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [{ ...safeBook, originalFile: null, cover: 'cov.cover' }] },
      fileNames: ['abc123.azw3'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing referenced cover/i);
  });

  it('rejects case-insensitive duplicates under books/', () => {
    const r = validateBackup({
      manifest: okManifest,
      meta: { books: [{ ...safeBook, originalFile: null, cover: null }] },
      fileNames: ['abc123.azw3', 'ABC123.azw3'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/case-insensitive duplicate/i);
  });
});
