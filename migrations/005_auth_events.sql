-- Multi-Agent Workbench — security hardening (v0.1.x)
--
-- Adds an append-only auth event log (for in-app audit + fail2ban source)
-- and two bootstrap-password columns on users so first-login can be
-- redirected to /account until the operator rotates the seeded password.

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_updated_at INTEGER;

CREATE TABLE auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  event      TEXT    NOT NULL,
  user_id    TEXT,
  username   TEXT,
  ip         TEXT,
  user_agent TEXT,
  detail     TEXT
);

CREATE INDEX idx_auth_events_ts ON auth_events(ts);
CREATE INDEX idx_auth_events_ip_ts ON auth_events(ip, ts);
