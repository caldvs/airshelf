const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Constant-time compare for the server token. timingSafeEqual throws on
// length mismatch, so we check length first ourselves.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Persist a 128-bit hex token to userData; reuse across launches so the user
// doesn't need to re-enter the URL on the Kindle every time. File mode 0600
// since possession of this token = full LAN access to the library.
function loadOrCreateServerToken(userData) {
  const tokenFile = path.join(userData, 'server-token');
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tokenFile, t, { mode: 0o600 });
  return t;
}

module.exports = { tokensMatch, loadOrCreateServerToken };
