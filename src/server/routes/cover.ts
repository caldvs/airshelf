// `/cover/<id>` route. Returns a small "decision" object so the http handler
// in main.js can stay focused on (req, res) glue and this module stays
// integration-testable without booting Electron or http.Server.

import { existsSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

export const COVER_PATH_RE = /^\/cover\/([a-f0-9]+)$/;

// Cache covers for 30 days. They're keyed by content hash via the book id +
// size + mtime so a re-cover invalidates without explicit cache-busting.
const CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const CACHE_CONTROL = `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`;

interface BookEntry {
  id: string;
  cover?: string | null;
}

interface HandleCoverArgs {
  subPath: string;
  books: BookEntry[];
  booksDir: string;
  // Node's IncomingMessage.headers[X] is `string | string[] | undefined`
  // for most headers. Accept the array form so a multi-valued header
  // (rare for these, but Node won't normalise) doesn't silently flunk
  // the equality check below and force a fresh 200 every request.
  ifNoneMatch?: string | string[] | undefined;
  ifModifiedSince?: string | string[] | undefined;
}

function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

interface CoverHeaders304 {
  ETag: string;
  'Cache-Control': string;
}

interface CoverHeaders200 {
  'Content-Type': string;
  'Content-Length': number;
  'Cache-Control': string;
  ETag: string;
  'Last-Modified': string;
  Expires: string;
}

export type CoverResponse =
  | { status: 404; body: string }
  | { status: 304; headers: CoverHeaders304 }
  | { status: 200; body: Buffer; headers: CoverHeaders200 };

export function sniffImageType(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  }
  return 'image/jpeg';
}

// Returns one of:
//   null                                   — subPath does not match /cover/<hex>;
//                                            caller should keep matching routes
//   { status: 404, body }                  — matched, but cover is missing
//                                            (no entry, no cover field, or file
//                                            not on disk)
//   { status: 304, headers }               — client has the current copy
//   { status: 200, body: Buffer, headers } — image bytes
//
// Inputs:
//   subPath          — e.g. "/cover/abc123"
//   books            — list of book metadata objects (from listBooks())
//   booksDir         — absolute path to the books directory
//   ifNoneMatch      — value of the `If-None-Match` request header (or undefined)
//   ifModifiedSince  — value of the `If-Modified-Since` request header
export function handleCoverRequest({
  subPath,
  books,
  booksDir,
  ifNoneMatch,
  ifModifiedSince,
}: HandleCoverArgs): CoverResponse | null {
  const m = subPath.match(COVER_PATH_RE);
  if (!m) return null;
  const id = m[1];
  const book = books.find((b) => b.id === id);
  if (!book || !book.cover) {
    return { status: 404, body: 'No cover' };
  }
  const coverPath = path.join(booksDir, book.cover);
  if (!existsSync(coverPath)) {
    return { status: 404, body: 'Missing' };
  }
  const stat = statSync(coverPath);
  const etag = `"${id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const lastModified = stat.mtime.toUTCString();

  if (
    firstHeaderValue(ifNoneMatch) === etag ||
    firstHeaderValue(ifModifiedSince) === lastModified
  ) {
    return {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
    };
  }

  const buf = readFileSync(coverPath);
  return {
    status: 200,
    body: buf,
    headers: {
      'Content-Type': sniffImageType(buf),
      'Content-Length': buf.length,
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
      'Last-Modified': lastModified,
      Expires: new Date(Date.now() + CACHE_MAX_AGE_SECONDS * 1000).toUTCString(),
    },
  };
}
