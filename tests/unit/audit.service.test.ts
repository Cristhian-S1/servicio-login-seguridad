import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/modules/audit/audit.service";
import type { AuditEventInput, AuditRepository } from "../../src/modules/audit/audit.repository";

function fakeRepo() {
  const events: AuditEventInput[] = [];
  const repo: AuditRepository = {
    append: vi.fn(async (e: AuditEventInput) => {
      events.push(e);
    }),
  };
  return { repo, events };
}

describe("AuditService.record", () => {
  it("appends the event with occurred_at set", async () => {
    const { repo, events } = fakeRepo();
    const svc = new AuditService(repo);
    await svc.record("login_failure", { ip: "1.2.3.4", metadata: { reason: "bad password" } });
    expect(repo.append).toHaveBeenCalledOnce();
    expect(events[0].event_type).toBe("login_failure");
    expect(events[0].user_id).toBeNull();
    expect(events[0].occurred_at).toBeInstanceOf(Date);
  });
});
