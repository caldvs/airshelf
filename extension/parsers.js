// Pure parsers shared by popup.js and the test file. Plain ES module
// (`<script type="module">`) so the popup can import directly and
// vitest can import via the .js suffix without a build step.

// Loopback HTTP only (port 6790 baked in). Matches the extension's
// `host_permissions`. Tightened from the initial `https?://...:any-port`
// pattern after a Copilot review on #73.
export const URL_RE = /^(http:\/\/(?:127\.0\.0\.1|localhost):6790)\/([a-z]{6})\/?$/;

export function parseKindleUrl(input) {
  const m = (input || '').trim().match(URL_RE);
  if (!m) return null;
  return { base: m[1], token: m[2] };
}

// Mirrors the server's `isSafeBasename` filter so we don't waste an
// upload on a name that's about to be 400'd. Lowercases the extension
// for the allowlist check (Airshelf accepts mixed-case extensions but
// we keep the exact filename for Content-Disposition).
const ALLOWED_EXTS = new Set(['.epub', '.mobi', '.azw3', '.pdf', '.txt']);
const UNSAFE_RE = /[/\\\0]|^\.\.?$|^\s|\s$/;

function safeBasename(name) {
  // Replace path separators / NUL with _ so we never produce a name the
  // server will refuse outright.
  return name.replace(/[/\\\0]/g, '_');
}

// Strip query/hash, take the path basename, decode it, and pin .pdf if
// the URL had no extension. Capped at 200 chars to keep the eventual
// X-Filename header well under any reasonable limit.
const MAX_FILENAME = 200;

export function deriveFilename(url, fallback = 'page.pdf') {
  let last;
  try {
    const u = new URL(url);
    last = u.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return fallback;
  }
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep raw */ }
  if (!decoded) return fallback;
  decoded = safeBasename(decoded).trim();
  if (!decoded || UNSAFE_RE.test(decoded)) return fallback;
  if (decoded.length > MAX_FILENAME) decoded = decoded.slice(0, MAX_FILENAME);
  // Keep the URL extension if it's already an allowed ebook format;
  // otherwise tag .pdf so the upload route accepts the file.
  const m = /\.([a-z0-9]{2,5})$/i.exec(decoded);
  if (m && ALLOWED_EXTS.has(`.${m[1].toLowerCase()}`)) return decoded;
  return decoded + '.pdf';
}

// Convert an unknown thrown value to a useful error message string.
// chrome.runtime can throw plain strings or objects; catch (e) shouldn't
// dereference e.message blindly.
export function errorMessage(e) {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
