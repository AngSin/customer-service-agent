import { z } from "zod";
import {
  assertion,
  executeBatch,
  namespaceStatements,
  sha256,
  type Statement
} from "./fixtures";

export const personas = [
  { id: "ada", name: "Ada" },
  { id: "bram", name: "Brad" },
  { id: "cora", name: "Cora" },
  { id: "dax", name: "Dax" },
  { id: "elin", name: "Elin" },
  { id: "fenn", name: "Fenn" }
] as const;
export const personaSchema = z.enum([
  "ada",
  "bram",
  "cora",
  "dax",
  "elin",
  "fenn"
]);
export const SESSION_COOKIE = "__Host-csa_session";
export const CSRF_COOKIE = "__Host-csa_csrf";
export class BoundaryError extends Error {
  constructor(
    public code: string,
    public status = 403
  ) {
    super(code);
  }
}
export interface Session {
  ns: string;
  token_hash: string;
  customer_id: string;
  chat_name: string;
  approval_epoch: number;
  mutation_enabled: number;
  expires_at: string;
  provisioning_state: string;
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
export function cookie(request: Request, name: string) {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function setCookie(name: string, value: string) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400`;
}
export function requireOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = `${url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol}//${url.host}`;
  if (request.headers.get("Origin") !== origin)
    throw new BoundaryError("INVALID_ORIGIN");
}
export function requireCsrf(request: Request) {
  requireOrigin(request);
  const token = cookie(request, CSRF_COOKIE);
  if (!token || request.headers.get("X-CSRF-Token") !== token)
    throw new BoundaryError("INVALID_CSRF");
}
export async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new BoundaryError("INVALID_ARGUMENT", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new BoundaryError("INVALID_ARGUMENT", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      throw new BoundaryError("INVALID_ARGUMENT", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BoundaryError("INVALID_ARGUMENT", 400);
  }
}
export async function sessionByHash(
  db: D1Database,
  hash: string,
  active = false,
  now = new Date().toISOString()
) {
  const session = await db
    .prepare(
      "SELECT ns,token_hash,customer_id,chat_name,approval_epoch,mutation_enabled,expires_at,provisioning_state FROM demo_sessions WHERE token_hash = ? AND expires_at > ? AND provisioning_state = 'ready'"
    )
    .bind(hash, now)
    .first<Session>();
  if (!session) throw new BoundaryError("UNAUTHENTICATED", 401);
  if (active && !session.mutation_enabled)
    throw new BoundaryError("SESSION_REVOKED");
  return session;
}
export async function authenticate(
  request: Request,
  db: D1Database,
  active = false
) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) throw new BoundaryError("UNAUTHENTICATED", 401);
  return sessionByHash(db, await sha256(token), active);
}
export function sessionView(session: Session) {
  return {
    persona: session.customer_id.slice(4),
    name: personas.find((p) => `cus_${p.id}` === session.customer_id)?.name,
    chatName: session.chat_name,
    active: !!session.mutation_enabled
  };
}
function sessionAudit(ns: string, event: string, now: string): Statement {
  return {
    sql: "INSERT INTO audit_events(ns,event_id,actor_type,event_type,outcome,occurred_at) VALUES (?,?,'system',?,'ok',?)",
    values: [ns, crypto.randomUUID(), event, now]
  };
}
export async function createSession(
  db: D1Database,
  persona: z.infer<typeof personaSchema>,
  now = new Date()
) {
  const token = randomToken();
  const ns = `ns_${crypto.randomUUID().replaceAll("-", "")}`;
  const statements = await namespaceStatements({
    ns,
    customerId: `cus_${persona}`,
    tokenHash: await sha256(token),
    chatName: ns,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86400000).toISOString()
  });
  statements.push(
    {
      sql: "UPDATE demo_sessions SET mutation_enabled = 1 WHERE ns = ?",
      values: [ns]
    },
    sessionAudit(ns, "session_created", now.toISOString())
  );
  await executeBatch(db, statements);
  return { token, session: await sessionByHash(db, await sha256(token)) };
}
async function replacementToken(
  secret: string,
  oldToken: string,
  requestKey: string
) {
  if (secret.length < 32) throw new Error("Signing is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`session-replacement:${oldToken}:${requestKey}`)
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
export async function replaceSession(
  db: D1Database,
  oldToken: string,
  persona: z.infer<typeof personaSchema>,
  requestKey: string,
  secret: string,
  now = new Date()
) {
  const old = await sessionByHash(db, await sha256(oldToken));
  // A replay after the browser has already installed the successor cookie.
  const parent = await db
    .prepare(
      "SELECT persona FROM session_replacements WHERE new_ns = ? AND request_key = ?"
    )
    .bind(old.ns, requestKey)
    .first<{ persona: string }>();
  if (parent) {
    if (parent.persona !== persona)
      throw new BoundaryError("ACTION_CONFLICT", 409);
    return { token: oldToken, session: old };
  }
  const token = await replacementToken(secret, oldToken, requestKey);
  const tokenHash = await sha256(token);
  const replay = async () => {
    const existing = await db
      .prepare(
        "SELECT request_key,persona,new_ns FROM session_replacements WHERE old_ns = ?"
      )
      .bind(old.ns)
      .first<{ request_key: string; persona: string; new_ns: string }>();
    if (
      !existing ||
      existing.request_key !== requestKey ||
      existing.persona !== persona
    )
      throw new BoundaryError("ACTION_CONFLICT", 409);
    const session = await sessionByHash(db, tokenHash);
    if (session.ns !== existing.new_ns)
      throw new BoundaryError("ACTION_CONFLICT", 409);
    return { token, session };
  };
  if (!old.mutation_enabled) return replay();
  const ns = `ns_${crypto.randomUUID().replaceAll("-", "")}`;
  const statements: Statement[] = [
    {
      sql: "UPDATE demo_sessions SET mutation_enabled = 0, approval_epoch = approval_epoch + 1 WHERE ns = ? AND mutation_enabled = 1 AND replaced_by IS NULL AND expires_at > ?",
      values: [old.ns, now.toISOString()]
    },
    assertion("changes() = 1"),
    ...(await namespaceStatements({
      ns,
      customerId: `cus_${persona}`,
      tokenHash,
      chatName: ns,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString()
    })),
    {
      sql: "UPDATE demo_sessions SET mutation_enabled = 1 WHERE ns = ?",
      values: [ns]
    },
    {
      sql: "UPDATE demo_sessions SET replaced_by = ? WHERE ns = ?",
      values: [ns, old.ns]
    },
    {
      sql: "INSERT INTO audit_events(ns,event_id,action_id,actor_type,event_type,outcome,action_digest,occurred_at) SELECT ns,? || '_' || action_id,action_id,'system','revoked','ok',digest,? FROM approvals WHERE ns=? AND consumed_at IS NULL AND revoked_at IS NULL ON CONFLICT(ns,action_id,event_type,attempt_number) DO NOTHING",
      values: [crypto.randomUUID(), now.toISOString(), old.ns]
    },
    {
      sql: "UPDATE approvals SET revoked_at = ? WHERE ns = ? AND consumed_at IS NULL AND revoked_at IS NULL",
      values: [now.toISOString(), old.ns]
    },
    {
      sql: "INSERT INTO session_replacements(old_ns,request_key,persona,new_ns,created_at) VALUES (?,?,?,?,?)",
      values: [old.ns, requestKey, persona, ns, now.toISOString()]
    },
    sessionAudit(old.ns, "session_replaced", now.toISOString()),
    sessionAudit(ns, "session_created", now.toISOString())
  ];
  try {
    await executeBatch(db, statements);
  } catch (error) {
    const existing = await db
      .prepare("SELECT old_ns FROM session_replacements WHERE old_ns = ?")
      .bind(old.ns)
      .first();
    if (existing) return replay();
    throw error;
  }
  return { token, session: await sessionByHash(db, tokenHash) };
}
