import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DeckShell } from "@/components/deck/DeckShell";
import { getDashboardStats } from "@sentinel/db/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const session = jar.get("ms_auth");
  if (!session) redirect("/login");

  const stats = await getDashboardStats();
  return (
    <DeckShell pendingCount={stats.awaiting} userName={decodeURIComponent(session?.value ?? "") || "Demo Admin"}>
      {children}
    </DeckShell>
  );
}
