export type AuditEventType =
  | "register"
  | "login_success"
  | "login_failure"
  | "refresh"
  | "refresh_reuse_detected"
  | "mfa_enabled"
  | "mfa_success"
  | "mfa_failure";

export interface AuditEventInput {
  event_type: AuditEventType;
  user_id: string | null;
  actor_ip: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}
