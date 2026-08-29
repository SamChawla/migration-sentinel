import { redirect } from "next/navigation";
import { demoOpenAccess } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

// Server component: the open-access redirect is decided from the SERVER-only
// runtime flag (DEMO_OPEN_ACCESS) — the same source of truth the dashboard uses
// to authorize unauthenticated visitors. Deciding it here, rather than from the
// build-time public flag (NEXT_PUBLIC_DEMO_OPEN_ACCESS), prevents a /login ⇄
// /dashboard redirect loop when the two flags disagree (e.g. a runtime disable
// during a partial rollout), which would otherwise make the form unreachable.
//
// force-dynamic: without it this route is statically prerendered and the env
// read freezes at build time — a stale build would redirect (or not) forever,
// reintroducing the loop against the always-dynamic (app) layout.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (demoOpenAccess()) redirect("/dashboard");
  return <LoginForm />;
}
