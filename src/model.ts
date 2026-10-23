import { budgets, consumeBudget, UsageLimit } from "./usage";
import { sessionByHash } from "../shared/session";
import { createAI } from "agents/models/ai-sdk";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool, dynamicTool } from "ai";
import { z } from "zod";
import {
  descriptions,
  inputs,
  type ToolName
} from "../shared/commerce-contract";
import { callCommerce } from "./commerce-client";
import { runMilestoneProbe, runSessionProbe } from "./commerce-client";

export const LLAMA_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

export function fakeModel(commerce = false) {
  const choice = (prompt: unknown) => {
    if (!commerce) return { name: "milestone_ping", input: "{}" };
    const user = (prompt as { role: string; content: unknown }[])
      .slice()
      .reverse()
      .find((p) => p.role === "user");
    const text = JSON.stringify(user?.content ?? "").toLowerCase();
    const order = /ord_[0-9]+/.exec(text)?.[0] ?? "ord_101";
    if (/refund/.test(text)) {
      const refund = /ref_[0-9]+/.exec(text)?.[0];
      if (refund)
        return {
          name: "get_refund_status",
          input: JSON.stringify({ refund_id: refund })
        };
      return {
        name: "refund_order",
        input: JSON.stringify({ order_id: order })
      };
    }
    if (/cancel/.test(text))
      return {
        name: "cancel_order",
        input: JSON.stringify({ order_id: order })
      };
    if (/orders|previous/.test(text))
      return { name: "list_customer_orders", input: "{}" };
    if (/ord_[0-9]+/.test(text))
      return { name: "get_order", input: JSON.stringify({ order_id: order }) };
    return { name: "get_customer_profile", input: "{}" };
  };
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const hasResult = prompt.at(-1)?.role === "tool";
      return {
        content: hasResult
          ? [
              {
                type: "text",
                text: commerce
                  ? "Shop request checked. Review the verified result or approval card below."
                  : "Private connection verified. No commerce mutations are available."
              }
            ]
          : [
              {
                type: "tool-call",
                toolCallId: "probe-1",
                toolName: choice(prompt).name,
                input: choice(prompt).input
              }
            ],
        finishReason: {
          unified: hasResult ? "stop" : "tool-calls",
          raw: undefined
        },
        usage,
        warnings: []
      };
    },
    doStream: async ({ prompt }) => {
      const hasResult = prompt.at(-1)?.role === "tool";
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(hasResult
              ? [
                  { type: "text-start" as const, id: "reply" },
                  {
                    type: "text-delta" as const,
                    id: "reply",
                    delta: commerce
                      ? "Shop request checked. Review the verified result or approval card below."
                      : "Private connection verified. No commerce mutations are available."
                  },
                  { type: "text-end" as const, id: "reply" }
                ]
              : [
                  {
                    type: "tool-call" as const,
                    toolCallId: "probe-1",
                    toolName: choice(prompt).name,
                    input: choice(prompt).input
                  }
                ]),
            {
              type: "finish",
              finishReason: {
                unified: hasResult ? "stop" : "tool-calls",
                raw: undefined
              },
              usage
            }
          ],
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      };
    }
  });
}

export function selectModel(
  env: Pick<Env, "MODEL_MODE" | "AI">,
  commerce = false
) {
  if (env.MODEL_MODE === "fake") return fakeModel(commerce);
  if (env.MODEL_MODE === "workers-ai")
    return createAI({ binding: env.AI })(LLAMA_MODEL);
  throw new Error("Unsupported model mode");
}

export function milestoneTools(env: Env, sessionHash?: string) {
  return {
    milestone_ping: tool({
      description:
        "Read the private MCP/shared D1 transport probe. No business action.",
      inputSchema: z.strictObject({}),
      execute: async () =>
        sessionHash
          ? runSessionProbe({
              ...env,
              session: { db: env.DB, tokenHash: sessionHash }
            })
          : runMilestoneProbe(env)
    })
  };
}

export function commerceTools(env: Env, sessionHash: string) {
  let calls = 0;
  return Object.fromEntries(
    (Object.keys(inputs) as ToolName[]).map((name) => [
      name,
      dynamicTool({
        description: descriptions[name],
        inputSchema: inputs[name],
        execute: async (args) => {
          try {
            if (++calls > 20) throw new UsageLimit(60);
            const session = await sessionByHash(env.DB, sessionHash, true);
            await consumeBudget(env.DB, `tools:${session.ns}`, {
              ...budgets.toolsSession,
              expiresAt: Math.ceil(
                new Date(session.expires_at).getTime() / 1000
              )
            });
            await consumeBudget(env.DB, "tools-global", budgets.toolsDaily);
            return await callCommerce(
              { ...env, session: { db: env.DB, tokenHash: sessionHash } },
              name,
              args
            );
          } catch (error) {
            return {
              ok: false,
              error: {
                code:
                  error instanceof UsageLimit
                    ? "USAGE_LIMIT"
                    : "TEMPORARILY_UNAVAILABLE",
                message:
                  error instanceof UsageLimit
                    ? `Demo tool usage limit reached. Try again in ${error.retryAfter} seconds.`
                    : "The shop service is temporarily unavailable. Please retry.",
                retryable: true
              },
              request_id: crypto.randomUUID()
            };
          }
        }
      })
    ])
  );
}
