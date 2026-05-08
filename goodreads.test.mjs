import { describe, it, expect } from 'vitest';
import { parseCsvLine, unquote, parseGoodreadsCsv } from './goodreads.js';

describe('parseCsvLine', () => {
  it('splits on commas outside quotes', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves a comma inside quotes', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes "" as a literal " inside quoted fields', () => {
    expect(parseCsvLine('"He said ""hi""",ok')).toEqual(['He said "hi"', 'ok']);
  });

  it('returns empty strings for missing middle fields', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('returns an empty trailing field when the line ends with a comma', () => {
    expect(parseCsvLine('a,b,')).toEqual(['a', 'b', '']);
  });

  it('handles empty input', () => {
    expect(parseCsvLine('')).toEqual(['']);
  });
});

describe('unquote', () => {
  it('strips Goodreads ="..." excel-escape', () => {
    expect(unquote('="9780123456789"')).toBe('9780123456789');
  });

  it('passes through plain strings (with trim)', () => {
    expect(unquote('  hello  ')).toBe('hello');
  });

  it('handles non-strings gracefully', () => {
    expect(unquote(undefined)).toBe('');
    expect(unquote(null)).toBe('');
  });
});

describe('parseGoodreadsCsv', () => {
  // Minimal Goodreads export header we care about.
  const HDR = 'Title,Author,Author l-f,ISBN,ISBN13,Year Published,Exclusive Shelf';

  it('returns an empty list on empty input', () => {
    expect(parseGoodreadsCsv('')).toEqual([]);
    expect(parseGoodreadsCsv(HDR)).toEqual([]);
  });

  it('returns rows on the to-read shelf', () => {
    const csv = [
      HDR,
      '"The Iliad",Homer,"Homer","","",-700,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)).toEqual([
      { title: 'The Iliad', author: 'Homer' },
    ]);
  });

  it('skips rows on other shelves (read, currently-reading, ...)', () => {
    const csv = [
      HDR,
      '"Read Book",Some Author,"Author, S.","","",2020,read',
      '"Want Book",Other Author,"Other, O.","","",2021,to-read',
      '"Reading Now",Now Author,"","","",2022,currently-reading',
    ].join('\n');
    const out = parseGoodreadsCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Want Book');
  });

  it('falls back to "Author l-f" when Author is empty', () => {
    const csv = [
      HDR,
      '"Foo","","Surname, First","","",2020,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)[0].author).toBe('Surname, First');
  });

  it('prefers ISBN13 over ISBN when both are present', () => {
    // Goodreads exports literal `="..."` in the cell, which in CSV is
    // wrapped in outer quotes with internal " doubled to "".
    const csv = [
      HDR,
      '"X",Y,"Y","=""0123456789""","=""9780123456789""",2020,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)[0].isbn).toBe('9780123456789');
  });

  it('strips the Goodreads ="..." escape from ISBN columns', () => {
    const csv = [
      HDR,
      '"X",Y,"Y","=""0123456789""","",2020,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)[0].isbn).toBe('0123456789');
  });

  it('parses a sensible Year Published as a number', () => {
    const csv = [
      HDR,
      '"X",Y,"Y","","",1949,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)[0].year).toBe(1949);
  });

  it('drops a year that is not a valid integer', () => {
    const csv = [
      HDR,
      '"X",Y,"Y","","",not-a-year,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)[0].year).toBeUndefined();
  });

  it('skips rows with no title', () => {
    const csv = [
      HDR,
      '"",Y,"Y","","",2020,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)).toEqual([]);
  });

  it('returns [] when the header is missing required columns', () => {
    const csv = ['Year,Notes', '2020,whatever'].join('\n');
    expect(parseGoodreadsCsv(csv)).toEqual([]);
  });

  it('handles CRLF line endings (the Goodreads export default)', () => {
    const csv = [HDR, '"Foo",A,"A","","",2020,to-read'].join('\r\n');
    expect(parseGoodreadsCsv(csv)).toEqual([
      { title: 'Foo', author: 'A', year: 2020 },
    ]);
  });

  it('handles a comma inside a quoted title', () => {
    const csv = [
      HDR,
      '"A, B and C","X","X","","",2020,to-read',
    ].join('\n');
    expect(parseGoodreadsCsv(csv)[0].title).toBe('A, B and C');
  });
});
