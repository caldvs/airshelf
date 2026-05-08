// Open Library client. Pulled out of main.js so it can be unit-tested
// without spinning up Electron and so the same shapes stay in one place
// when the renderer / CLI ever wants to talk to OL too.
//
// All HTTP calls live behind a small dependency-injection seam: pass
// `{ fetch }` into the search / download / description helpers if you
// want to stub the network in tests. Default is the global `fetch`.

import { writeFileSync } from 'fs';
import { cleanTitle } from '../lib/titles.js';

const SEARCH_URL = 'https://openlibrary.org/search.json';
const COVER_BASE = 'https://covers.openlibrary.org/b';
const WORKS_BASE = 'https://openlibrary.org';
const USER_AGENT = 'Airshelf/0.1 (ebook helper)';

// Open Library returns a tiny "no cover" placeholder image (well under 1 KB)
// when the requested cover doesn't exist. We treat any response shorter
// than this threshold as a placeholder and fall through to the next URL.
export const COVER_PLACEHOLDER_BYTES = 1000;

export interface OpenLibraryDoc {
  language?: string[];
  cover_i?: number;
  isbn?: string[];
  edition_key?: string[];
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  // OL returns plenty of other fields; we only narrow what's actually used.
  [key: string]: unknown;
}

interface FetchDeps {
  fetch?: typeof fetch;
}

interface DownloadCoverDeps extends FetchDeps {
  writeFile?: (path: string, data: Buffer) => void;
}

// Build query-title variants for a search. Open Library's search is finicky
// about colons and parentheticals; trying a few cleaned forms recovers
// matches that the raw filename would miss. Returns an array preserving
// insertion order with the most-cleaned variant first.
export function buildSearchVariants(rawTitle: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string): void => {
    if (!v || v.length < 2 || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  const cleaned = cleanTitle(rawTitle);
  push(cleaned);
  if (cleaned.includes(':')) push(cleaned.split(':')[0].trim());
  if (typeof rawTitle === 'string') push(rawTitle);
  return out;
}

// Score an Open Library doc. Used to pick the best result across multiple
// query variants. English + has-cover beats either alone, which beats
// neither. Returning a stable integer keeps comparisons trivial.
export function scoreDoc(doc: OpenLibraryDoc): number {
  const isEnglish = Array.isArray(doc.language) && doc.language.includes('eng');
  return (isEnglish ? 2 : 0) + (doc.cover_i ? 1 : 0);
}

// Pick the best doc from a list. Returns null on an empty list. Preserves
// the doc that *first* hits the maximum possible score (3 = English +
// cover) so we can short-circuit a full iteration once we find it.
export function pickBestDoc(docs: OpenLibraryDoc[] | unknown): OpenLibraryDoc | null {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  let best: OpenLibraryDoc | null = null;
  let bestScore = -1;
  for (const doc of docs) {
    const s = scoreDoc(doc);
    if (s > bestScore) {
      best = doc;
      bestScore = s;
      if (bestScore === 3) return best;
    }
  }
  return best;
}

// Construct the ordered list of cover-image URLs to try for a doc.
// Tries the cover_i, then the first ISBN, then the first edition_key.
// Returns an empty array when none of those identifiers are present.
export function buildCoverAttemptUrls(doc: OpenLibraryDoc | null | undefined): string[] {
  if (!doc) return [];
  const out: string[] = [];
  if (doc.cover_i) out.push(`${COVER_BASE}/id/${doc.cover_i}-L.jpg`);
  if (doc.isbn && doc.isbn[0]) out.push(`${COVER_BASE}/isbn/${doc.isbn[0]}-L.jpg`);
  if (doc.edition_key && doc.edition_key[0])
    out.push(`${COVER_BASE}/olid/${doc.edition_key[0]}-L.jpg`);
  return out;
}

// Open Library's `description` field can be a plain string or an object
// `{ type: '/type/text', value: '...' }`. Normalise both shapes — anything
// else returns null so callers don't have to defend.
export function parseDescription(workData: unknown): string | null {
  if (!workData || typeof workData !== 'object') return null;
  const desc = (workData as { description?: unknown }).description;
  if (desc == null) return null;
  if (typeof desc === 'string') return desc;
  if (typeof desc === 'object' && typeof (desc as { value?: unknown }).value === 'string') {
    return (desc as { value: string }).value;
  }
  return null;
}

// Search Open Library for a book by title (and optionally author). Tries
// each query variant in turn, scores every returned doc, and returns the
// best across all variants. Network errors are swallowed per-variant so
// one transient failure doesn't kill the search.
export async function searchOpenLibrary(
  title: string | null | undefined,
  author?: string | null,
  deps: FetchDeps = {},
): Promise<OpenLibraryDoc | null> {
  if (!title) return null;
  const fetchFn = deps.fetch || fetch;
  const variants = buildSearchVariants(title);

  let best: OpenLibraryDoc | null = null;
  let bestScore = -1;
  for (const variant of variants) {
    try {
      const q = new URLSearchParams({ title: variant });
      if (author) q.set('author', author);
      q.set('limit', '5');
      const res = await fetchFn(`${SEARCH_URL}?${q.toString()}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
      const docs = Array.isArray(data.docs) ? data.docs : [];
      for (const doc of docs) {
        const s = scoreDoc(doc);
        if (s > bestScore) {
          best = doc;
          bestScore = s;
          if (bestScore === 3) return best;
        }
      }
    } catch {}
  }
  return best;
}

// Download a cover image to `outPath`. Returns true if a real cover was
// written. Open Library serves a tiny placeholder image when the requested
// id has no cover; we filter those by byte-size.
export async function downloadOpenLibraryCover(
  doc: OpenLibraryDoc | null | undefined,
  outPath: string,
  deps: DownloadCoverDeps = {},
): Promise<boolean> {
  if (!doc) return false;
  const fetchFn = deps.fetch || fetch;
  const writeFile = deps.writeFile || ((p: string, b: Buffer) => writeFileSync(p, b));
  for (const url of buildCoverAttemptUrls(doc)) {
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < COVER_PLACEHOLDER_BYTES) continue;
      writeFile(outPath, buf);
      return true;
    } catch {}
  }
  return false;
}

// Fetch a description for a book from Open Library's works API. Returns
// null on any failure path: missing `key`, network error, missing
// description, or unrecognised description shape.
export async function fetchOpenLibraryDescription(
  doc: OpenLibraryDoc | null | undefined,
  deps: FetchDeps = {},
): Promise<string | null> {
  const fetchFn = deps.fetch || fetch;
  if (!doc || !doc.key) return null;
  try {
    const res = await fetchFn(`${WORKS_BASE}${doc.key}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return parseDescription(data);
  } catch {
    return null;
  }
}
