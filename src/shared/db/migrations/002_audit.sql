CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  actor_ip text NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_events_user_time_idx ON audit_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events (event_type);
