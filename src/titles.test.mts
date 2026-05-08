import { describe, it, expect } from 'vitest';
import {
  titlesMatch,
  cleanTitle,
  extractSeries,
  guessAuthorFromFilename,
  shouldUseOpenLibraryTitle,
} from '../titles.js';

describe('titlesMatch', () => {
  it('matches identical titles', () => {
    expect(titlesMatch('The Hobbit', 'The Hobbit')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(titlesMatch('THE HOBBIT', 'the hobbit')).toBe(true);
  });

  it('ignores punctuation and collapses whitespace', () => {
    expect(titlesMatch('The Hobbit!', 'The Hobbit')).toBe(true);
    expect(titlesMatch('The   Hobbit', 'The Hobbit')).toBe(true);
    expect(titlesMatch("The Hobbit: There and Back Again", 'The Hobbit  There and Back Again')).toBe(true);
  });

  it('matches when one title is a word-boundary prefix of the other (>=4 chars)', () => {
    expect(titlesMatch('The Hobbit', 'The Hobbit: An Unexpected Journey')).toBe(true);
    expect(titlesMatch('Dune', 'Dune Messiah')).toBe(true);
  });

  it('rejects too-short prefixes (<4 chars after norm)', () => {
    // "It" is only 2 chars after norm → not a valid prefix match
    expect(titlesMatch('It', 'It Stephen King Novel')).toBe(false);
  });

  it('rejects prefixes that are not at a word boundary', () => {
    // "Dune" is a prefix of "Dunes" but no whitespace separates them, so
    // titlesMatch's `startsWith(na + ' ')` check rejects. Both inputs are
    // ≥4 chars to isolate this from the short-prefix rejection.
    expect(titlesMatch('Dune', 'Dunes')).toBe(false);
  });

  it('rejects empty / whitespace-only inputs', () => {
    expect(titlesMatch('', 'The Hobbit')).toBe(false);
    expect(titlesMatch('The Hobbit', '')).toBe(false);
    expect(titlesMatch('   ', 'The Hobbit')).toBe(false);
  });

  it('treats normalised mismatches as different', () => {
    expect(titlesMatch('The Hobbit', 'The Lord of the Rings')).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('drops common ebook extensions case-insensitively', () => {
    expect(cleanTitle('book.epub')).toBe('book');
    expect(cleanTitle('book.MOBI')).toBe('book');
    expect(cleanTitle('book.azw3')).toBe('book');
    expect(cleanTitle('book.pdf')).toBe('book');
    expect(cleanTitle('book.docx')).toBe('book');
  });

  it("splits on ' -- ' and ' - ' as author separators", () => {
    expect(cleanTitle('The Hobbit -- Tolkien.epub')).toBe('The Hobbit');
    expect(cleanTitle('The Hobbit - Tolkien.epub')).toBe('The Hobbit');
  });

  it('drops trailing parenthetical series markers', () => {
    expect(cleanTitle('Dune (Dune Chronicles Book 1).epub')).toBe('Dune');
    expect(cleanTitle('A Game of Thrones (A Song of Ice and Fire 1).epub'))
      .toBe('A Game of Thrones');
  });

  it('replaces underscores and collapses spaces', () => {
    expect(cleanTitle('the_hobbit.epub')).toBe('the hobbit');
    expect(cleanTitle('the   hobbit.epub')).toBe('the hobbit');
  });

  it('returns empty string for empty input', () => {
    expect(cleanTitle('')).toBe('');
  });

  it('handles a realistic messy filename end-to-end', () => {
    expect(cleanTitle('The Great Gatsby - F. Scott Fitzgerald (Modern Library).epub'))
      .toBe('The Great Gatsby');
  });

  it('does NOT split authors when the dash is wrapped in underscores (no whitespace)', () => {
    // Author-split regex requires whitespace around the dash. Underscores
    // between words don't trigger it, so the author stays in the title and
    // gets surfaced after the underscore→space pass. Documenting current
    // behaviour so a future change is intentional.
    expect(cleanTitle('the_great_gatsby__-__f_scott_fitzgerald.epub'))
      .toBe('the great gatsby - f scott fitzgerald');
  });
});

describe('guessAuthorFromFilename', () => {
  it('extracts author from "Title -- Author.epub"', () => {
    expect(guessAuthorFromFilename('The Hobbit -- J R R Tolkien.epub')).toBe('J R R Tolkien');
  });

  it('extracts author from "Title - Author.epub"', () => {
    expect(guessAuthorFromFilename('Dune - Frank Herbert.mobi')).toBe('Frank Herbert');
  });

  it('swaps "Last, First" → "First Last"', () => {
    expect(guessAuthorFromFilename('The Hobbit -- Tolkien, J R R.epub'))
      .toBe('J R R Tolkien');
  });

  it('returns null when there is no separator', () => {
    expect(guessAuthorFromFilename('TheHobbit.epub')).toBeNull();
    expect(guessAuthorFromFilename('The Hobbit.epub')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(guessAuthorFromFilename('')).toBeNull();
  });

  it('takes the LAST segment when there are multiple separators (publisher edition prefix)', () => {
    // "Modern Classics -- The Hobbit -- Tolkien" — the author is the trailing part
    expect(guessAuthorFromFilename('Modern Classics -- The Hobbit -- Tolkien.epub'))
      .toBe('Tolkien');
  });
});

describe('extractSeries', () => {
  it('extracts series + index from "Title (Series #N)"', () => {
    expect(extractSeries('Dune (Dune Chronicles #1)')).toEqual({
      title: 'Dune',
      series: 'Dune Chronicles',
      seriesIndex: 1,
    });
  });

  it('extracts when there is a comma between series and #N', () => {
    expect(extractSeries('Words of Radiance (The Stormlight Archive, #2)')).toEqual({
      title: 'Words of Radiance',
      series: 'The Stormlight Archive',
      seriesIndex: 2,
    });
  });

  it('extracts even with a file extension after the closing paren', () => {
    expect(extractSeries('Foundation and Empire (Foundation #2).epub')).toEqual({
      title: 'Foundation and Empire',
      series: 'Foundation',
      seriesIndex: 2,
    });
  });

  it('returns null series for titles with no parenthetical', () => {
    expect(extractSeries('The Hobbit')).toEqual({
      title: 'The Hobbit',
      series: null,
      seriesIndex: null,
    });
  });

  it('does NOT match year-shape parentheticals', () => {
    expect(extractSeries('Dune (1965)')).toEqual({
      title: 'Dune',
      series: null,
      seriesIndex: null,
    });
  });

  it('does NOT match label-only parentheticals (no #N)', () => {
    expect(extractSeries('The Lord of the Rings (Boxed Set)')).toEqual({
      title: 'The Lord of the Rings',
      series: null,
      seriesIndex: null,
    });
  });

  it('handles double-digit indices', () => {
    expect(extractSeries('Wheel of Time Book 14 (The Wheel of Time #14)')).toEqual({
      title: 'Wheel of Time Book 14',
      series: 'The Wheel of Time',
      seriesIndex: 14,
    });
  });

  it('returns empty title + null series for empty input', () => {
    expect(extractSeries('')).toEqual({
      title: '',
      series: null,
      seriesIndex: null,
    });
  });

  it('strips a trailing "-- Author" suffix before matching series', () => {
    expect(extractSeries('Dune (Dune Chronicles #1) -- Frank Herbert.epub')).toEqual({
      title: 'Dune',
      series: 'Dune Chronicles',
      seriesIndex: 1,
    });
  });

  it('rejects #0 (seriesIndex is 1-based) — keeps title + drops series', () => {
    expect(extractSeries('Foo (Series #0)')).toEqual({
      title: 'Foo',
      series: null,
      seriesIndex: null,
    });
  });
});

describe('shouldUseOpenLibraryTitle', () => {
  it('rejects empty Open Library title', () => {
    expect(shouldUseOpenLibraryTitle('Dune', '')).toBe(false);
  });

  it('rejects when titles are byte-identical (no point swapping)', () => {
    expect(shouldUseOpenLibraryTitle('Dune', 'Dune')).toBe(false);
  });

  it('rejects when titlesMatch fails (different books)', () => {
    expect(shouldUseOpenLibraryTitle('Dune', 'The Hobbit')).toBe(false);
  });

  it('accepts a clean OL variant within the +4 char budget', () => {
    // "The Hobbit" (10) vs "The Hobbit." (11) — OL adds a trailing dot.
    expect(shouldUseOpenLibraryTitle('The Hobbit', 'The Hobbit.')).toBe(true);
  });

  it('rejects an OL title that exceeds the +4 char budget', () => {
    // "Dune" (4) vs "Dune Messiah" (12) — different book, too long.
    expect(shouldUseOpenLibraryTitle('Dune', 'Dune Messiah')).toBe(false);
  });

  it('accepts a recased OL title when titlesMatch agrees', () => {
    expect(shouldUseOpenLibraryTitle('the hobbit', 'The Hobbit')).toBe(true);
  });
});
