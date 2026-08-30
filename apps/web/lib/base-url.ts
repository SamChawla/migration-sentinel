/**
 * The PUBLIC base URL of this console, for links that leave the app (verdict
 * comments and exported-PR reports on public GitHub PRs). The server's own
 * origin is http://localhost:3000 in dev and an internal host behind a proxy in
 * prod, so prefer the configured APP_BASE_URL and fall back to the request
 * origin only for local use. No trailing slash.
 */
export function publicBaseUrl(req: Request): string {
  return process.env.APP_BASE_URL?.trim().replace(/\/+$/, "") || new URL(req.url).origin;
}
