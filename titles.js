// Pure title-handling helpers used by main.js. Single canonical impl —
// the duplicate src/titles.ts that used to exist for test coverage was
// removed; the tests in src/titles.test.mts now import directly from here.

// Loose title matching: true if one title is effectively a prefix of the
// other after lowercase + punctuation strip. Used to decide whether two
// title strings refer to the same book despite formatting differences
// ("The Hobbit" vs "the hobbit:" vs "The Hobbit, An Unexpected Journey").
function titlesMatch(a, b) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.startsWith(na + ' ')) return true;
  if (nb.length >= 4 && na.startsWith(nb + ' ')) return true;
  return false;
}

// Strip extension, author suffix, parenthetical series markers, underscores.
function cleanTitle(raw) {
  if (!raw) return '';
  let t = String(raw);
  t = t.replace(/\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i, '');
  t = t.split(/\s+--?\s+/)[0];
  t = t.replace(/\s*\([^)]*\)\s*$/g, '');
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// Pull series info out of a raw title's trailing parenthetical, if it has
// the shape `(<seriesName>[, ]?#<index>)`. Returns the cleaned title plus
// the extracted series + index when matched. Examples that match:
//
//   "Dune (Dune Chronicles #1)"
//      → series "Dune Chronicles", #1
//   "Words of Radiance (The Stormlight Archive, #2)"
//      → series "The Stormlight Archive", #2
//   "Foundation and Empire (Foundation #2).epub"
//      → series "Foundation", #2
//   "Dune (Dune Chronicles #1) -- Frank Herbert.epub"
//      → series "Dune Chronicles", #1   (author suffix stripped first)
//
// Examples that DON'T match (cleanTitle still applies, no series captured):
//
//   "The Hobbit"                          (no parenthetical)
//   "Dune (1965)"                         (year-shape, not series)
//   "The Lord of the Rings (Boxed Set)"   (no #N — just a label)
//
// We only treat a parenthetical as a series if it ends with `#<digits>`
// (where digits ≥ 1) so we don't false-match `(Annotated Edition)` /
// `(Boxed Set)` / pub years, and we don't accept `#0` since the
// `seriesIndex` field is documented as 1-based.
//
// To make the trailing-paren anchor work on real filenames, we strip the
// extension (`.epub`, `.azw3`, …) and the `-- Author` suffix that
// `cleanTitle` strips, before applying SERIES_RE. Otherwise common
// filenames like "Dune (Series #1) -- Frank Herbert.epub" would push the
// closing paren away from the end-of-string anchor and slip past us.
const EXT_RE = /\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i;
const AUTHOR_SEPARATOR_RE = /\s+--?\s+/;
const SERIES_RE = /\s*\((?<name>[^)]+?)(?:,)?\s+#(?<idx>\d+)\)\s*$/;

function extractSeries(rawTitle) {
  if (!rawTitle) return { title: '', series: null, seriesIndex: null };
  // Pre-normalise to the same pre-title slice cleanTitle works on: drop
  // the extension first, then the author suffix. Order matters — if we
  // split on the separator before stripping the extension, an extension
  // preceded by `--` (rare, but possible) could land in the wrong slot.
  const sansExt = String(rawTitle).replace(EXT_RE, '');
  const titlePart = sansExt.split(AUTHOR_SEPARATOR_RE)[0];
  const m = titlePart.match(SERIES_RE);
  if (!m || !m.groups) {
    return { title: cleanTitle(rawTitle), series: null, seriesIndex: null };
  }
  const name = m.groups.name.trim();
  const idx = parseInt(m.groups.idx, 10);
  // 1-based: a `#0` match isn't a real series marker (most likely a
  // template placeholder or junk), so drop the whole match — the
  // parenthetical still gets stripped by cleanTitle.
  if (!Number.isFinite(idx) || idx < 1 || !name) {
    return { title: cleanTitle(rawTitle), series: null, seriesIndex: null };
  }
  return {
    title: cleanTitle(rawTitle),
    series: name,
    seriesIndex: idx,
  };
}

// Pull an author out of a raw filename like "Title -- Author.epub".
function guessAuthorFromFilename(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(
    /\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i,
    '',
  );
  const parts = stripped.split(/\s+--?\s+/);
  if (parts.length >= 2) {
    const candidate = parts[parts.length - 1].trim();
    if (/,/.test(candidate)) {
      const [last, first] = candidate.split(',').map((s) => s.trim());
      if (first && last) return `${first} ${last}`;
    }
    return candidate || null;
  }
  return null;
}

// Decide whether to adopt an Open Library title as the canonical one.
// Only adopt if OL's title is a near-match (so we know it's the same book)
// and isn't dramatically longer (ours is often the cleaner trimmed form).
function shouldUseOpenLibraryTitle(local, ol) {
  if (!ol) return false;
  if (ol === local) return false;
  if (!titlesMatch(ol, local)) return false;
  return ol.length <= local.length + 4;
}

module.exports = {
  titlesMatch,
  cleanTitle,
  extractSeries,
  guessAuthorFromFilename,
  shouldUseOpenLibraryTitle,
};
