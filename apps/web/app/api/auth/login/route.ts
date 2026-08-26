import { NextResponse } from "next/server";

/**
 * DEMO auth — accepts any credentials (default admin / admin).
 * Real deployments replace this with APPROVER_TOKEN / SSO; the approval gate
 * itself is enforced server-side in core/gate.ts, never by this cookie.
 */
export async function POST(req: Request) {
  const { username } = await req.json().catch(() => ({ username: "admin" }));
  const name = typeof username === "string" && username.trim() ? username.trim() : "admin";
  const res = NextResponse.json({ ok: true, user: name });
  res.cookies.set("ms_auth", encodeURIComponent(name), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
