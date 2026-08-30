import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { DeckShell } from "@/components/deck/DeckShell";
import { getDashboardStats } from "@sentinel/db/queries";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Validate the real session (ms_session === APPROVER_TOKEN), not the display
  // cookie — a forged display cookie must not grant access to the console.
  const session = await getSession();
  if (!session) redirect("/login");

  const stats = await getDashboardStats();
  const pending = stats.awaiting;
  return (
    <DeckShell pendingCount={pending} userName={session.user}>
      {children}
    </DeckShell>
  );
}
