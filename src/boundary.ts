import { z } from "zod";
import {
  authenticate,
  BoundaryError,
  cookie,
  createSession,
  CSRF_COOKIE,
  jsonBody,
  personaSchema,
  personas,
  randomToken,
  replaceSession,
  requireCsrf,
  requireOrigin,
  SESSION_COOKIE,
  sessionView,
  setCookie
} from "../shared/session";
import { callCommerce, executeApprovedAction } from "./commerce-client";
import { decideApproval, listActions, ownedAction } from "../shared/consent";

export function boundaryResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {}
) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}
export function boundaryFailure(error: unknown) {
  if (error instanceof BoundaryError)
    return boundaryResponse({ error: { code: error.code } }, error.status);
  if (error instanceof z.ZodError)
    return boundaryResponse({ error: { code: "INVALID_ARGUMENT" } }, 400);
  console.error("Session or consent operation failed");
  return boundaryResponse({ error: { code: "TEMPORARILY_UNAVAILABLE" } }, 503);
}
export async function boundaryApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) return null;
  try {
    if (request.method === "GET" && path === "/api/session") {
      if (request.headers.has("Origin")) requireOrigin(request);
      let session = null;
      try {
        session = await authenticate(request, env.DB);
      } catch (error) {
        if (
          !(error instanceof BoundaryError) ||
          error.code !== "UNAUTHENTICATED"
        )
          throw error;
      }
      const csrf = cookie(request, CSRF_COOKIE) ?? randomToken();
      return boundaryResponse(
        {
          session: session ? sessionView(session) : null,
          personas,
          csrfToken: csrf
        },
        200,
        { "Set-Cookie": setCookie(CSRF_COOKIE, csrf) }
      );
    }
    if (
      request.method === "POST" &&
      ["/api/sessions", "/api/sessions/replace"].includes(path)
    ) {
      requireCsrf(request);
      const replacement = path.endsWith("/replace");
      const schema = z.strictObject({
        persona: personaSchema,
        requestKey: z.uuid().optional()
      });
      const body = schema.parse(await jsonBody(request));
      let result;
      if (replacement) {
        if (!body.requestKey) throw new BoundaryError("INVALID_ARGUMENT", 400);
        const token = cookie(request, SESSION_COOKIE);
        if (!token) throw new BoundaryError("UNAUTHENTICATED", 401);
        result = await replaceSession(
          env.DB,
          token,
          body.persona,
          body.requestKey,
          env.MCP_CONTEXT_KEY
        );
      } else {
        if (body.requestKey) throw new BoundaryError("INVALID_ARGUMENT", 400);
        let existing = null;
        try {
          existing = await authenticate(request, env.DB);
        } catch (error) {
          if (
            !(error instanceof BoundaryError) ||
            error.code !== "UNAUTHENTICATED"
          )
            throw error;
        }
        if (existing?.mutation_enabled)
          throw new BoundaryError("USE_SESSION_REPLACEMENT", 409);
        result = await createSession(env.DB, body.persona);
      }
      return boundaryResponse({ session: sessionView(result.session) }, 200, {
        "Set-Cookie": setCookie(SESSION_COOKIE, result.token)
      });
    }
    if (path === "/api/orders" && request.method === "GET") {
      const session = await authenticate(request, env.DB);
      return boundaryResponse(
        await callCommerce(
          { ...env, session: { db: env.DB, tokenHash: session.token_hash } },
          "list_customer_orders",
          { limit: 20 }
        )
      );
    }
    if (path === "/api/actions" && request.method === "GET") {
      return boundaryResponse({
        actions: await listActions(env.DB, await authenticate(request, env.DB))
      });
    }
    const match = /^\/api\/actions\/([a-zA-Z0-9_-]{1,64})\/decision$/.exec(
      path
    );
    if (match && request.method === "POST") {
      requireCsrf(request);
      const session = await authenticate(request, env.DB, true);
      const body = z
        .strictObject({
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          decision: z.enum(["approve", "reject"])
        })
        .parse(await jsonBody(request));
      const action = await decideApproval(
        env.DB,
        session.token_hash,
        match[1]!,
        body.digest,
        body.decision
      );
      return boundaryResponse({ action });
    }
    const executeMatch =
      /^\/api\/actions\/([a-zA-Z0-9_-]{1,64})\/execute$/.exec(path);
    if (executeMatch && request.method === "POST") {
      requireCsrf(request);
      const session = await authenticate(request, env.DB);
      const body = z
        .strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(await jsonBody(request));
      const action = await ownedAction(env.DB, session, executeMatch[1]!);
      if (body.digest !== action.digest)
        throw new BoundaryError("ACTION_CONFLICT", 409);
      return boundaryResponse({
        result: await executeApprovedAction(
          env,
          session.token_hash,
          action.action_id
        )
      });
    }
    return boundaryResponse({ error: { code: "NOT_FOUND" } }, 404);
  } catch (error) {
    return boundaryFailure(error);
  }
}
