-- Exact, cross-isolate fixed-window admission counters. Keys contain no raw IPs.
CREATE TABLE usage_counters (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK (used > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX usage_expiry ON usage_counters(expires_at);
ALTER TABLE demo_sessions ADD COLUMN chat_retired_at TEXT;
CREATE INDEX session_retirement ON demo_sessions(chat_retired_at, expires_at);
