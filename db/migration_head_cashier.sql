-- Run this ONCE against an EXISTING cafe_pos database.
-- It is needed because PostgreSQL Docker init scripts only run on first database initialization.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK(role IN ('CASHIER','HEAD_CASHIER','WAREHOUSE','ADMIN'));

INSERT INTO users(username,password_hash,display_name,role)
VALUES ('headcashier','demo','Head Cashier','HEAD_CASHIER')
ON CONFLICT (username) DO UPDATE
SET display_name = EXCLUDED.display_name,
    role = EXCLUDED.role;

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_ref TEXT,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
