// `/cover/<id>` route. Returns a small "decision" object so the http handler
// in main.js can stay focused on (req, res) glue and this module stays
// integration-testable without booting Electron or http.Server.

const fs = require('fs');
const path = require('path');

const COVER_PATH_RE = /^\/cover\/([a-f0-9]+)$/;

// Cache covers for 30 days. They're keyed by content hash via the book id +
// size + mtime so a re-cover invalidates without explicit cache-busting.
const CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const CACHE_CONTROL = `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`;

function sniffImageType(buf) {
  if (buf.length >= 2) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  }
  return 'image/jpeg';
}

// Returns one of:
//   { status: 404, body }                  — no match for this route, or missing cover
//   { status: 304, headers }               — client has the current copy
//   { status: 200, body: Buffer, headers } — image bytes
//
// Inputs:
//   subPath        — e.g. "/cover/abc123"
//   books          — list of book metadata objects (from listBooks())
//   booksDir       — absolute path to the books directory
//   ifNoneMatch    — value of the `If-None-Match` request header (or undefined)
//   ifModifiedSince — value of the `If-Modified-Since` request header
function handleCoverRequest({ subPath, books, booksDir, ifNoneMatch, ifModifiedSince }) {
  const m = subPath.match(COVER_PATH_RE);
  if (!m) return null;
  const id = m[1];
  const book = books.find((b) => b.id === id);
  if (!book || !book.cover) {
    return { status: 404, body: 'No cover' };
  }
  const coverPath = path.join(booksDir, book.cover);
  if (!fs.existsSync(coverPath)) {
    return { status: 404, body: 'Missing' };
  }
  const stat = fs.statSync(coverPath);
  const etag = `"${id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const lastModified = stat.mtime.toUTCString();

  if (ifNoneMatch === etag || ifModifiedSince === lastModified) {
    return {
      status: 304,
      headers: { 'ETag': etag, 'Cache-Control': CACHE_CONTROL },
    };
  }

  const buf = fs.readFileSync(coverPath);
  return {
    status: 200,
    body: buf,
    headers: {
      'Content-Type': sniffImageType(buf),
      'Content-Length': buf.length,
      'Cache-Control': CACHE_CONTROL,
      'ETag': etag,
      'Last-Modified': lastModified,
      'Expires': new Date(Date.now() + CACHE_MAX_AGE_SECONDS * 1000).toUTCString(),
    },
  };
}

module.exports = { COVER_PATH_RE, sniffImageType, handleCoverRequest };
