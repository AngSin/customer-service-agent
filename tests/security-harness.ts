import { commerceTools } from "../src/model";
import { getAgentByName } from "agents";
import { consumeBudget, chatBudget } from "../src/usage";
import { maintenance } from "../src/maintenance";
import {
  acceptRefund,
  processAttempt,
  reconcileAttempt,
  finalizeAttempt,
  markAttention,
  dispatchRefunds
} from "../shared/refunds";
import { sessionByHash } from "../shared/session";
// Internal test Worker only. None of these endpoints is bundled into deployment.
import {
  createProposal,
  decideApproval,
  acceptAction
} from "../shared/consent";
import {
  signSessionContext,
  MCP_URL,
  signContext
} from "../shared/mcp-context";
import { boundaryFailure } from "../src/boundary";
import { callCommerce, connectCommerce } from "../src/commerce-client";
import type { ToolName } from "../shared/commerce-contract";
import { runSessionProbe } from "../src/commerce-client";
export default {
  async fetch(
    request: Request,
    env: Env & { REFUNDS: import("../shared/refunds").RefundBinding }
  ) {
    const body = (await request.json()) as {
      hash: string;
      input: unknown;
      actionId: string;
      digest: string;
      decision: "approve" | "reject";
      offset?: number;
      fail?: boolean;
      kind?: string;
      name?: ToolName;
      workflowId?: string;
    };
    const clock = new Date(Date.now() + (body.offset ?? 0));
    try {
      const path = new URL(request.url).pathname;
      if (path === "/model-tool") {
        const execute = commerceTools(env, body.hash)[body.name!]?.execute;
        if (!execute) throw new Error("Missing tool");
        return Response.json(
          await execute(body.input, {
            toolCallId: crypto.randomUUID(),
            messages: [],
            context: {}
          })
        );
      }
      if (path === "/usage") {
        const input = body.input as {
          bucket: string;
          limit: number;
          seconds: number;
          now: number;
        };
        await consumeBudget(env.DB, input.bucket, input, input.now);
        return Response.json({ ok: true });
      }
      if (path === "/chat-budget") {
        const session = await sessionByHash(env.DB, body.hash);
        await chatBudget(env.DB, session.ns, session.expires_at);
        return Response.json({ ok: true });
      }
      if (path === "/maintenance") {
        await maintenance(env);
        return Response.json({ ok: true });
      }
      if (path === "/retire-chat") {
        const ns = (body.input as { ns: string }).ns;
        const stub = await getAgentByName(env.ChatAgent, ns);
        return Response.json({ retired: await stub.retireExpiredChat() });
      }
      if (path === "/real-dispatch") {
        await dispatchRefunds(env, body.workflowId);
        return Response.json({ ok: true });
      }
      if (path === "/refund-accept")
        return Response.json(
          await acceptRefund(
            env.DB,
            await sessionByHash(env.DB, body.hash),
            body.actionId
          )
        );
      if (path === "/refund-step") {
        const functions = {
          process: processAttempt,
          reconcile: reconcileAttempt,
          finalize: finalizeAttempt,
          attention: markAttention
        };
        return Response.json({
          outcome: await functions[body.kind as keyof typeof functions](
            env.DB,
            body.workflowId!
          )
        });
      }
      if (path === "/refund-dispatch") {
        const ids: string[] = [];
        await dispatchRefunds(
          {
            DB: env.DB,
            REFUNDS: {
              create: async ({ id }) => {
                ids.push(id);
                if (body.kind !== "success")
                  throw new Error("Simulated create response lost");
              },
              get: async (id) => ({
                status: async () => {
                  ids.push(id);
                  if (body.kind === "unavailable")
                    throw new Error("Not created");
                  return { status: "running" };
                }
              })
            }
          },
          body.workflowId
        );
        return Response.json({ ids });
      }
      if (path === "/tool")
        return Response.json(
          await callCommerce(
            {
              ...env,
              session: {
                db: env.DB,
                tokenHash: body.hash,
                ...(body.kind === "accept" ? { actionId: body.actionId } : {})
              }
            },
            body.name!,
            body.input
          )
        );
      if (path === "/catalog") {
        const client = await connectCommerce({
          ...env,
          session: { db: env.DB, tokenHash: body.hash }
        });
        try {
          return Response.json(
            (await client.listTools()).tools.map((t) => t.name)
          );
        } finally {
          await client.close();
        }
      }
      if (path === "/propose")
        return Response.json(
          await createProposal(env.DB, body.hash, body.input, clock)
        );
      if (path === "/decide")
        return Response.json(
          await decideApproval(
            env.DB,
            body.hash,
            body.actionId,
            body.digest,
            body.decision,
            clock
          )
        );
      if (path === "/accept")
        return Response.json(
          await acceptAction(
            env.DB,
            body.hash,
            body.actionId,
            body.digest,
            body.fail
              ? [
                  {
                    sql: "UPDATE orders SET version=version+1 WHERE ns='not-a-real-namespace'",
                    values: []
                  },
                  {
                    sql: "INSERT INTO data_assertions(ok) VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(ok) DO NOTHING",
                    values: []
                  }
                ]
              : [],
            clock
          )
        );
      if (path === "/probe")
        return Response.json(
          await runSessionProbe({
            ...env,
            session: { db: env.DB, tokenHash: body.hash }
          })
        );
      if (path === "/mcp") {
        let token =
          body.kind === "probe"
            ? await signContext(env)
            : await signSessionContext(
                env,
                env.DB,
                body.hash,
                body.kind === "mutation" ? "action:accept" : "session:read",
                body.actionId
              );
        if (
          body.kind === "tamper" ||
          body.kind === "forged-customer" ||
          body.kind === "expired"
        ) {
          const [payload] = token.split(".");
          const claims = JSON.parse(
            atob(payload!.replaceAll("-", "+").replaceAll("_", "/"))
          ) as Record<string, unknown>;
          if (body.kind === "forged-customer") claims.customer_id = "cus_bram";
          if (body.kind === "expired") {
            claims.iat = 0;
            claims.exp = 60;
          }
          const encoded = btoa(JSON.stringify(claims))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(
              body.kind === "tamper" ? "bad-key" : env.MCP_CONTEXT_KEY
            ),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
          );
          const sig = new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              key,
              new TextEncoder().encode(encoded)
            )
          );
          token = `${encoded}.${btoa(String.fromCharCode(...sig))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "")}`;
        }
        return env.COMMERCE_MCP.fetch(
          new Request(MCP_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`
            },
            body: "{}"
          })
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return boundaryFailure(error);
    }
  }
};
