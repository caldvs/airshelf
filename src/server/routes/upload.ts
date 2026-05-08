// Pre-stream validation for `POST /<token>/upload` (#37).
//
// The streaming/disk-write side stays in main.js — it's tightly coupled to
// the Node `req`/`res` streams and the addBook closure — but every check
// that runs *before* we open the tmp file lives here, where it can be
// unit-tested without booting the server.
//
// validateUploadRequest() is a pure decision function. It does NOT mutate
// the limiter, write headers, or open files — the caller does that based
// on the returned shape:
//
//   { ok: true,  filename, ext, maxBytes }
//   { ok: false, status, message }
//
// 1 GiB cap matches the on-the-wire limit enforced mid-stream in main.js;
// keeping the constant here so the two checks can't drift.

import { extname } from 'path';

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const MAX_FILENAME_LEN = 255;

interface ValidateUploadArgs {
  method: string | undefined;
  remoteAddress: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  supportedExtensions: readonly string[];
  isSafeBasename: (name: unknown) => boolean;
  isLoopback: (addr: string | undefined) => boolean;
}

export type UploadValidationResult =
  | { ok: true; filename: string; ext: string; maxBytes: number }
  | { ok: false; status: number; message: string };

export function validateUploadRequest({
  method,
  remoteAddress,
  headers,
  supportedExtensions,
  isSafeBasename,
  isLoopback,
}: ValidateUploadArgs): UploadValidationResult {
  // Loopback gate runs FIRST and applies regardless of method, so a LAN
  // caller can't probe the route's existence by sending a non-POST and
  // observing a 405 vs. nothing. Stealth 404 matches the rest of the
  // server's "no service here" posture.
  if (!isLoopback(remoteAddress)) {
    return { ok: false, status: 404, message: 'Not found' };
  }
  if (method !== 'POST') {
    return { ok: false, status: 405, message: 'Method not allowed.' };
  }
  const filename = (headers['x-filename'] || '').toString();
  if (!filename || filename.length > MAX_FILENAME_LEN || !isSafeBasename(filename)) {
    return { ok: false, status: 400, message: 'Invalid or missing X-Filename header.' };
  }
  const ext = extname(filename);
  if (!supportedExtensions.includes(ext.toLowerCase())) {
    return { ok: false, status: 415, message: 'Unsupported file format.' };
  }
  // Content-Length is advisory — clients can lie. The mid-stream byte
  // counter in main.js is the authoritative cap. We still reject up front
  // when an *honest* declaration exceeds the cap so we don't bother
  // opening a stream we'll abort within milliseconds.
  const declaredLength = parseInt(String(headers['content-length'] ?? ''), 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, message: 'Upload too large.' };
  }
  return { ok: true, filename, ext, maxBytes: MAX_UPLOAD_BYTES };
}
