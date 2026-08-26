/**
 * Append-only audit trail (TR-6). The concrete writer is injected by the app
 * (it owns the DB handle); core just defines the contract so every layer emits
 * the same shape.
 */
export interface AuditEvent {
  migrationRequestId: string | null;
  actor: string; // 'agent' | approver id | 'system'
  action: string; // 'received' | 'generated' | 'gate_opened' | 'approved' | 'applied' | ...
  payload?: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => Promise<void>;

/** No-op sink for tests / local dev. */
export const consoleAuditSink: AuditSink = async (e) => {
  // eslint-disable-next-line no-console
  console.log(`[audit] ${e.actor} ${e.action}`, e.payload ?? {});
};
