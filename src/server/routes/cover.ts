// `/cover/<id>` route. Returns a small "decision" object so the http handler
// in main.js can stay focused on (req, res) glue and this module stays
// integration-testable without booting Electron or http.Server.
//
// 200 responses carry `filePath` rather than a Buffer body — the caller
// pipes a read stream from it. Pre-loading the cover into memory was
// per-request waste (covers can be ~60 KB each, and the Kindle index
// renders N at once so memory usage scaled linearly with library size).

import { closeSync, openSync, readSync, Stats, statSync } from 'fs';
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

// Parse an If-None-Match header value into the set of ETags it carries.
// Accepts both forms RFC 7232 allows: a single string with comma-
// separated entries (`"a", "b"`) and the Node array form (`['"a"', '"b"']`).
// Strips the optional weak `W/` prefix so a server-strong / client-weak
// pair still matches. Returns an empty array on `undefined` / empty.
function parseIfNoneMatch(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  const parts = Array.isArray(v) ? v.flatMap((s) => s.split(',')) : v.split(',');
  return parts.map((s) => s.trim().replace(/^W\//, '')).filter((s) => s.length > 0);
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
  | { status: 200; filePath: string; headers: CoverHeaders200 };

export function sniffImageType(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  }
  return 'image/jpeg';
}

// Per-process cache of `{mtimeMs -> mime}` keyed by absolute file path.
// Serving the bookshelf to a Kindle hits this route N times in a row;
// caching the sniff result avoids re-opening the file just to read its
// magic bytes when nothing has changed. Invalidates implicitly on
// mtimeMs mismatch (covers are rewritten with a fresh mtime).
const mimeCache = new Map<string, { mtimeMs: number; mime: string }>();

function readMimeFromHead(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    return sniffImageType(head);
  } finally {
    closeSync(fd);
  }
}

function cachedMime(filePath: string, stat: Stats): string {
  const cached = mimeCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.mime;
  const mime = readMimeFromHead(filePath);
  mimeCache.set(filePath, { mtimeMs: stat.mtimeMs, mime });
  return mime;
}

// Returns one of:
//   null                                     — subPath does not match /cover/<hex>;
//                                              caller should keep matching routes
//   { status: 404, body }                    — matched, but cover is missing
//   { status: 304, headers }                 — client has the current copy
//   { status: 200, filePath, headers }       — caller should stream filePath
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
  // statSync throws ENOENT on missing files — one syscall covers both
  // the existence check and metadata read.
  let stat: Stats;
  try {
    stat = statSync(coverPath);
  } catch {
    return { status: 404, body: 'Missing' };
  }
  const etag = `"${id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const lastModified = stat.mtime.toUTCString();

  // If-None-Match per RFC 7232: comma-separated list, weak validators
  // allowed. `*` wildcard matches any current representation. We match if
  // any client-supplied tag equals our strong etag (after stripping the
  // weak prefix on both sides — the server only emits strong tags).
  const inmTags = parseIfNoneMatch(ifNoneMatch);
  const ifNoneMatchHit = inmTags.includes('*') || inmTags.includes(etag);
  if (ifNoneMatchHit || firstHeaderValue(ifModifiedSince) === lastModified) {
    return {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
    };
  }

  return {
    status: 200,
    filePath: coverPath,
    headers: {
      'Content-Type': cachedMime(coverPath, stat),
      'Content-Length': stat.size,
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
      'Last-Modified': lastModified,
      Expires: new Date(Date.now() + CACHE_MAX_AGE_SECONDS * 1000).toUTCString(),
    },
  };
}
