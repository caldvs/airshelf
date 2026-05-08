// Goodreads "to-read" CSV import (#40, slice 1).
//
// Goodreads's API has been closed since 2020, but every account can still
// export their library as a CSV from goodreads.com/review/import. The CSV
// shape is documented and stable enough to parse without a full RFC 4180
// parser — the fields we care about are simple quoted strings.
//
// This module is the pure "CSV → list of book entries" half. Each entry
// is `{ title, author, isbn?, year? }` (ISBN and year are present only
// when the source row had them). The renderer / IPC half (file picker,
// "Find ebook" buttons, integration with Open Library search) lives
// elsewhere and follows in a later slice.

// Goodreads "Exclusive Shelf" values we treat as "want to read".
const TO_READ_SHELVES = new Set(['to-read']);

export interface GoodreadsEntry {
  title: string;
  author: string;
  isbn?: string;
  year?: number;
}

// Parse a CSV line that may contain quoted fields with embedded commas and
// escaped quotes (`""`). RFC 4180 minus newlines inside fields, which the
// Goodreads export doesn't use.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
        i += 1;
        continue;
      }
      if (c === '"' && cur === '') {
        inQuotes = true;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
    }
  }
  out.push(cur);
  return out;
}

// Strip Goodreads's `=""value""` trick (used for fields that look numeric
// like ISBNs, to keep Excel from mangling them) and trim.
export function unquote(value: unknown): string {
  if (typeof value !== 'string') return '';
  const m = /^="(.*)"$/.exec(value.trim());
  if (m) return m[1].replace(/""/g, '"').trim();
  return value.trim();
}

// Parse a Goodreads `library_export.csv` and return one row per book on
// shelf "to-read". `Title`, `Author`, `Author l-f`, `ISBN`, `ISBN13`, and
// `Year Published` are extracted when present; everything else is dropped.
export function parseGoodreadsCsv(csv: unknown): GoodreadsEntry[] {
  if (typeof csv !== 'string') return [];
  // Goodreads exports use \r\n; split on either line ending.
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string): number => headers.indexOf(name);
  const iTitle = idx('Title');
  const iAuthor = idx('Author');
  const iAuthorLf = idx('Author l-f');
  const iIsbn = idx('ISBN');
  const iIsbn13 = idx('ISBN13');
  const iYear = idx('Year Published');
  const iShelf = idx('Exclusive Shelf');
  if (iTitle < 0 || iShelf < 0) return [];

  const out: GoodreadsEntry[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const fields = parseCsvLine(lines[r]);
    const shelf = unquote(fields[iShelf]).toLowerCase();
    if (!TO_READ_SHELVES.has(shelf)) continue;
    const title = unquote(fields[iTitle]);
    if (!title) continue;
    const author =
      (iAuthor >= 0 && unquote(fields[iAuthor])) ||
      (iAuthorLf >= 0 && unquote(fields[iAuthorLf])) ||
      '';
    const entry: GoodreadsEntry = { title, author };
    const isbn13 = iIsbn13 >= 0 ? unquote(fields[iIsbn13]) : '';
    const isbn = iIsbn >= 0 ? unquote(fields[iIsbn]) : '';
    if (isbn13) entry.isbn = isbn13;
    else if (isbn) entry.isbn = isbn;
    if (iYear >= 0) {
      const y = parseInt(unquote(fields[iYear]), 10);
      if (Number.isFinite(y) && y > 0) entry.year = y;
    }
    out.push(entry);
  }
  return out;
}
