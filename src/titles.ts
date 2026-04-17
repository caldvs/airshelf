// Pure string-handling helpers for cleaning messy filename-derived titles.
// Separated out so they can be unit-tested without any Node / Electron deps.

/** Loose title matching: true if one title is effectively a prefix of the other. */
export function titlesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Prefix match at word boundaries with a minimum length
  if (na.length >= 4 && nb.startsWith(na + ' ')) return true;
  if (nb.length >= 4 && na.startsWith(nb + ' ')) return true;
  return false;
}

/** Strip extension, author suffixes, series markers, underscores from a title. */
export function cleanTitle(raw: string): string {
  if (!raw) return '';
  let t = String(raw);
  // Drop extension if present
  t = t.replace(/\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i, '');
  // Split off " -- Author" or " - Author" — common filename convention
  t = t.split(/\s+--?\s+/)[0] ?? t;
  // Drop trailing parenthetical series/book markers "(The Foo Book 1)"
  t = t.replace(/\s*\([^)]*\)\s*$/g, '');
  // Replace underscores and collapse whitespace
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

/** Attempt to pull an author out of a raw filename like "Title -- Author.epub" */
export function guessAuthorFromFilename(raw: string): string | null {
  if (!raw) return null;
  const stripped = String(raw).replace(
    /\.(epub|mobi|azw3?|prc|pdf|txt|fb2|lit|lrf|pdb|rtf|docx|odt|html?)$/i,
    ''
  );
  const parts = stripped.split(/\s+--?\s+/);
  if (parts.length >= 2) {
    const candidate = (parts[parts.length - 1] ?? '').trim();
    // Authors are often written "Last, First" — swap if so
    if (/,/.test(candidate)) {
      const [last, first] = candidate.split(',').map((s) => s.trim());
      if (first && last) return `${first} ${last}`;
    }
    return candidate || null;
  }
  return null;
}

/** Decide whether to adopt an Open Library title as the canonical one.
 *  Only adopt if OL's title is short enough (ours may be the clean trimmed version). */
export function shouldUseOpenLibraryTitle(local: string, ol: string): boolean {
  if (!ol) return false;
  if (ol === local) return false;
  if (!titlesMatch(ol, local)) return false;
  return ol.length <= local.length + 4;
}
