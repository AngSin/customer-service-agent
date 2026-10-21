// Test-only Worker: never included in a deployment or exposed by Vite.
import { generateText, stepCountIs, streamText } from "ai";
import {
  bindingFetch,
  connectCommerce,
  runMilestoneProbe
} from "../src/commerce-client";
import { signContext, MCP_URL } from "../shared/mcp-context";
import { fakeModel, milestoneTools } from "../src/model";

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/context/")) {
      const kind = path.slice("/context/".length);
      const token = await signContext(
        {
          ...env,
          MCP_AUDIENCE:
            kind === "audience" ? "wrong-environment" : env.MCP_AUDIENCE,
          MCP_CONTEXT_KEY:
            kind === "signature"
              ? "wrong-test-key-only-00000000000000000"
              : env.MCP_CONTEXT_KEY
        },
        Math.floor(Date.now() / 1000) +
          (kind === "expired" ? -120 : kind === "future" ? 120 : 0)
      );
      const headers = new Headers({ "Content-Type": "application/json" });
      if (kind !== "missing")
        headers.set(
          "Authorization",
          `Bearer ${kind === "malformed" ? "invalid" : token}`
        );
      return env.COMMERCE_MCP.fetch(
        new Request(MCP_URL, { method: "POST", headers, body: "{}" })
      );
    }
    if (path === "/transport") {
      const calls: {
        method: string;
        url: string;
        signed: boolean;
        cookie: boolean;
        contentType: string | null;
      }[] = [];
      const connection = {
        ...env,
        COMMERCE_MCP: {
          fetch: async (request: Request) => {
            const response = await env.COMMERCE_MCP.fetch(request);
            calls.push({
              method: request.method,
              url: request.url,
              signed: !!request.headers.get("Authorization"),
              cookie: request.headers.has("Cookie"),
              contentType: response.headers.get("Content-Type")
            });
            return response;
          }
        }
      };
      const probe = await runMilestoneProbe(connection);
      return Response.json({ probe, calls });
    }
    if (path === "/unknown-tool") {
      const client = await connectCommerce(env);
      try {
        const result = await client.callTool({
          name: "refund_order",
          arguments: {}
        });
        return Response.json({ rejected: result.isError === true });
      } catch {
        return Response.json({ rejected: true });
      } finally {
        await client.close();
      }
    }
    if (path === "/adapter-guards") {
      let called = 0;
      const adapter = bindingFetch({
        ...env,
        COMMERCE_MCP: {
          fetch: async (request: Request) => {
            called++;
            if (request.headers.has("Cookie")) throw new Error("Cookie leaked");
            return new Response(null, {
              status: 302,
              headers: { Location: "https://example.test/" }
            });
          }
        }
      });
      let destinationRejected = false,
        redirectRejected = false;
      try {
        await adapter("https://example.test/mcp");
      } catch {
        destinationRejected = true;
      }
      try {
        await adapter(MCP_URL, {
          headers: { Cookie: "test-only", Authorization: "untrusted" }
        });
      } catch {
        redirectRejected = true;
      }
      return Response.json({ destinationRejected, redirectRejected, called });
    }
    if (path === "/fake-model" || path === "/fake-stream") {
      const options = {
        model: fakeModel(),
        prompt: "Check the private MCP connection",
        tools: milestoneTools(env),
        stopWhen: stepCountIs(3)
      };
      if (path === "/fake-stream")
        return streamText(options).toUIMessageStreamResponse();
      const result = await generateText(options);
      return Response.json({
        text: result.text,
        results: result.steps.flatMap((step) => step.toolResults)
      });
    }
    return new Response("Not found", { status: 404 });
  }
};
