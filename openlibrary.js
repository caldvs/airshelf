// Open Library client. Pulled out of main.js so it can be unit-tested
// without spinning up Electron and so the same shapes stay in one place
// when the renderer / CLI ever wants to talk to OL too.
//
// All HTTP calls live behind a small dependency-injection seam: pass
// `{ fetch }` into the search / download / description helpers if you
// want to stub the network in tests. Default is the global `fetch`.

const fs = require('fs');
const { cleanTitle } = require('./out/lib/titles.js');

const SEARCH_URL = 'https://openlibrary.org/search.json';
const COVER_BASE = 'https://covers.openlibrary.org/b';
const WORKS_BASE = 'https://openlibrary.org';
const USER_AGENT = 'Airshelf/0.1 (ebook helper)';

// Open Library returns a tiny "no cover" placeholder image (well under 1 KB)
// when the requested cover doesn't exist. We treat any response shorter
// than this threshold as a placeholder and fall through to the next URL.
const COVER_PLACEHOLDER_BYTES = 1000;

// Build query-title variants for a search. Open Library's search is finicky
// about colons and parentheticals; trying a few cleaned forms recovers
// matches that the raw filename would miss. Returns an array preserving
// insertion order with the most-cleaned variant first.
function buildSearchVariants(rawTitle) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!v || v.length < 2 || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  const cleaned = cleanTitle(rawTitle);
  push(cleaned);
  if (cleaned.includes(':')) push(cleaned.split(':')[0].trim());
  push(rawTitle);
  return out;
}

// Score an Open Library doc. Used to pick the best result across multiple
// query variants. English + has-cover beats either alone, which beats
// neither. Returning a stable integer keeps comparisons trivial.
function scoreDoc(doc) {
  const isEnglish = Array.isArray(doc.language) && doc.language.includes('eng');
  return (isEnglish ? 2 : 0) + (doc.cover_i ? 1 : 0);
}

// Pick the best doc from a list. Returns null on an empty list. Preserves
// the doc that *first* hits the maximum possible score (3 = English +
// cover) so we can short-circuit a full iteration once we find it.
function pickBestDoc(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  let best = null;
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
function buildCoverAttemptUrls(doc) {
  if (!doc) return [];
  const out = [];
  if (doc.cover_i) out.push(`${COVER_BASE}/id/${doc.cover_i}-L.jpg`);
  if (doc.isbn && doc.isbn[0]) out.push(`${COVER_BASE}/isbn/${doc.isbn[0]}-L.jpg`);
  if (doc.edition_key && doc.edition_key[0])
    out.push(`${COVER_BASE}/olid/${doc.edition_key[0]}-L.jpg`);
  return out;
}

// Open Library's `description` field can be a plain string or an object
// `{ type: '/type/text', value: '...' }`. Normalise both shapes — anything
// else returns null so callers don't have to defend.
function parseDescription(workData) {
  if (!workData || workData.description == null) return null;
  if (typeof workData.description === 'string') return workData.description;
  if (typeof workData.description === 'object' && typeof workData.description.value === 'string') {
    return workData.description.value;
  }
  return null;
}

// Search Open Library for a book by title (and optionally author). Tries
// each query variant in turn, scores every returned doc, and returns the
// best across all variants. Network errors are swallowed per-variant so
// one transient failure doesn't kill the search.
async function searchOpenLibrary(title, author, deps = {}) {
  if (!title) return null;
  const fetchFn = deps.fetch || fetch;
  const variants = buildSearchVariants(title);

  let best = null;
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
      const data = await res.json();
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
async function downloadOpenLibraryCover(doc, outPath, deps = {}) {
  if (!doc) return false;
  const fetchFn = deps.fetch || fetch;
  const writeFile = deps.writeFile || ((p, b) => fs.writeFileSync(p, b));
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
async function fetchOpenLibraryDescription(doc, deps = {}) {
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

module.exports = {
  // High-level operations.
  searchOpenLibrary,
  downloadOpenLibraryCover,
  fetchOpenLibraryDescription,
  // Pure helpers exposed for testing + reuse.
  buildSearchVariants,
  scoreDoc,
  pickBestDoc,
  buildCoverAttemptUrls,
  parseDescription,
  // Constants exported so tests can assert against them rather than hard-coding.
  COVER_PLACEHOLDER_BYTES,
};
