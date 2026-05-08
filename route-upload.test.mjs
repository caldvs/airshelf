import { describe, it, expect } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  MAX_FILENAME_LEN,
  validateUploadRequest,
} from './route-upload.js';

const SUPPORTED = ['.epub', '.azw3', '.mobi', '.pdf', '.txt'];

// Mirror the real isSafeBasename / isLoopback predicates closely enough
// that the validation contract is exercised without pulling in the full
// safety.js module here. The actual production code injects the real ones.
const isSafeBasename = (s) =>
  typeof s === 'string' &&
  s.length > 0 &&
  !s.includes('/') &&
  !s.includes('\\') &&
  s !== '..' &&
  s !== '.';

const isLoopback = (addr) =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

function call(overrides = {}) {
  return validateUploadRequest({
    method: 'POST',
    remoteAddress: '127.0.0.1',
    headers: { 'x-filename': 'book.epub', 'content-length': '1024' },
    supportedExtensions: SUPPORTED,
    isSafeBasename,
    isLoopback,
    ...overrides,
  });
}

describe('validateUploadRequest', () => {
  it('accepts a well-formed loopback POST with a supported extension', () => {
    const r = call();
    expect(r.ok).toBe(true);
    expect(r.filename).toBe('book.epub');
    expect(r.ext).toBe('.epub');
    expect(r.maxBytes).toBe(MAX_UPLOAD_BYTES);
  });

  it('rejects non-POST methods with 405', () => {
    expect(call({ method: 'GET' })).toEqual({
      ok: false,
      status: 405,
      message: 'Method not allowed.',
    });
    expect(call({ method: 'PUT' }).status).toBe(405);
  });

  it('rejects non-loopback callers with a stealth 404', () => {
    const r = call({ remoteAddress: '10.0.0.5' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.message).toBe('Not found');
  });

  it('non-loopback + non-POST stays a stealth 404 (does not leak route existence)', () => {
    // Loopback check must run before the method check; otherwise a LAN
    // caller could probe with GET and learn the route exists from the 405.
    expect(call({ remoteAddress: '10.0.0.5', method: 'GET' })).toEqual({
      ok: false,
      status: 404,
      message: 'Not found',
    });
    expect(call({ remoteAddress: '192.168.1.10', method: 'OPTIONS' }).status).toBe(404);
  });

  it('accepts ::1 and IPv4-mapped loopback addresses', () => {
    expect(call({ remoteAddress: '::1' }).ok).toBe(true);
    expect(call({ remoteAddress: '::ffff:127.0.0.1' }).ok).toBe(true);
  });

  it('rejects missing X-Filename with 400', () => {
    const r = call({ headers: { 'content-length': '1024' } });
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: 'Invalid or missing X-Filename header.',
    });
  });

  it('rejects empty X-Filename with 400', () => {
    expect(call({ headers: { 'x-filename': '', 'content-length': '1' } }).status).toBe(400);
  });

  it('rejects X-Filename exceeding MAX_FILENAME_LEN with 400', () => {
    const tooLong = 'a'.repeat(MAX_FILENAME_LEN + 1) + '.epub';
    expect(call({ headers: { 'x-filename': tooLong, 'content-length': '1' } }).status).toBe(400);
  });

  it('rejects an X-Filename that fails isSafeBasename (path traversal)', () => {
    expect(call({ headers: { 'x-filename': '../book.epub', 'content-length': '1' } }).status).toBe(400);
    expect(call({ headers: { 'x-filename': '..', 'content-length': '1' } }).status).toBe(400);
  });

  it('rejects unsupported extensions with 415', () => {
    expect(call({ headers: { 'x-filename': 'doc.docx', 'content-length': '1' } })).toEqual({
      ok: false,
      status: 415,
      message: 'Unsupported file format.',
    });
    expect(call({ headers: { 'x-filename': 'archive.zip', 'content-length': '1' } }).status).toBe(415);
  });

  it('extension match is case-insensitive', () => {
    const r = call({ headers: { 'x-filename': 'BOOK.EPUB', 'content-length': '1' } });
    expect(r.ok).toBe(true);
    expect(r.ext).toBe('.EPUB'); // raw case preserved in the returned ext
  });

  it('rejects an honest Content-Length above the cap with 413', () => {
    const overCap = String(MAX_UPLOAD_BYTES + 1);
    expect(call({ headers: { 'x-filename': 'book.epub', 'content-length': overCap } })).toEqual({
      ok: false,
      status: 413,
      message: 'Upload too large.',
    });
  });

  it('allows missing/non-numeric Content-Length (mid-stream cap is authoritative)', () => {
    expect(call({ headers: { 'x-filename': 'book.epub' } }).ok).toBe(true);
    expect(call({ headers: { 'x-filename': 'book.epub', 'content-length': 'abc' } }).ok).toBe(true);
  });
});
