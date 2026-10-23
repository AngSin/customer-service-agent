-- Aggregate operational checks. No tokens, prompts, addresses or ticket text.
SELECT provisioning_state, mutation_enabled, count(*) AS sessions
FROM demo_sessions GROUP BY provisioning_state, mutation_enabled;
SELECT count(*) AS active_sessions FROM demo_sessions
WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now');
SELECT count(*) AS retired_chats FROM demo_sessions WHERE chat_retired_at IS NOT NULL;
SELECT status, count(*) AS refunds FROM refunds GROUP BY status;
SELECT execution_state, needs_attention, count(*) AS attempts
FROM refund_attempts GROUP BY execution_state, needs_attention;
SELECT state, count(*) AS dispatches, max(retry_count) AS max_retries
FROM workflow_dispatches GROUP BY state;
SELECT substr(bucket,1,instr(bucket || ':',':')-1) AS scope,
  sum(used) AS admitted, count(*) AS windows
FROM usage_counters WHERE expires_at >= unixepoch()
GROUP BY scope;
PRAGMA foreign_key_check;
