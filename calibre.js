const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Formats Airshelf is willing to import. Calibre may have many other formats
// per book (PDF, ODT, original EPUB pre-conversion, etc.); we pick the one
// closest to what Kindle wants. AZW3 is Kindle-native, MOBI converts cleanly,
// EPUB goes through Calibre conversion in addBook. Any format outside this
// list is ignored — addBook can handle some others, but importing the entire
// long tail tends to surface odd failures (DRM'd PDFs, scanned books, etc.).
const FORMAT_PRIORITY = ['AZW3', 'MOBI', 'EPUB'];

// Read a Calibre library at `libraryRoot` and return the absolute paths of
// every supported ebook, one per book (best format per book by FORMAT_PRIORITY).
//
// Calibre stores files under <libraryRoot>/<book.path>/<data.name>.<format>.
// `book.path` is the per-book subdirectory ("Author Name/Book Title (id)"),
// `data.name` is the basename (without extension), and `data.format` is the
// uppercase format code (AZW3, MOBI, EPUB, …).
//
// Returns: [{ title, author, filePath }]. Author is the first linked author
// (Calibre allows multiple) or null. Caller is expected to feed `filePath`
// values to addBook — title/author are returned for progress UI only;
// addBook re-derives them from file metadata so the import inherits the
// same enrichment + dedup as a manual drag-drop.
function readCalibreLibrary(libraryRoot) {
  const dbPath = path.join(libraryRoot, 'metadata.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No metadata.db at ${dbPath} — pick a Calibre library root.`);
  }
  // Resolve once so we can do containment checks on every assembled file
  // path. A tampered metadata.db could put `..` segments or absolute paths
  // in `books.path` / `data.name`; we MUST NOT import files outside the
  // library root the user picked.
  const root = path.resolve(libraryRoot);
  // readonly + fileMustExist: never write back, never auto-create.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Authors come from a correlated subquery rather than a JOIN so we
    // produce exactly one row per (book, format), not one per co-author.
    // The subquery's `ORDER BY bal.id ASC` makes the picked author
    // deterministic — Calibre inserts in primary-author-first order, so
    // this gives us the same author every run regardless of SQL plan.
    const rows = db
      .prepare(
        `
      SELECT
        b.id     AS bookId,
        b.title  AS title,
        b.path   AS bookPath,
        d.format AS format,
        d.name   AS dataName,
        (
          SELECT a.name
          FROM authors a
          JOIN books_authors_link bal ON bal.author = a.id
          WHERE bal.book = b.id
          ORDER BY bal.id ASC
          LIMIT 1
        ) AS author
      FROM books b
      JOIN data d ON d.book = b.id
      WHERE d.format IN ('AZW3', 'MOBI', 'EPUB')
      ORDER BY b.id ASC
    `,
      )
      .all();

    // Pick the best format per book.
    const byBook = new Map();
    for (const row of rows) {
      const priority = FORMAT_PRIORITY.indexOf(row.format);
      if (priority < 0) continue;
      const existing = byBook.get(row.bookId);
      const existingPriority = existing ? FORMAT_PRIORITY.indexOf(existing.format) : Infinity;
      if (!existing || priority < existingPriority) {
        byBook.set(row.bookId, row);
      }
    }

    const out = [];
    for (const row of byBook.values()) {
      const filePath = path.resolve(
        root,
        row.bookPath,
        `${row.dataName}.${row.format.toLowerCase()}`,
      );
      // Containment check. `path.resolve` normalises out `..` segments and
      // honours absolute components, so a malicious row like `bookPath: "../etc"`
      // or `dataName: "/etc/passwd"` would resolve outside `root` here. Skip
      // anything that doesn't sit strictly under the picked library root.
      if (filePath !== root && !filePath.startsWith(root + path.sep)) continue;
      out.push({
        title: row.title || path.basename(row.bookPath),
        author: row.author || null,
        filePath,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

module.exports = { readCalibreLibrary, FORMAT_PRIORITY };
