import { randomUUID } from "node:crypto";
import type { Db } from "../../shared/db/pool";
import type { AuditRepository } from "./audit.repository";
import type { AuditEventInput } from "./audit.types";

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly db: Db) {}

  async append(event: AuditEventInput): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events (id, event_type, user_id, actor_ip, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), event.event_type, event.user_id, event.actor_ip, JSON.stringify(event.metadata), event.occurred_at],
    );
  }
}
