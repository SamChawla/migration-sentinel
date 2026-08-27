"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const TERMINAL = new Set(["applied", "failed", "rejected", "rolled_back", "blocked"]);

/**
 * Polls the server component back to life while a request is still in flight, so
 * the console reflects generating → dry_running → awaiting_approval → applied
 * without a manual reload. Stops once the status is terminal.
 */
export function AutoRefresh({ status, intervalMs = 2000 }: { status: string; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (TERMINAL.has(status)) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [status, intervalMs, router]);
  return null;
}
