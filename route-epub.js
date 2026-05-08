// `/epub/<id>` route. Returns a small "decision" object so the http handler
// in main.js can stay focused on (req, res) glue and this module stays
// integration-testable without booting Electron or http.Server.

const fs = require('fs');
const { parseRangeHeader } = require('./out/server/routes/range.js');

const EPUB_PATH_RE = /^\/epub\/([a-f0-9]+)$/;

// The reader iframe loads from file:// (Origin: null). 'null' matches that
// without opening to arbitrary websites the way '*' did. Applied even on
// error responses so the renderer's catch path can read the body.
const CORS_ALLOW = 'null';

// Returns one of:
//   null                                                   — subPath does not match
//   { status: 404, body, headers }                         — book id not in books,
//                                                          or built/expected file missing
//   { status: 500, body, headers }                         — getReaderEpubPath threw
//   { status: 416, headers }                               — range outside file size
//   { status: 206, headers, stream: { path, start, end } } — range hit
//   { status: 200, headers, stream: { path } }             — full file
//
// The caller is responsible for actually creating the read stream and
// piping it. Keeping I/O at the boundary keeps this pure and testable.
//
// Inputs:
//   subPath           — e.g. "/epub/abc123"
//   books             — list of book metadata objects (from listBooks())
//   getReaderEpubPath — async (book) => absolute path to the reader-ready
//                       .epub on disk. Throws on build failure.
//   rangeHeader       — value of the request `Range` header (or undefined)
async function handleEpubRequest({ subPath, books, getReaderEpubPath, rangeHeader }) {
  const m = subPath.match(EPUB_PATH_RE);
  if (!m) return null;
  const id = m[1];
  const book = books.find((b) => b.id === id);
  if (!book) {
    return {
      status: 404,
      body: 'Not found',
      headers: { 'Access-Control-Allow-Origin': CORS_ALLOW },
    };
  }

  let epubPath;
  try {
    epubPath = await getReaderEpubPath(book);
  } catch (e) {
    return {
      status: 500,
      body: `Build failed: ${e.message}`,
      headers: { 'Access-Control-Allow-Origin': CORS_ALLOW },
    };
  }
  if (!epubPath || !fs.existsSync(epubPath)) {
    return {
      status: 404,
      body: 'Missing',
      headers: { 'Access-Control-Allow-Origin': CORS_ALLOW },
    };
  }

  const stat = fs.statSync(epubPath);
  const baseHeaders = {
    'Content-Type': 'application/epub+zip',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': CORS_ALLOW,
  };
  const range = parseRangeHeader(rangeHeader, stat.size);
  if (range && range.status === 416) {
    return { status: 416, headers: { ...baseHeaders, ...range.headers } };
  }
  if (range && range.status === 206) {
    return {
      status: 206,
      headers: { ...baseHeaders, ...range.headers },
      stream: { path: epubPath, start: range.start, end: range.end },
    };
  }
  return {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': stat.size },
    stream: { path: epubPath },
  };
}

module.exports = { EPUB_PATH_RE, handleEpubRequest };
