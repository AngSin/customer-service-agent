import { createAI } from "agents/models/ai-sdk";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { runMilestoneProbe, runSessionProbe } from "./commerce-client";

export const LLAMA_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

export function fakeModel() {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const hasResult = prompt.at(-1)?.role === "tool";
      return {
        content: hasResult
          ? [
              {
                type: "text",
                text: "Private connection verified. No commerce mutations are available."
              }
            ]
          : [
              {
                type: "tool-call",
                toolCallId: "probe-1",
                toolName: "milestone_ping",
                input: "{}"
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
                    delta:
                      "Private connection verified. No commerce mutations are available."
                  },
                  { type: "text-end" as const, id: "reply" }
                ]
              : [
                  {
                    type: "tool-call" as const,
                    toolCallId: "probe-1",
                    toolName: "milestone_ping",
                    input: "{}"
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

export function selectModel(env: Pick<Env, "MODEL_MODE" | "AI">) {
  if (env.MODEL_MODE === "fake") return fakeModel();
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
