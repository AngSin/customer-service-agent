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
import { runSessionProbe } from "../src/commerce-client";
export default {
  async fetch(request: Request, env: Env) {
    const body = (await request.json()) as {
      hash: string;
      input: unknown;
      actionId: string;
      digest: string;
      decision: "approve" | "reject";
      offset?: number;
      fail?: boolean;
      kind?: string;
    };
    const clock = new Date(Date.now() + (body.offset ?? 0));
    try {
      const path = new URL(request.url).pathname;
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
