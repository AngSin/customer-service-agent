import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import {
  MCP_URL,
  signContext,
  type ContextConfig
} from "../shared/mcp-context";
import { probeSchema, readProbeMarker } from "../shared/probe";

export interface CommerceConnection extends ContextConfig {
  COMMERCE_MCP: Pick<Fetcher, "fetch">;
}

export function bindingFetch(env: CommerceConnection): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== MCP_URL) throw new Error("Unexpected MCP destination");
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    // A binding does not synthesize Host like a public HTTP connection does.
    headers.set("Host", new URL(MCP_URL).host);
    headers.set("Authorization", `Bearer ${await signContext(env)}`);
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
