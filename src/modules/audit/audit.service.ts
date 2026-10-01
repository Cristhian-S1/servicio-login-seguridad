import type { AuditRepository } from "./audit.repository";
import type { AuditEventType } from "./audit.types";

export interface RecordOptions {
  userId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  async record(type: AuditEventType, opts: RecordOptions = {}): Promise<void> {
    await this.repo.append({
      event_type: type,
      user_id: opts.userId ?? null,
      actor_ip: opts.ip ?? null,
      metadata: opts.metadata ?? {},
      occurred_at: new Date(),
    });
  }
}
