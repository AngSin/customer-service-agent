import { BoundaryError } from "../shared/session";
import { sha256 } from "../shared/fixtures";

// Application budgets, not Cloudflare plan limits. Fixed windows use server time.
export const budgets = {
  requests: { limit: 180, seconds: 60 },
  sessions: { limit: 10, seconds: 3600 },
  sessionsDaily: { limit: 200, seconds: 86400 },
  chatMinute: { limit: 12, seconds: 60 },
  chatSession: { limit: 40, seconds: 86400 },
  chatDaily: { limit: 500, seconds: 86400 },
  frames: { limit: 120, seconds: 60 },
  toolsSession: { limit: 160, seconds: 86400 },
  toolsDaily: { limit: 2000, seconds: 86400 }
} as const;
export class UsageLimit extends BoundaryError {
  constructor(public retryAfter: number) {
    super("USAGE_LIMIT", 429);
  }
}
export async function consumeBudget(
  db: D1Database,
  bucket: string,
  policy: { limit: number; seconds: number; expiresAt?: number },
  now = Date.now()
) {
  const seconds = Math.floor(now / 1000);
  const start = policy.expiresAt
    ? 0
    : Math.floor(seconds / policy.seconds) * policy.seconds;
  const end = policy.expiresAt ?? start + policy.seconds;
  // One statement serializes concurrent admission; denied calls do not increment.
  const admitted = await db
    .prepare(
      "INSERT INTO usage_counters(bucket,window_start,used,expires_at) VALUES (?,?,1,?) ON CONFLICT(bucket,window_start) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used"
    )
    .bind(bucket, start, end, policy.limit)
    .first<{ used: number }>();
  if (!admitted) {
    console.warn(
      JSON.stringify({ event: "usage_denied", scope: bucket.split(":")[0] })
    );
    throw new UsageLimit(Math.max(1, end - seconds));
  }
}
export async function requestBudget(request: Request, env: Env) {
  // CF-Connecting-IP is supplied by Cloudflare, never trust X-Forwarded-For.
  // Local requests without that header deliberately share a conservative bucket.
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const day = Math.floor(Date.now() / 86400000);
  const key = await sha256(`${env.MCP_CONTEXT_KEY}:usage:${day}:${ip}`);
  await consumeBudget(env.DB, `http:${key}`, budgets.requests);
  return key;
}
export async function sessionBudget(db: D1Database, ipKey: string) {
  await consumeBudget(db, `sessions:${ipKey}`, budgets.sessions);
  await consumeBudget(db, "sessions-global", budgets.sessionsDaily);
}
export async function chatBudget(
  db: D1Database,
  ns: string,
  expiresAt: string
) {
  await consumeBudget(db, `chat-minute:${ns}`, budgets.chatMinute);
  // Session TTL is 24 hours; use a single non-resetting bucket for its lifetime.
  await consumeBudget(db, `chat-session:${ns}`, {
    limit: budgets.chatSession.limit,
    seconds: 86400,
    expiresAt: Math.ceil(new Date(expiresAt).getTime() / 1000)
  });
  await consumeBudget(db, "chat-global", budgets.chatDaily);
}
