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
  // readonly + fileMustExist: never write back, never auto-create.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Single query joins books → data → authors so we don't N+1. The schema
    // has been stable for years, but we still wrap in try/catch on the
    // outer caller side — a Calibre upgrade could rename a column.
    const rows = db.prepare(`
      SELECT
        b.id        AS bookId,
        b.title     AS title,
        b.path      AS bookPath,
        d.format    AS format,
        d.name      AS dataName,
        a.name      AS author
      FROM books b
      JOIN data d ON d.book = b.id
      LEFT JOIN books_authors_link bal ON bal.book = b.id
      LEFT JOIN authors a ON a.id = bal.author
      WHERE d.format IN ('AZW3', 'MOBI', 'EPUB')
    `).all();

    // Pick the best format per book. Calibre's books_authors_link can produce
    // multiple rows per (book, format) when there are co-authors; we keep
    // the first author seen and ignore later duplicates.
    const byBook = new Map();
    for (const row of rows) {
      const existing = byBook.get(row.bookId);
      const priority = FORMAT_PRIORITY.indexOf(row.format);
      if (priority < 0) continue;
      if (existing && row.bookId === existing.bookId && existing.author && !row.author) {
        // Same book, additional row without author info — keep existing.
        continue;
      }
      const existingPriority = existing ? FORMAT_PRIORITY.indexOf(existing.format) : Infinity;
      if (!existing || priority < existingPriority) {
        byBook.set(row.bookId, row);
      }
    }

    const out = [];
    for (const row of byBook.values()) {
      const filePath = path.join(
        libraryRoot,
        row.bookPath,
        `${row.dataName}.${row.format.toLowerCase()}`,
      );
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
