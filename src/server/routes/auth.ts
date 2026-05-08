// HTTP request authentication for the loopback book server.
//
// Every legitimate request looks like `/<6-lowercase-token>/<sub-path>`. This
// module pairs URL parsing with the existing FailedAuthLimiter + tokensMatch
// helpers so the server's auth path can be unit-tested without booting an
// Electron app or a real http.Server.
//
// Returns one of:
//   { allow: true,  subPath, ip }            — request OK, hand `subPath` to the router
//   { allow: false, status: 404, reason }    — block with a stealth 404
//
// Responsibilities deliberately kept narrow:
//   • path-shape check (regex)
//   • token comparison via the supplied tokensMatch (constant-time)
//   • rate-limit the IP via the supplied limiter
//   • return a non-tokenised request as a 404 (no 401) so the server is
//     indistinguishable from no server at all to a port-scan.

export const TOKEN_PATH_RE = /^\/([a-z]{6})(\/.*)?$/;

export interface ParsedTokenPath {
  token: string;
  subPath: string;
}

export function parseTokenPath(pathname: string): ParsedTokenPath | null {
  const m = pathname.match(TOKEN_PATH_RE);
  if (!m) return null;
  return { token: m[1], subPath: m[2] || '/' };
}

interface RateLimiter {
  isBlocked(ip: string): boolean;
  recordFail(ip: string): void;
  recordSuccess(ip: string): void;
}

interface AuthoriseArgs {
  pathname: string;
  ip: string;
  expectedToken: string;
  limiter: RateLimiter;
  tokensMatch: (a: unknown, b: unknown) => boolean;
}

export type AuthoriseResult =
  | { allow: true; subPath: string; ip: string }
  | { allow: false; status: 404; reason: 'rate-limited' | 'no-token' | 'bad-token' };

export function authoriseRequest({
  pathname,
  ip,
  expectedToken,
  limiter,
  tokensMatch,
}: AuthoriseArgs): AuthoriseResult {
  if (limiter.isBlocked(ip)) {
    return { allow: false, status: 404, reason: 'rate-limited' };
  }
  const parsed = parseTokenPath(pathname);
  if (!parsed) {
    limiter.recordFail(ip);
    return { allow: false, status: 404, reason: 'no-token' };
  }
  if (!tokensMatch(parsed.token, expectedToken)) {
    limiter.recordFail(ip);
    return { allow: false, status: 404, reason: 'bad-token' };
  }
  limiter.recordSuccess(ip);
  return { allow: true, subPath: parsed.subPath, ip };
}
