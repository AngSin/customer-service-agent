import { z } from "zod";
import { sessionByHash } from "./session";

export const MCP_URL = "https://commerce-mcp.internal/mcp";
export const PROBE_SUBJECT = "milestone-1-probe";

const probeClaimsSchema = z.strictObject({
  iss: z.literal("customer-service-agent"),
  aud: z.string(),
  sub: z.literal(PROBE_SUBJECT),
  scope: z.literal("milestone:read"),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.uuid()
});
const sessionClaimsSchema = z.strictObject({
  iss: z.literal("customer-service-agent"),
  aud: z.string(),
  kid: z.literal("v1"),
  sid: z.string(),
  namespace_id: z.string(),
  customer_id: z.string(),
  approval_epoch: z.number().int().positive(),
  scope: z.enum(["session:read", "action:accept"]),
  action_id: z.string().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.uuid()
});
const claimsSchema = z.union([probeClaimsSchema, sessionClaimsSchema]);

export interface ContextConfig {
  MCP_CONTEXT_KEY: string;
  MCP_AUDIENCE: string;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid context");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  );
}

async function key(config: ContextConfig) {
  if (!config.MCP_CONTEXT_KEY || config.MCP_CONTEXT_KEY.length < 32) {
    throw new Error("MCP context signing is not configured");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.MCP_CONTEXT_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signContext(
  config: ContextConfig,
  now = Math.floor(Date.now() / 1000)
): Promise<string> {
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: "customer-service-agent",
        aud: config.MCP_AUDIENCE,
        sub: PROBE_SUBJECT,
        scope: "milestone:read",
        iat: now,
        exp: now + 60,
        jti: crypto.randomUUID()
      })
    )
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(config),
    new TextEncoder().encode(payload)
  );
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyContext(request: Request, config: ContextConfig) {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ") || header.length > 2048)
    throw new Error("Invalid context");
  const parts = header.slice(7).split(".");
  if (parts.length !== 2) throw new Error("Invalid context");
  const [payload, signature] = parts;
  const verified = await crypto.subtle.verify(
    "HMAC",
    await key(config),
    decode(signature),
    new TextEncoder().encode(payload)
  );
  if (!verified) throw new Error("Invalid context");
  const claims = claimsSchema.parse(
    JSON.parse(new TextDecoder().decode(decode(payload)))
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.aud !== config.MCP_AUDIENCE ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 60
  )
    throw new Error("Invalid context");
  return claims;
}

export async function signSessionContext(
  config: ContextConfig,
  db: D1Database,
  hash: string,
  scope: "session:read" | "action:accept" = "session:read",
  actionId?: string
) {
  const session = await sessionByHash(db, hash, scope === "action:accept");
  const now = Math.floor(Date.now() / 1000);
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: "customer-service-agent",
        aud: config.MCP_AUDIENCE,
        kid: "v1",
        sid: session.ns,
        namespace_id: session.ns,
        customer_id: session.customer_id,
        approval_epoch: session.approval_epoch,
        scope,
        ...(actionId ? { action_id: actionId } : {}),
        iat: now,
        exp: now + 60,
        jti: crypto.randomUUID()
      })
    )
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(config),
    new TextEncoder().encode(payload)
  );
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifySessionContext(
  request: Request,
  config: ContextConfig,
  db: D1Database
) {
  const claims = await verifyContext(request, config);
  if (claims.scope === "milestone:read") {
    if (config.MCP_AUDIENCE !== "commerce-mcp:local")
      throw new Error("Invalid context");
    return claims;
  }
  const session = await db
    .prepare(
      "SELECT token_hash FROM demo_sessions WHERE ns=? AND customer_id=? AND approval_epoch=?"
    )
    .bind(claims.namespace_id, claims.customer_id, claims.approval_epoch)
    .first<{ token_hash: string }>();
  if (!session || claims.sid !== claims.namespace_id)
    throw new Error("Invalid context");
  await sessionByHash(db, session.token_hash, claims.scope === "action:accept");
  if (claims.scope === "action:accept") {
    if (!claims.action_id) throw new Error("Invalid context");
    const action = await db
      .prepare(
        "SELECT a.action_id FROM mutation_actions a JOIN approvals p ON p.ns=a.ns AND p.action_id=a.action_id WHERE a.ns=? AND a.customer_id=? AND a.action_id=? AND a.approval_epoch=? AND p.approval_epoch=a.approval_epoch AND p.digest=a.digest AND p.approved_at IS NOT NULL AND p.consumed_at IS NULL AND p.revoked_at IS NULL AND p.rejected_at IS NULL AND p.expires_at>?"
      )
      .bind(
        claims.namespace_id,
        claims.customer_id,
        claims.action_id,
        claims.approval_epoch,
        new Date().toISOString()
      )
      .first();
    if (!action) throw new Error("Invalid context");
  }
  return claims;
}
