import { getAgentByName } from "agents";
// Retain immutable commerce/audit/processor evidence. Retire only chat state;
// unresolved work pins its namespace and remains available to refund repair.
export async function maintenance(
  env: Pick<Env, "DB" | "ChatAgent">,
  now = Date.now()
) {
  const seconds = Math.floor(now / 1000);
  const removed = await env.DB.prepare(
    "DELETE FROM usage_counters WHERE rowid IN (SELECT rowid FROM usage_counters WHERE expires_at < ? ORDER BY expires_at LIMIT 500)"
  )
    .bind(seconds)
    .run();
  const cutoff = new Date(now - 7 * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT s.chat_name FROM demo_sessions s
     WHERE s.chat_retired_at IS NULL AND s.expires_at < ?
     AND s.ns LIKE 'ns_%'
     AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.ns=s.ns AND r.status='pending')
     AND NOT EXISTS (SELECT 1 FROM refund_attempts a WHERE a.ns=s.ns AND a.execution_state NOT IN ('completed','failed'))
     AND NOT EXISTS (SELECT 1 FROM mutation_actions a WHERE a.ns=s.ns AND a.state='accepted')
     ORDER BY s.expires_at LIMIT 20`
  )
    .bind(cutoff)
    .all<{ chat_name: string }>();
  let retired = 0;
  for (const row of results) {
    try {
      const stub = await getAgentByName(env.ChatAgent, row.chat_name);
      if (await stub.retireExpiredChat()) retired++;
    } catch {
      console.error(JSON.stringify({ event: "chat_retirement_failed" }));
    }
  }
  console.log(
    JSON.stringify({
      event: "maintenance",
      countersRemoved: removed.meta.changes,
      chatsRetired: retired
    })
  );
}
