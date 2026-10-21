CREATE TABLE IF NOT EXISTS milestone_probe (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO milestone_probe (id, value) VALUES ('shared', 'milestone-1-local-d1')
ON CONFLICT(id) DO NOTHING;
