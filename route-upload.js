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
// 1 GB cap matches the on-the-wire limit enforced mid-stream in main.js;
// keeping the constant here so the two checks can't drift.

const path = require('path');

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB
const MAX_FILENAME_LEN = 255;

function validateUploadRequest({
  method,
  remoteAddress,
  headers,
  supportedExtensions,
  isSafeBasename,
  isLoopback,
}) {
  if (method !== 'POST') {
    return { ok: false, status: 405, message: 'Method not allowed.' };
  }
  if (!isLoopback(remoteAddress)) {
    // Stealth 404 to match the rest of the server's "no service here"
    // posture; LAN attackers shouldn't be able to discover that this
    // route exists at all.
    return { ok: false, status: 404, message: 'Not found' };
  }
  const filename = (headers['x-filename'] || '').toString();
  if (!filename || filename.length > MAX_FILENAME_LEN || !isSafeBasename(filename)) {
    return { ok: false, status: 400, message: 'Invalid or missing X-Filename header.' };
  }
  const ext = path.extname(filename);
  if (!supportedExtensions.includes(ext.toLowerCase())) {
    return { ok: false, status: 415, message: 'Unsupported file format.' };
  }
  // Content-Length is advisory — clients can lie. The mid-stream byte
  // counter in main.js is the authoritative cap. We still reject up front
  // when an *honest* declaration exceeds the cap so we don't bother
  // opening a stream we'll abort within milliseconds.
  const declaredLength = parseInt(headers['content-length'], 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, message: 'Upload too large.' };
  }
  return { ok: true, filename, ext, maxBytes: MAX_UPLOAD_BYTES };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_FILENAME_LEN,
  validateUploadRequest,
};
