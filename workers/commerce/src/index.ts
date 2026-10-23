export { RefundWorkflow } from "./refund-workflow";
import { dispatchRefunds } from "../../../shared/refunds";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  MCP_URL,
  PROBE_SUBJECT,
  verifySessionContext
} from "../../../shared/mcp-context";
import { commerceCall } from "../../../shared/commerce";
import {
  descriptions,
  inputs,
  mutations,
  outputSchema,
  type ToolName
} from "../../../shared/commerce-contract";
import { probeSchema, readProbeMarker } from "../../../shared/probe";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: CommerceEnv,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(dispatchRefunds(env));
  },
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
        if (identity.scope !== "milestone:read") {
          for (const name of Object.keys(inputs) as ToolName[]) {
            server.registerTool(
              name,
              {
                description: descriptions[name],
                inputSchema: inputs[name],
                outputSchema: outputSchema(name),
                annotations: {
                  readOnlyHint: !mutations.has(name),
                  destructiveHint: mutations.has(name),
                  openWorldHint: false
                }
              },
              async (args: unknown) => {
                const bound = await env.DB.prepare(
                  "SELECT token_hash FROM demo_sessions WHERE ns=? AND customer_id=?"
                )
                  .bind(identity.namespace_id, identity.customer_id)
                  .first<{ token_hash: string }>();
                const result = await commerceCall(
                  env.DB,
                  env.MCP_CONTEXT_KEY,
                  bound!.token_hash,
                  name,
                  args,
                  identity.scope === "action:accept"
                    ? identity.action_id
                    : undefined
                );
                if (
                  name === "refund_order" &&
                  result.ok &&
                  result.data.action_id
                ) {
                  const dispatch = await env.DB.prepare(
                    "SELECT workflow_instance_id FROM workflow_dispatches WHERE ns=? AND action_id=?"
                  )
                    .bind(
                      identity.namespace_id,
                      result.data.action_id as string
                    )
                    .first<{ workflow_instance_id: string }>();
                  if (dispatch)
                    ctx.waitUntil(
                      dispatchRefunds(env, dispatch.workflow_instance_id)
                    );
                }
                return {
                  isError: !result.ok,
                  structuredContent: result,
                  content: [
                    { type: "text" as const, text: JSON.stringify(result) }
                  ]
                };
              }
            );
          }
        } else
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
