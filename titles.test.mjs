import { describe, it, expect } from 'vitest';
import { extractSeries } from './titles.js';

// The existing src/titles.test.mts covers titlesMatch / cleanTitle /
// guessAuthorFromFilename / shouldUseOpenLibraryTitle but lives under .mts
// and isn't picked up by the .mjs-only vitest include. This file uses the
// .mjs extension so the new extractSeries cases actually run in CI.

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
});
