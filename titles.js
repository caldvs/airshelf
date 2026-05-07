// Pure title-handling helpers used by main.js. Single canonical impl —
// the duplicate src/titles.ts that used to exist for test coverage was
// removed; the tests in src/titles.test.mts now import directly from here.

// Loose title matching: true if one title is effectively a prefix of the
// other after lowercase + punctuation strip. Used to decide whether two
// title strings refer to the same book despite formatting differences
// ("The Hobbit" vs "the hobbit:" vs "The Hobbit, An Unexpected Journey").
function titlesMatch(a, b) {
  const norm = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
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

// Pull an author out of a raw filename like "Title -- Author.epub".
function guessAuthorFromFilename(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(
    /\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i,
    ''
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

module.exports = { titlesMatch, cleanTitle, guessAuthorFromFilename, shouldUseOpenLibraryTitle };
