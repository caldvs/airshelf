// `/download/<id>` route. Returns a decision the http handler can use to
// stat the file and stream it. The handler stays in main.js (it owns the
// fs read stream lifecycle); this module owns the route-shape regex,
// metadata lookup, filename sanitisation, and header set so they can be
// tested without booting Electron.
//
// Bookify's URL pattern is `/download/<id>` with NO file extension —
// PW3's experimental browser pre-checks URL extensions against a
// whitelist, so we omit the extension and let Content-Disposition
// carry the real filename. The optional `.ext` in the regex stays for
// backward compatibility but is ignored.

const path = require('path');

const DOWNLOAD_PATH_RE = /^\/download\/([a-f0-9]+)(?:\.[a-z0-9]+)?$/i;

// Sanitise a book title into a filename basename. Strips anything that
// isn't a-zA-Z0-9, dot, underscore, space, or dash, then caps at 80 chars
// so an unusually long title doesn't blow the Content-Disposition header.
function sanitiseBaseName(title) {
  return (title || 'book').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 80);
}

// Returns one of:
//   null                                 — subPath is not a /download/<id>
//   { status: 404, body }                — book id not in the metadata
//   { filePath, headers, status: 200 }   — caller should stat + stream
function prepareDownloadResponse({ subPath, books, booksDir }) {
  const m = subPath.match(DOWNLOAD_PATH_RE);
  if (!m) return null;
  const id = m[1];
  const book = books.find((b) => b.id === id);
  if (!book) return { status: 404, body: 'Not found' };
  const filePath = path.join(booksDir, book.file);
  const baseName = sanitiseBaseName(book.title);
  const downloadName = `${baseName}.${book.ext}`;
  return {
    status: 200,
    filePath,
    headers: {
      // octet-stream + attachment matches Bookify exactly. Swapping
      // Content-Type to application/vnd.amazon.ebook is what triggers
      // Kindle's "experimental browser cannot download this kind of
      // file" error, even though the filename extension is identical.
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
    },
  };
}

module.exports = { DOWNLOAD_PATH_RE, sanitiseBaseName, prepareDownloadResponse };
