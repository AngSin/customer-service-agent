import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  streamText
} from "ai";
import { LLAMA_MODEL, milestoneTools, selectModel } from "./model";
import { runMilestoneProbe } from "./commerce-client";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const result = streamText({
      model: selectModel(this.env),
      system:
        "This is a transport-only milestone. Use milestone_ping to check the private MCP binding. No commerce actions are available.",
      messages: await convertToModelMessages(this.messages),
      tools: milestoneTools(this.env),
      stopWhen: stepCountIs(3),
      abortSignal: options?.abortSignal
    });
    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (
      env.APP_STAGE === "local" &&
      env.MODEL_MODE === "workers-ai" &&
      path === "/api/milestone/live"
    ) {
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      try {
        const result = await generateText({
          model: selectModel(env),
          prompt:
            "Call milestone_ping once with an empty object to verify the private transport.",
          tools: milestoneTools(env),
          toolChoice: { type: "tool", toolName: "milestone_ping" },
          stopWhen: stepCountIs(1),
          abortSignal: AbortSignal.timeout(60000)
        });
        const toolResult = result.toolResults[0];
        if (
          !toolResult ||
          toolResult.dynamic ||
          toolResult.toolName !== "milestone_ping"
        ) {
          throw new Error("Live model did not call the probe");
        }
        const output = toolResult.output;
        if (!output || output.appMarker !== output.commerce.marker)
          throw new Error("Live tool call did not complete");
        return Response.json({
          model: LLAMA_MODEL,
          tool: "milestone_ping",
          sharedD1: true
        });
      } catch {
        return Response.json(
          { error: "Live model smoke failed" },
          { status: 503 }
        );
      }
    }
    // This synthetic probe is local-only, not a session or commerce API.
    if (env.APP_STAGE === "local" && path === "/api/milestone/probe") {
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      try {
        return Response.json(await runMilestoneProbe(env));
      } catch (error) {
        console.error(
          "Local milestone probe failed",
          error instanceof Error ? error.message : "Unknown error"
        );
        return Response.json(
          { error: "Milestone probe unavailable" },
          { status: 503 }
        );
      }
    }
    // Public sessions/authorization are Milestone 3. Do not expose arbitrary
    // agent names or callable methods from the starter in demo.
    if (env.APP_STAGE === "local" && path.startsWith("/agents/")) {
      return (
        (await routeAgentRequest(request, env)) ??
        new Response("Not found", { status: 404 })
      );
    }
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
