import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  MCP_URL,
  PROBE_SUBJECT,
  verifySessionContext
} from "../../../shared/mcp-context";
import { probeSchema, readProbeMarker } from "../../../shared/probe";

export default {
  async fetch(request: Request, env: CommerceEnv, ctx: ExecutionContext) {
    if (request.url !== MCP_URL)
      return new Response("Not found", { status: 404 });
    let identity;
    try {
      identity = await verifySessionContext(request, env, env.DB);
    } catch {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({
          name: "commerce-milestone-1",
          version: "1.0.0"
        });
        server.registerTool(
          "milestone_ping",
          {
            description:
              "Read the synthetic Milestone 1 shared-database marker. No business actions.",
            inputSchema: z.strictObject({}),
            outputSchema: probeSchema,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false
            }
          },
          async () => {
            try {
              const result = {
                marker:
                  identity.scope === "milestone:read"
                    ? await readProbeMarker(env.DB)
                    : "session-authorized",
                subject: PROBE_SUBJECT
              };
              return {
                structuredContent: result,
                content: [{ type: "text", text: JSON.stringify(result) }]
              };
            } catch {
              return {
                isError: true,
                content: [
                  { type: "text", text: "Probe temporarily unavailable" }
                ]
              };
            }
          }
        );
        return server;
      },
      { corsOptions: false, allowedHostnames: ["commerce-mcp.internal"] }
    );
    return handler(request, env, ctx);
  }
} satisfies ExportedHandler<CommerceEnv>;
