/** Shared domain types. Mirror the DB enums in 04-DB-Schema / @sentinel/db. */

export type RequestStatus =
  | "received"
  | "generating"
  | "reviewing"
  | "dry_running"
  | "awaiting_approval"
  | "blocked"
  | "approved"
  | "rejected"
  | "applying"
  | "applied"
  | "rolled_back"
  | "failed";

export type IntakeKind = "nl_intent" | "raw_sql" | "github_pr";
export type Reversibility = "reversible" | "lossy" | "irreversible";
export type Severity = "green" | "amber" | "red";
export type RunStatus = "pending" | "running" | "succeeded" | "failed";
export type QodoVerdict = "passed" | "passed_with_warnings" | "failed" | "skipped";
export type ApprovalDecision = "pending" | "approved" | "rejected";

export interface IntakePayload {
  sql?: string;
  intent?: string;
  pr?: { url: string; repo: string; file: string };
}
