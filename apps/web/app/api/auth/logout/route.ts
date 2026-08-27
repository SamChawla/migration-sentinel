import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, USER_COOKIE_NAME } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Clear BOTH the auth session and the display cookie — clearing only the
  // display cookie would leave the request still authenticated.
  res.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  res.cookies.set(USER_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
