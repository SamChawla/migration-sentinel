import { NextResponse } from "next/server";
import { credentialMatches, approverToken, SESSION_COOKIE_NAME, USER_COOKIE_NAME } from "@/lib/auth";

/**
 * Single-approver login. The submitted token must equal APPROVER_TOKEN; only
 * then is an httpOnly session cookie issued. The approval gate is still enforced
 * server-side in core/gate.ts — this only controls who can reach the endpoints.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const token = (body as { token?: unknown; password?: unknown }).token ?? (body as { password?: unknown }).password;
  const username = (body as { username?: unknown }).username;

  if (!approverToken()) {
    return NextResponse.json({ error: "Auth not configured (APPROVER_TOKEN unset)." }, { status: 503 });
  }
  if (!credentialMatches(token)) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const name = typeof username === "string" && username.trim() ? username.trim() : "approver";
  const res = NextResponse.json({ ok: true, user: name });
  const cookieOpts = { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 7 };
  res.cookies.set(SESSION_COOKIE_NAME, encodeURIComponent(String(token)), cookieOpts);
  res.cookies.set(USER_COOKIE_NAME, encodeURIComponent(name), cookieOpts);
  return res;
}
