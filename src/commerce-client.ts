import {
  outputSchema,
  type CommerceResult,
  type ToolName
} from "../shared/commerce-contract";
import { BoundaryError } from "../shared/session";
import { ownedAction, recordDenial } from "../shared/consent";
import { sessionByHash } from "../shared/session";
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import {
  MCP_URL,
  signContext,
  signSessionContext,
  type ContextConfig
} from "../shared/mcp-context";
import { probeSchema, readProbeMarker } from "../shared/probe";

export interface CommerceConnection extends ContextConfig {
  COMMERCE_MCP: Pick<Fetcher, "fetch">;
  session?: { db: D1Database; tokenHash: string; actionId?: string };
}

export function bindingFetch(env: CommerceConnection): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== MCP_URL) throw new Error("Unexpected MCP destination");
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    // A binding does not synthesize Host like a public HTTP connection does.
    headers.set("Host", new URL(MCP_URL).host);
    headers.set(
      "Authorization",
      `Bearer ${env.session ? await signSessionContext(env, env.session.db, env.session.tokenHash, env.session.actionId ? "action:accept" : "session:read", env.session.actionId) : await signContext(env)}`
    );
    const response = await env.COMMERCE_MCP.fetch(
      new Request(request, { headers, redirect: "manual" })
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("MCP redirects are not allowed");
    }
    return response;
  };
}

export async function runSessionProbe(env: CommerceConnection) {
  if (!env.session) throw new Error("Session required");
  const result = await callCommerce(env, "get_customer_profile", {});
  if (!result.ok) throw new Error("Session probe failed");
  return {
    marker: "session-authorized",
    subject: "milestone-1-probe" as const
  };
}

export async function callCommerce(
  env: CommerceConnection,
  name: ToolName,
  args: unknown
): Promise<CommerceResult> {
  const client = await connectCommerce(env);
  try {
    const result = await client.callTool({
      name,
      arguments: args as Record<string, unknown>
    });
    if (result.isError && !result.structuredContent) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "The supplied fields are invalid.",
          retryable: false
        },
        request_id: crypto.randomUUID()
      };
    }
    return outputSchema(name).parse(result.structuredContent) as CommerceResult;
  } finally {
    await client.close();
  }
}

export async function executeApprovedAction(
  env: Env,
  hash: string,
  actionId: string
) {
  try {
    const session = await sessionByHash(env.DB, hash);
    const action = await ownedAction(env.DB, session, actionId);
    if (!["accepted", "completed"].includes(action.state)) {
      if (!session.mutation_enabled) throw new BoundaryError("SESSION_REVOKED");
      if (action.revoked_at) throw new BoundaryError("APPROVAL_REVOKED");
      if (action.expires_at <= new Date().toISOString())
        throw new BoundaryError("APPROVAL_EXPIRED", 409);
      if (!action.approved_at || action.rejected_at || action.consumed_at)
        throw new BoundaryError("APPROVAL_REQUIRED", 409);
    }
    const payload = JSON.parse(action.arguments_json) as { arguments: unknown };
    return callCommerce(
      { ...env, session: { db: env.DB, tokenHash: hash, actionId } },
      action.tool as ToolName,
      payload.arguments
    );
  } catch (error) {
    await recordDenial(env.DB, hash, "execution_denied", error);
    throw error;
  }
}

export async function connectCommerce(env: CommerceConnection) {
  const client = new Client(
    { name: "milestone-1-app", version: "1.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: bindingFetch(env),
    requestInit: { redirect: "manual" }
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function runMilestoneProbe(
  env: CommerceConnection & { DB: D1Database }
) {
  const client = await connectCommerce(env);
  try {
    const catalog = await client.listTools();
    const result = await client.callTool({
      name: "milestone_ping",
      arguments: {}
    });
    if (result.isError) throw new Error("Commerce probe failed");
    return {
      appMarker: await readProbeMarker(env.DB),
      commerce: probeSchema.parse(result.structuredContent),
      tools: catalog.tools.map((tool) => tool.name)
    };
  } finally {
    await client.close();
  }
}
