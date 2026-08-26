/**
 * Single-approver auth (hackathon). The approval gate itself is enforced in
 * core/gate.ts against the database of record; this layer only decides WHO may
 * reach the mutating endpoints. A valid session is one whose httpOnly cookie
 * carries the configured APPROVER_TOKEN.
 */
import { cookies } from "next/headers";

const SESSION_COOKIE = "ms_session";
const USER_COOKIE = "ms_auth";

export function approverToken(): string {
  return process.env.APPROVER_TOKEN ?? "";
}

/** Timing-safe-ish constant comparison (small inputs; avoids early-exit leak). */
export function credentialMatches(candidate: unknown): boolean {
  const token = approverToken();
  if (!token) return false; // no token configured → nobody is authorized
  if (typeof candidate !== "string" || candidate.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= candidate.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export interface Session {
  user: string;
}

/** decodeURIComponent that never throws — a malformed percent-encoding in a
 *  request-controlled cookie (e.g. a bare "%") must produce an unauthenticated
 *  result, not a URIError that 500s every protected page/API for that client. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Returns the authenticated approver, or null if the request has no valid session. */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  const session = raw != null ? safeDecode(raw) : null;
  if (session === null || !credentialMatches(session)) return null;
  const userRaw = jar.get(USER_COOKIE)?.value;
  const user = userRaw != null ? safeDecode(userRaw) : null;
  return { user: user || "approver" };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const USER_COOKIE_NAME = USER_COOKIE;
