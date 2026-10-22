-- Replay-safe session replacement: only one successor per original session.
CREATE TABLE session_replacements (
  old_ns TEXT PRIMARY KEY NOT NULL REFERENCES demo_sessions(ns),
  request_key TEXT NOT NULL,
  persona TEXT NOT NULL,
  new_ns TEXT NOT NULL UNIQUE REFERENCES demo_sessions(ns),
  created_at TEXT NOT NULL
);
CREATE TRIGGER replacement_immutable BEFORE UPDATE ON session_replacements
BEGIN SELECT RAISE(ABORT, 'Session replacement is immutable'); END;

-- Approval INSERT must not bypass the consume/decision update guards.
CREATE TRIGGER approval_initial_decision BEFORE INSERT ON approvals
WHEN NEW.approved_at IS NOT NULL OR NEW.rejected_at IS NOT NULL
  OR NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Approval must begin undecided'); END;
