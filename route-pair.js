// HTTP request handler for the short-code pairing flow (#34).
//
// `/pair/<CODE>` is the only path on the server that's hit *before* the
// /<token>/ auth gate. The user types it once on the Kindle off a 4-char
// code displayed by the Mac; the server validates the code, sets the long
// `airshelf_token` cookie, and 302s to the canonical `/<token>/` URL.
//
// Pure decision function — no Node `req`/`res` coupling — so the route is
// fully unit-testable without booting an Electron app or a real http.Server.
//
// Returns one of:
//   null                                          — not a pair URL, fall through
//   { match: true, ok: true, location, setCookie} — valid code, build a 302
//   { match: true, ok: false, status: 404 }       — bad code, 404 + recordFail
//
// Responsibilities deliberately kept narrow:
//   • path-shape match
//   • single-use code consumption via the supplied store
//   • build the redirect/cookie payload
//   • leave rate-limit + writeHead to the caller (mirrors route-auth.js)

const PAIR_PATH_RE = /^\/pair\/([^/]+)\/?$/;

function parsePairPath(pathname) {
  const m = pathname.match(PAIR_PATH_RE);
  return m ? { code: m[1] } : null;
}

function buildPairCookie(token) {
  // 1 year is well past the practical lifetime of the running app and
  // matches "rotate token to revoke" rather than "expire cookie
  // independently". HttpOnly because the renderer doesn't need cookie
  // access; SameSite=Lax so the redirect from /pair/<CODE> still
  // attaches the cookie on the followup request to /<token>/.
  return `airshelf_token=${token}; Max-Age=31536000; HttpOnly; SameSite=Lax; Path=/`;
}

function handlePairRequest({ pathname, pairStore, serverToken }) {
  const parsed = parsePairPath(pathname);
  if (!parsed) return null;
  if (!pairStore.consume(parsed.code)) {
    return { match: true, ok: false, status: 404 };
  }
  return {
    match: true,
    ok: true,
    location: `/${serverToken}/`,
    setCookie: buildPairCookie(serverToken),
  };
}

module.exports = {
  PAIR_PATH_RE,
  parsePairPath,
  buildPairCookie,
  handlePairRequest,
};
