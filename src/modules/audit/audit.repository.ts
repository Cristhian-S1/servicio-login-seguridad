import type { AuditEventInput } from "./audit.types";

export type { AuditEventInput };

export interface AuditRepository {
  append(event: AuditEventInput): Promise<void>;
}
