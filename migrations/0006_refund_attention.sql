-- Preserve unknown outcomes without mislabelling them as failed or authorizing a retry.
ALTER TABLE refund_attempts ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0,1));
