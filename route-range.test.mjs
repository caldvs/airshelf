import { describe, it, expect } from 'vitest';
import { parseRangeHeader } from './route-range.js';

describe('parseRangeHeader', () => {
  it('returns null when there is no Range header', () => {
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader('', 1000)).toBeNull();
  });

  it('returns null on a malformed Range header (caller falls back to 200)', () => {
    expect(parseRangeHeader('byets=0-100', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc-100', 1000)).toBeNull();
    expect(parseRangeHeader('items=0-100', 1000)).toBeNull();
  });

  it('parses a closed range and returns inclusive [start, end]', () => {
    const r = parseRangeHeader('bytes=0-99', 1000);
    expect(r).toEqual({
      status: 206,
      start: 0,
      end: 99,
      headers: {
        'Content-Range': 'bytes 0-99/1000',
        'Content-Length': 100,
      },
    });
  });

  it('treats an open-ended range (no end) as "to EOF"', () => {
    const r = parseRangeHeader('bytes=500-', 1000);
    expect(r).toEqual({
      status: 206,
      start: 500,
      end: 999,
      headers: {
        'Content-Range': 'bytes 500-999/1000',
        'Content-Length': 500,
      },
    });
  });

  it('clamps a requested end past EOF down to size-1', () => {
    const r = parseRangeHeader('bytes=900-99999', 1000);
    expect(r.end).toBe(999);
    expect(r.headers['Content-Range']).toBe('bytes 900-999/1000');
    expect(r.headers['Content-Length']).toBe(100);
  });

  it('returns 416 when start is past EOF', () => {
    const r = parseRangeHeader('bytes=1000-', 1000);
    expect(r).toEqual({
      status: 416,
      headers: { 'Content-Range': 'bytes */1000' },
    });
  });

  it('returns 416 when start equals size (one past last valid byte)', () => {
    const r = parseRangeHeader('bytes=1000-2000', 1000);
    expect(r.status).toBe(416);
  });

  it('returns 416 when end < start (backwards range)', () => {
    const r = parseRangeHeader('bytes=500-100', 1000);
    expect(r).toEqual({
      status: 416,
      headers: { 'Content-Range': 'bytes */1000' },
    });
  });

  it('handles a single-byte range', () => {
    const r = parseRangeHeader('bytes=42-42', 1000);
    expect(r).toEqual({
      status: 206,
      start: 42,
      end: 42,
      headers: {
        'Content-Range': 'bytes 42-42/1000',
        'Content-Length': 1,
      },
    });
  });

  it('matches the first range in a multi-range header (matches the prior inline regex)', () => {
    const r = parseRangeHeader('bytes=0-100,200-300', 1000);
    expect(r.status).toBe(206);
    expect(r.start).toBe(0);
    expect(r.end).toBe(100);
  });

  it('still rejects headers that do not start with bytes=', () => {
    expect(parseRangeHeader('garbage bytes=0-100', 1000)).toBeNull();
  });
});
