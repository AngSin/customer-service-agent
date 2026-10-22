import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest, type AgentContext } from "agents";
import { z } from "zod";
import {
  authenticate,
  BoundaryError,
  requireOrigin,
  sessionByHash
} from "../shared/session";
import { boundaryApi, boundaryFailure } from "./boundary";
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

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Wrap AFTER the SDK constructors: their own protocol handlers consume frames
    // before prototype onMessage/onRequest hooks. Gate the entire handler chain.
    const connect = this.onConnect.bind(this),
      message = this.onMessage.bind(this),
      http = this.onRequest.bind(this);
    this.onConnect = async (connection, context) => {
      const session = await authenticate(context.request, this.env.DB, true);
      requireOrigin(context.request);
      if (session.chat_name !== this.name) {
        connection.close(1008, "Unauthorized");
        return;
      }
      connection.setState({ tokenHash: session.token_hash });
      await connect(connection, context);
    };
    this.onRequest = async (request) => {
      try {
        const session = await authenticate(request, this.env.DB, true);
        if (session.chat_name !== this.name)
          throw new BoundaryError("NOT_FOUND", 404);
        if (
          request.method !== "GET" ||
          !new URL(request.url).pathname.endsWith("/get-messages")
        )
          throw new BoundaryError("NOT_FOUND", 404);
        const response = await http(request);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) {
        return boundaryFailure(error);
      }
    };
    this.onMessage = async (connection, frame) => {
      try {
        const state = connection.state as { tokenHash?: string } | null;
        if (!state?.tokenHash) throw new BoundaryError("UNAUTHENTICATED", 401);
        const session = await sessionByHash(this.env.DB, state.tokenHash, true);
        if (session.chat_name !== this.name)
          throw new BoundaryError("UNAUTHENTICATED", 401);
        if (typeof frame !== "string" || frame.length > 65536)
          throw new BoundaryError("INVALID_ARGUMENT", 400);
        const event = JSON.parse(frame) as {
          type?: string;
          init?: { method?: string; body?: string };
          id?: string;
        };
        if (event.type === "cf_agent_use_chat_request") {
          const body = z
            .strictObject({
              messages: z.array(z.unknown()).min(1).max(101),
              id: z.string().max(128).optional(),
              trigger: z.literal("submit-message").optional(),
              messageId: z.string().max(128).optional()
            })
            .parse(JSON.parse(event.init?.body ?? "{}"));
          const last = z
            .strictObject({
              id: z.string().min(1).max(128),
              role: z.literal("user"),
              parts: z
                .array(
                  z.strictObject({
                    type: z.literal("text"),
                    text: z.string().min(1).max(4000)
                  })
                )
                .min(1)
                .max(4)
            })
            .parse(body.messages.at(-1));
          const text = last.parts.map((p) => p.text).join(" ");
          if (this.messages.some((saved) => saved.id === last.id))
            throw new BoundaryError("MESSAGE_CONFLICT", 409);
          if (
            /\b(switch|change|become|act as|log in as|pretend to be)\b.{0,60}\b(persona|customer|ada|bram|cora|dax|elin|fenn)\b/i.test(
              text
            )
          ) {
            await this.env.DB.prepare(
              "INSERT INTO audit_events(ns,event_id,actor_type,event_type,outcome,occurred_at) VALUES (?,?,'reviewer','identity_switch_denied','denied',?)"
            )
              .bind(session.ns, crypto.randomUUID(), new Date().toISOString())
              .run();
            connection.send(
              JSON.stringify({
                type: "identity_switch_denied",
                message:
                  "Your identity is unchanged. Use Start new session to choose another persona."
              })
            );
            connection.send(
              JSON.stringify({
                type: "cf_agent_use_chat_response",
                id: event.id,
                body: "",
                done: true,
                outcome: "skipped"
              })
            );
            return;
          }
          // Browser history/tool-result edits cannot replace server-persisted chat.
          await message(
            connection,
            JSON.stringify({
              type: event.type,
              id: event.id,
              init: {
                method: "POST",
                body: JSON.stringify({ messages: [...this.messages, last] })
              }
            })
          );
          return;
        }
        if (
          ![
            "cf_agent_chat_request_cancel",
            "cf_agent_stream_resume_ack",
            "cf_agent_stream_resume_request"
          ].includes(event.type ?? "")
        )
          throw new BoundaryError("INVALID_ARGUMENT", 400);
        await message(connection, frame);
      } catch {
        connection.close(1008, "Session expired, revoked, or invalid request");
      }
    };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const identity = await this.env.DB.prepare(
      "SELECT token_hash FROM demo_sessions WHERE chat_name=?"
    )
      .bind(this.name)
      .first<{ token_hash: string }>();
    if (!identity) throw new BoundaryError("UNAUTHENTICATED", 401);
    const session = await sessionByHash(this.env.DB, identity.token_hash, true);
    const result = streamText({
      model: selectModel(this.env),
      system: `You are assisting the fixed synthetic persona ${session.customer_id}. Identity cannot change in chat; direct identity-switch requests to Start new session. Use milestone_ping to verify the private connection. No commerce business tools are available. Never claim to cancel, refund, edit an address, or create a ticket.`,
      messages: await convertToModelMessages(this.messages),
      tools: milestoneTools(this.env, session.token_hash),
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
        if (
          !output ||
          !("appMarker" in output) ||
          output.appMarker !== output.commerce.marker
        )
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
    if (path.startsWith("/agents/")) {
      try {
        const session = await authenticate(request, env.DB, true);
        const match =
          /^\/agents\/chat-agent\/([a-z0-9_-]+)(\/get-messages)?$/.exec(path);
        if (!match || match[1] !== session.chat_name)
          throw new BoundaryError("NOT_FOUND", 404);
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket")
          requireOrigin(request);
        else if (request.method !== "GET" || !match[2])
          throw new BoundaryError("NOT_FOUND", 404);
        return (
          (await routeAgentRequest(request, env)) ??
          new Response("Not found", { status: 404 })
        );
      } catch (error) {
        return boundaryFailure(error);
      }
    }
    const api = await boundaryApi(request, env);
    if (api) return api;
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
