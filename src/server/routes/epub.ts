// `/epub/<id>` route. Returns a small "decision" object so the http handler
// in main.js can stay focused on (req, res) glue and this module stays
// integration-testable without booting Electron or http.Server.

import { existsSync, statSync } from 'fs';
import { parseRangeHeader } from './range.js';

export const EPUB_PATH_RE = /^\/epub\/([a-f0-9]+)$/;

// The reader iframe loads from file:// (Origin: null). 'null' matches that
// without opening to arbitrary websites the way '*' did. Applied even on
// error responses so the renderer's catch path can read the body.
const CORS_ALLOW = 'null';

interface BookEntry {
  id: string;
}

interface HandleEpubArgs {
  subPath: string;
  books: BookEntry[];
  getReaderEpubPath: (book: BookEntry) => Promise<string | null | undefined>;
  rangeHeader?: string | null | undefined;
}

interface BaseHeaders {
  'Content-Type'?: string;
  'Accept-Ranges'?: string;
  'Cache-Control'?: string;
  'Access-Control-Allow-Origin': string;
  'Content-Length'?: number;
  'Content-Range'?: string;
}

export type EpubResponse =
  | { status: 404 | 500; body: string; headers: { 'Access-Control-Allow-Origin': string } }
  | { status: 416; headers: BaseHeaders }
  | { status: 206; headers: BaseHeaders; stream: { path: string; start: number; end: number } }
  | { status: 200; headers: BaseHeaders; stream: { path: string } };

// Returns one of:
//   null                                                   — subPath does not match
//   { status: 404, body, headers }                         — book id not in books,
//                                                            or built/expected file missing
//   { status: 500, body, headers }                         — getReaderEpubPath threw
//   { status: 416, headers }                               — range outside file size
//   { status: 206, headers, stream: { path, start, end } } — range hit
//   { status: 200, headers, stream: { path } }             — full file
//
// The caller is responsible for actually creating the read stream and
// piping it. Keeping I/O at the boundary keeps this pure and testable.
export async function handleEpubRequest({
  subPath,
  books,
  getReaderEpubPath,
  rangeHeader,
}: HandleEpubArgs): Promise<EpubResponse | null> {
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

  let epubPath: string | null | undefined;
  try {
    epubPath = await getReaderEpubPath(book);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: 500,
      body: `Build failed: ${message}`,
      headers: { 'Access-Control-Allow-Origin': CORS_ALLOW },
    };
  }
  if (!epubPath || !existsSync(epubPath)) {
    return {
      status: 404,
      body: 'Missing',
      headers: { 'Access-Control-Allow-Origin': CORS_ALLOW },
    };
  }

  const stat = statSync(epubPath);
  const baseHeaders: BaseHeaders = {
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
