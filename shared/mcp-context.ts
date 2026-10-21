import { z } from "zod";

export const MCP_URL = "https://commerce-mcp.internal/mcp";
export const PROBE_SUBJECT = "milestone-1-probe";

const claimsSchema = z.strictObject({
  iss: z.literal("customer-service-agent"),
  aud: z.string(),
  sub: z.literal(PROBE_SUBJECT),
  scope: z.literal("milestone:read"),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.uuid()
});

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
