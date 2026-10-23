import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
  descriptions,
  inputs,
  outputSchema
} from "../shared/commerce-contract";
import { executeBatch, namespaceStatements, sha256 } from "../shared/fixtures";
import { jsonBody, randomToken, type Session } from "../shared/session";
import { boundaryFailure } from "./boundary";
import { callCommerce } from "./commerce-client";
import { budgets, consumeBudget, requestBudget, UsageLimit } from "./usage";

// Optional secret: absent means the public endpoint is disabled. Never reuse
// MCP_CONTEXT_KEY here; that key continues to authenticate only private traffic.
type PublicEnv = Env & { PUBLIC_MCP_TOKEN?: string };
const readTools = [
  "get_order",
  "list_customer_orders",
  "get_customer_profile",
  "get_refund_status"
] as const;

async function publicSession(env: Env, credentialHash: string) {
  const now = new Date();
  const day = Math.floor(now.getTime() / 86400000);
  // A stable namespace per credential/day makes provisioning race-safe using
  // existing unique constraints. Public data resets at midnight UTC.
  const ns = `public_${(await sha256(`${credentialHash}:${day}`)).slice(0, 48)}`;
  const find = () =>
    env.DB.prepare(
      "SELECT token_hash,expires_at FROM demo_sessions WHERE ns=? AND customer_id='cus_ada' AND mutation_enabled=0 AND provisioning_state='ready' AND expires_at>?"
    )
      .bind(ns, now.toISOString())
      .first<Pick<Session, "token_hash" | "expires_at">>();
  const existing = await find();
  if (existing) return existing;
  const statements = await namespaceStatements({
    ns,
    customerId: "cus_ada",
    tokenHash: await sha256(randomToken()),
    chatName: ns,
    createdAt: now.toISOString(),
    expiresAt: new Date((day + 1) * 86400000).toISOString()
  });
  try {
    // mutation_enabled stays zero; no browser session token is issued.
    await executeBatch(env.DB, statements);
  } catch (error) {
    // Another request can win the atomic insert. Only suppress that race if
    // its complete, read-only namespace is now available.
    const winner = await find();
    if (winner) return winner;
    throw error;
  }
  const session = await find();
  if (!session) throw new Error("Public session unavailable");
  return session;
}

export async function publicMcp(
  request: Request,
  env: PublicEnv,
  ctx: ExecutionContext
) {
  const expected = env.PUBLIC_MCP_TOKEN;
  if (!expected) return new Response("Not found", { status: 404 });
  const supplied = /^Bearer ([a-f0-9]{64})$/i.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1];
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    !supplied ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="commerce-mcp"',
          "Cache-Control": "no-store"
        }
      }
    );
  }
  try {
    await requestBudget(request, env);
    const credentialHash = await sha256(expected);
    await consumeBudget(
      env.DB,
      `public-mcp-http:${credentialHash}`,
      budgets.requests
    );
    if (request.method === "POST") {
      // Bound streamed bodies too, before the MCP SDK parses them.
      request = new Request(request, {
        body: JSON.stringify(await jsonBody(request))
      });
    }
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({
          name: "public-commerce",
          version: "1.0.0"
        });
        for (const name of readTools) {
          server.registerTool(
            name,
            {
              description: descriptions[name],
              inputSchema: inputs[name],
              outputSchema: outputSchema(name),
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false
              }
            },
            async (args: unknown) => {
              try {
                await consumeBudget(
                  env.DB,
                  `public-mcp-tools:${credentialHash}`,
                  budgets.toolsSession
                );
                await consumeBudget(env.DB, "tools-global", budgets.toolsDaily);
                const session = await publicSession(env, credentialHash);
                const result = await callCommerce(
                  {
                    ...env,
                    session: { db: env.DB, tokenHash: session.token_hash }
                  },
                  name,
                  args
                );
                return {
                  isError: !result.ok,
                  structuredContent: result,
                  content: [
                    { type: "text" as const, text: JSON.stringify(result) }
                  ]
                };
              } catch (error) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text" as const,
                      text:
                        error instanceof UsageLimit
                          ? "Public tool usage limit reached. Try again later."
                          : "Shop temporarily unavailable."
                    }
                  ]
                };
              }
            }
          );
        }
        return server;
      },
      { corsOptions: false }
    );
    const response = await handler(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return boundaryFailure(error);
  }
}
