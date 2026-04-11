-- Multi-Agent Workbench — user settings key/value store (v0.1.x)
--
-- Generic per-user key → JSON value store so we can persist UI state
-- (dashboard layout, future preferences) without a new migration per setting.
--
-- First consumer: `dashboard.layout.v1` holds the gridstack positions of the
-- agent cards as `{ "layout": [{ "agentId": "...", "x": 0, "y": 0, "w": 4, "h": 3 }, ...] }`.

CREATE TABLE user_settings (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
