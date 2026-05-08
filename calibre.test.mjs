import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCalibreLibrary } from './out/integrations/calibre.js';

// better-sqlite3 is a CommonJS native module; bring it in through `require`
// so we don't fight ESM interop in the test runner.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Recreate the minimum subset of Calibre's schema that readCalibreLibrary
// touches. Keeping this test-local rather than copying a real metadata.db
// means we don't ship a binary fixture and we control every row precisely.
const SCHEMA = `
  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE TABLE authors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE books_authors_link (
    id INTEGER PRIMARY KEY,
    book INTEGER NOT NULL,
    author INTEGER NOT NULL
  );
  CREATE TABLE data (
    id INTEGER PRIMARY KEY,
    book INTEGER NOT NULL,
    format TEXT NOT NULL,
    name TEXT NOT NULL
  );
`;

function buildLibrary(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-calibre-'));
  const db = new Database(path.join(dir, 'metadata.db'));
  db.exec(SCHEMA);

  const insertBook = db.prepare('INSERT INTO books (id, title, path) VALUES (?, ?, ?)');
  const insertAuthor = db.prepare('INSERT INTO authors (id, name) VALUES (?, ?)');
  const insertLink = db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)');
  const insertData = db.prepare('INSERT INTO data (book, format, name) VALUES (?, ?, ?)');

  const seenAuthors = new Map();
  for (const row of rows) {
    insertBook.run(row.id, row.title, row.bookPath);
    if (row.author) {
      let aid = seenAuthors.get(row.author);
      if (!aid) {
        aid = seenAuthors.size + 1;
        insertAuthor.run(aid, row.author);
        seenAuthors.set(row.author, aid);
      }
      insertLink.run(row.id, aid);
    }
    for (const f of row.formats) {
      insertData.run(row.id, f.format, f.name);
    }
  }
  db.close();
  return dir;
}

describe('readCalibreLibrary', () => {
  let libDir;

  afterEach(() => {
    if (libDir) fs.rmSync(libDir, { recursive: true, force: true });
    libDir = null;
  });

  it('throws when metadata.db is missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'airshelf-calibre-empty-'));
    try {
      expect(() => readCalibreLibrary(empty)).toThrow(/No metadata\.db/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns one entry per book with the best available format', () => {
    libDir = buildLibrary([
      {
        id: 1,
        title: 'Dune',
        bookPath: 'Frank Herbert/Dune (1)',
        author: 'Frank Herbert',
        formats: [
          { format: 'EPUB', name: 'Dune' },
          { format: 'AZW3', name: 'Dune' },
          { format: 'MOBI', name: 'Dune' },
        ],
      },
      {
        id: 2,
        title: 'Snow Crash',
        bookPath: 'Neal Stephenson/Snow Crash (2)',
        author: 'Neal Stephenson',
        formats: [
          { format: 'EPUB', name: 'Snow Crash' },
          { format: 'MOBI', name: 'Snow Crash' },
        ],
      },
      {
        id: 3,
        title: 'Pragmatic Programmer',
        bookPath: 'Andy Hunt/Pragmatic Programmer (3)',
        author: 'Andy Hunt',
        formats: [{ format: 'EPUB', name: 'PragProg' }],
      },
    ]);

    const books = readCalibreLibrary(libDir);
    const byTitle = new Map(books.map((b) => [b.title, b]));

    expect(books).toHaveLength(3);
    // AZW3 wins over MOBI / EPUB.
    expect(byTitle.get('Dune').filePath).toBe(
      path.join(libDir, 'Frank Herbert/Dune (1)', 'Dune.azw3'),
    );
    // MOBI beats EPUB when no AZW3 is present.
    expect(byTitle.get('Snow Crash').filePath).toBe(
      path.join(libDir, 'Neal Stephenson/Snow Crash (2)', 'Snow Crash.mobi'),
    );
    // EPUB-only books are still imported.
    expect(byTitle.get('Pragmatic Programmer').filePath).toBe(
      path.join(libDir, 'Andy Hunt/Pragmatic Programmer (3)', 'PragProg.epub'),
    );
    expect(byTitle.get('Dune').author).toBe('Frank Herbert');
  });

  it('skips books that have no supported formats', () => {
    libDir = buildLibrary([
      {
        id: 1,
        title: 'PDF only',
        bookPath: 'Author/Book (1)',
        author: 'Author',
        formats: [{ format: 'PDF', name: 'Book' }],
      },
      {
        id: 2,
        title: 'EPUB importable',
        bookPath: 'Author/Other (2)',
        author: 'Author',
        formats: [{ format: 'EPUB', name: 'Other' }],
      },
    ]);

    const books = readCalibreLibrary(libDir);
    expect(books.map((b) => b.title)).toEqual(['EPUB importable']);
  });

  it('returns null author when the book has no linked author', () => {
    libDir = buildLibrary([
      {
        id: 1,
        title: 'Anon',
        bookPath: 'Unknown/Anon (1)',
        author: null,
        formats: [{ format: 'EPUB', name: 'Anon' }],
      },
    ]);

    const books = readCalibreLibrary(libDir);
    expect(books).toHaveLength(1);
    expect(books[0].author).toBeNull();
  });

  it('skips books whose resolved file path escapes the library root', () => {
    // Tampered metadata.db that points "outside" the picked library root.
    // None of these should appear in the import list.
    libDir = buildLibrary([
      {
        id: 1,
        title: 'Parent escape',
        bookPath: '../outside',
        author: 'Mallory',
        formats: [{ format: 'EPUB', name: 'evil' }],
      },
      {
        id: 2,
        title: 'Absolute path',
        bookPath: '/etc',
        author: 'Mallory',
        formats: [{ format: 'EPUB', name: 'passwd' }],
      },
      {
        id: 3,
        title: 'Inner escape via name',
        bookPath: 'Author/Book (3)',
        // 3 ../ segments out of a 2-deep bookPath escapes root.
        author: 'Mallory',
        formats: [{ format: 'EPUB', name: '../../../escaped' }],
      },
      {
        id: 4,
        title: 'Legit',
        bookPath: 'Author/Legit (4)',
        author: 'Author',
        formats: [{ format: 'EPUB', name: 'Legit' }],
      },
    ]);

    const books = readCalibreLibrary(libDir);
    expect(books.map((b) => b.title)).toEqual(['Legit']);
  });
});
