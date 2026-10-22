import {
  acceptAction,
  canonical,
  createProposal,
  ownedAction
} from "./consent";
import { assertion, type Statement } from "./fixtures";
import { BoundaryError, sessionByHash, type Session } from "./session";
import {
  dataSchemas,
  inputs,
  mutations,
  orderSummary,
  outputSchema,
  type CommerceResult,
  type ToolName
} from "./commerce-contract";

interface Order {
  order_id: string;
  customer_id: string;
  fulfillment_status: string;
  payment_status: string;
  total_minor: number;
  currency: string;
  version: number;
  address_json: string;
  tracking_carrier: string | null;
  tracking_number: string | null;
}
async function orderFor(db: D1Database, session: Session, id: string) {
  const row = await db
    .prepare("SELECT * FROM orders WHERE ns=? AND customer_id=? AND order_id=?")
    .bind(session.ns, session.customer_id, id)
    .first<Order>();
  if (!row) throw new BoundaryError("NOT_FOUND", 404);
  return row;
}
async function refundFor(
  db: D1Database,
  session: Session,
  column: "r.order_id" | "r.refund_id",
  id: string
) {
  const row = await db
    .prepare(
      `SELECT r.refund_id,r.order_id,r.amount_minor,r.currency,r.status,r.current_attempt_number AS attempt_number,a.processor_outcome AS outcome,r.updated_at FROM refunds r JOIN orders o ON o.ns=r.ns AND o.order_id=r.order_id AND o.customer_id=r.customer_id JOIN refund_attempts a ON a.ns=r.ns AND a.refund_id=r.refund_id AND a.attempt_number=r.current_attempt_number WHERE r.ns=? AND r.customer_id=? AND ${column}=?`
    )
    .bind(session.ns, session.customer_id, id)
    .first<{
      refund_id: string;
      order_id: string;
      amount_minor: number;
      currency: string;
      status: string;
      attempt_number: number;
      outcome: string;
      updated_at: string;
    }>();
  return row
    ? { ...row, retry_requires_approval: row.status === "failed" }
    : null;
}
function summary(order: Order) {
  return orderSummary.parse(
    Object.fromEntries(
      Object.keys(orderSummary.shape).map((k) => [k, order[k as keyof Order]])
    )
  );
}
async function cursorSignature(secret: string, session: Session, last: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return {
    key,
    bytes: new TextEncoder().encode(
      `order-cursor:v1:${session.ns}:${session.customer_id}:${last}`
    )
  };
}
async function makeCursor(secret: string, session: Session, last: string) {
  const { key, bytes } = await cursorSignature(secret, session, last);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return `${last}.${Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function readCursor(secret: string, session: Session, cursor?: string) {
  if (!cursor) return "";
  const match = /^([a-zA-Z0-9_-]{1,64})\.([a-f0-9]{64})$/.exec(cursor);
  if (!match) throw new BoundaryError("INVALID_ARGUMENT", 400);
  const { key, bytes } = await cursorSignature(secret, session, match[1]!);
  const sig = Uint8Array.from(match[2]!.match(/../g)!, (x) => parseInt(x, 16));
  if (!(await crypto.subtle.verify("HMAC", key, sig, bytes)))
    throw new BoundaryError("INVALID_ARGUMENT", 400);
  return match[1]!;
}
const messages: Record<string, string> = {
  NOT_FOUND: "Record not found.",
  INVALID_ARGUMENT: "The supplied fields are invalid.",
  IDENTITY_SWITCH_DENIED: "Use Start new session to change customer.",
  NOT_ELIGIBLE: "This order is not eligible for that action.",
  APPROVAL_REQUIRED:
    "Review the action card and click Approve before this action can run.",
  APPROVAL_EXPIRED: "This approval has expired. Request a new proposal.",
  APPROVAL_REVOKED: "This approval is no longer active.",
  ACTION_CONFLICT:
    "The action has changed or cannot be completed. Refresh before trying again.",
  VERSION_CONFLICT: "The order has changed. Request a new proposal.",
  SESSION_REVOKED: "This session is no longer active.",
  UNAUTHENTICATED: "Your session has expired. Start a new session.",
  RATE_LIMITED: "This session has reached the support ticket limit.",
  FEATURE_UNAVAILABLE:
    "New refund execution and refund retries are not available yet. Existing refund status can still be checked."
};
function failure(error: unknown, requestId: string): CommerceResult {
  const code =
    error instanceof BoundaryError ? error.code : "TEMPORARILY_UNAVAILABLE";
  return {
    ok: false,
    error: {
      code,
      message:
        messages[code] ??
        "The shop service is temporarily unavailable. Please retry.",
      retryable: code === "TEMPORARILY_UNAVAILABLE"
    },
    request_id: requestId
  };
}
async function read(
  db: D1Database,
  session: Session,
  secret: string,
  name: ToolName,
  args: Record<string, unknown>
) {
  if (name === "get_customer_profile") {
    const row = await db
      .prepare(
        "SELECT customer_id,display_name,email,address_json FROM customers WHERE ns=? AND customer_id=?"
      )
      .bind(session.ns, session.customer_id)
      .first<{
        customer_id: string;
        display_name: string;
        email: string;
        address_json: string;
      }>();
    if (!row) throw new BoundaryError("NOT_FOUND", 404);
    return {
      customer: {
        customer_id: row.customer_id,
        display_name: row.display_name,
        email: row.email,
        saved_shipping_address: JSON.parse(row.address_json)
      }
    };
  }
  if (name === "list_customer_orders") {
    const limit = (args.limit as number | undefined) ?? 10;
    const last = await readCursor(
      secret,
      session,
      args.cursor as string | undefined
    );
    const { results } = await db
      .prepare(
        "SELECT * FROM orders WHERE ns=? AND customer_id=? AND order_id>? ORDER BY order_id LIMIT ?"
      )
      .bind(session.ns, session.customer_id, last, limit + 1)
      .all<Order>();
    const page = results.slice(0, limit);
    return {
      orders: page.map(summary),
      next_cursor:
        results.length > limit
          ? await makeCursor(secret, session, page.at(-1)!.order_id)
          : null
    };
  }
  if (name === "get_refund_status") {
    const refund = await refundFor(
      db,
      session,
      "r.refund_id",
      args.refund_id as string
    );
    if (!refund) throw new BoundaryError("NOT_FOUND", 404);
    return { refund };
  }
  const order = await orderFor(db, session, args.order_id as string);
  const refund = await refundFor(db, session, "r.order_id", order.order_id);
  if (name === "refund_order") {
    if (refund && ["pending", "completed"].includes(refund.status))
      return {
        refund,
        action_id: null,
        replayed: false,
        disposition: "status_only"
      };
    if (
      order.payment_status !== "paid" ||
      !["cancelled", "shipped", "delivered"].includes(order.fulfillment_status)
    )
      throw new BoundaryError("NOT_ELIGIBLE", 409);
    throw new BoundaryError("FEATURE_UNAVAILABLE", 409);
  }
  const { results: items } = await db
    .prepare(
      "SELECT sku,name,quantity,unit_minor,line_minor FROM order_items WHERE ns=? AND order_id=? ORDER BY item_id"
    )
    .bind(session.ns, order.order_id)
    .all();
  const canCancel = order.fulfillment_status === "unshipped";
  const canAddress =
    canCancel &&
    order.payment_status !== "refunded" &&
    !["pending", "completed"].includes(refund?.status ?? "");
  const canRefund =
    order.payment_status === "paid" &&
    ["cancelled", "shipped", "delivered"].includes(order.fulfillment_status) &&
    !["pending", "completed"].includes(refund?.status ?? "");
  return {
    order: {
      ...summary(order),
      items,
      shipping_address: JSON.parse(order.address_json),
      tracking:
        order.tracking_carrier && order.tracking_number
          ? {
              carrier: order.tracking_carrier,
              tracking_id: order.tracking_number
            }
          : null,
      refund,
      eligibility: {
        can_cancel: canCancel,
        can_refund: canRefund,
        can_update_address: canAddress,
        reasons: [
          ...(!canCancel ? ["Only unshipped orders can be cancelled."] : []),
          ...(!canAddress
            ? [
                "Address changes require an unshipped order without a pending or completed refund."
              ]
            : []),
          "New refund execution is unavailable until Milestone 5."
        ]
      }
    }
  };
}

async function execute(
  db: D1Database,
  session: Session,
  name: ToolName,
  args: Record<string, unknown>,
  actionId: string,
  requestId: string
) {
  const action = await ownedAction(db, session, actionId);
  const payload = JSON.parse(action.arguments_json) as { arguments: unknown };
  if (action.tool !== name || canonical(payload.arguments) !== canonical(args))
    throw new BoundaryError("ACTION_CONFLICT", 409);
  if (["accepted", "completed"].includes(action.state)) {
    if (!action.result_json) throw new BoundaryError("ACTION_CONFLICT", 409);
    return {
      ...(JSON.parse(action.result_json) as Record<string, unknown>),
      replayed: true
    };
  }
  if (name === "refund_order")
    throw new BoundaryError("FEATURE_UNAVAILABLE", 409);
  const now = new Date().toISOString();
  const effects: Statement[] = [];
  let result: Record<string, unknown>;
  if (name === "create_support_ticket") {
    const count = await db
      .prepare(
        "SELECT count(*) AS n FROM support_tickets WHERE ns=? AND customer_id=? AND action_id IS NOT NULL"
      )
      .bind(session.ns, session.customer_id)
      .first<{ n: number }>();
    if (count!.n >= 20) throw new BoundaryError("RATE_LIMITED", 429);
    const ticket = {
      ticket_id: crypto.randomUUID(),
      order_id: (args.order_id as string | undefined) ?? null,
      category: args.category,
      subject: args.subject,
      body: args.body,
      status: "open",
      created_at: now
    };
    effects.push(
      assertion(
        "(SELECT count(*) FROM support_tickets WHERE ns=? AND customer_id=? AND action_id IS NOT NULL)<20",
        [session.ns, session.customer_id]
      ),
      {
        sql: "INSERT INTO support_tickets(ns,ticket_id,customer_id,order_id,category,subject,body,status,action_id,created_at) VALUES (?,?,?,?,?,?,?,'open',?,?)",
        values: [
          session.ns,
          ticket.ticket_id,
          session.customer_id,
          ticket.order_id,
          args.category as string,
          args.subject as string,
          args.body as string,
          actionId,
          now
        ]
      },
      assertion("changes()=1")
    );
    result = { action_id: actionId, replayed: false, ticket };
  } else {
    const order = await orderFor(db, session, args.order_id as string);
    const next = summary({
      ...order,
      version: order.version + 1,
      ...(name === "cancel_order" ? { fulfillment_status: "cancelled" } : {})
    });
    if (name === "cancel_order") {
      effects.push(
        {
          sql: "UPDATE orders SET fulfillment_status='cancelled',version=version+1,updated_at=? WHERE ns=? AND customer_id=? AND order_id=? AND version=? AND fulfillment_status='unshipped'",
          values: [
            now,
            session.ns,
            session.customer_id,
            order.order_id,
            order.version
          ]
        },
        assertion("changes()=1")
      );
      result = {
        action_id: actionId,
        replayed: false,
        order: next,
        payment_unchanged: true,
        notice:
          order.payment_status === "paid"
            ? "Order cancelled; payment has not been refunded."
            : "Order cancelled; payment is unchanged.",
        offer_refund: order.payment_status === "paid"
      };
    } else {
      effects.push(
        {
          sql: "UPDATE orders SET address_json=?,version=version+1,updated_at=? WHERE ns=? AND customer_id=? AND order_id=? AND version=? AND fulfillment_status='unshipped' AND payment_status<>'refunded' AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.ns=orders.ns AND r.order_id=orders.order_id AND r.status IN ('pending','completed'))",
          values: [
            JSON.stringify(args.address),
            now,
            session.ns,
            session.customer_id,
            order.order_id,
            order.version
          ]
        },
        assertion("changes()=1")
      );
      result = {
        action_id: actionId,
        replayed: false,
        order: next,
        shipping_address: args.address,
        profile_address_unchanged: true
      };
    }
  }
  // Persist the exact safe business result in the same transaction as consumption and effects.
  const validated = dataSchemas[name].parse(result);
  effects.push(
    {
      sql: "UPDATE mutation_actions SET state='completed',result_json=?,updated_at=? WHERE ns=? AND action_id=? AND state='accepted'",
      values: [JSON.stringify(validated), now, session.ns, actionId]
    },
    assertion("changes()=1"),
    {
      sql: "INSERT INTO audit_events(ns,event_id,request_id,customer_id,action_id,order_id,actor_type,event_type,outcome,from_version,to_version,action_digest,occurred_at) VALUES (?,?,?,?,?,?,'system','completed','ok',?,?,?,?)",
      values: [
        session.ns,
        crypto.randomUUID(),
        requestId,
        session.customer_id,
        actionId,
        action.target_id,
        action.target_version,
        name === "create_support_ticket"
          ? action.target_version
          : (action.target_version ?? 0) + 1,
        action.digest,
        now
      ]
    }
  );
  const accepted = await acceptAction(
    db,
    session.token_hash,
    actionId,
    action.digest,
    effects
  );
  const stored = await ownedAction(db, session, actionId);
  if (!stored.result_json) throw new BoundaryError("ACTION_CONFLICT", 409);
  return {
    ...(JSON.parse(stored.result_json) as Record<string, unknown>),
    replayed: accepted.replayed
  };
}

// This entry point is called only after the Commerce Worker verifies signed context.
export async function commerceCall(
  db: D1Database,
  secret: string,
  hash: string,
  name: ToolName,
  input: unknown,
  actionId?: string
): Promise<CommerceResult> {
  const requestId = crypto.randomUUID();
  let session: Session | undefined;
  try {
    session = await sessionByHash(db, hash);
    if (
      input &&
      typeof input === "object" &&
      Object.keys(input).some((k) =>
        [
          "customer_id",
          "persona",
          "session_id",
          "namespace_id",
          "approval_id",
          "action_id",
          "authorization"
        ].includes(k.toLowerCase())
      )
    )
      throw new BoundaryError("IDENTITY_SWITCH_DENIED", 400);
    const parsed = inputs[name].safeParse(input);
    if (!parsed.success) throw new BoundaryError("INVALID_ARGUMENT", 400);
    const args = parsed.data as Record<string, unknown>;
    let data: Record<string, unknown>;
    if (mutations.has(name) && name !== "refund_order") {
      if (!actionId) {
        const proposal = await createProposal(db, hash, {
          tool: name,
          arguments: args
        });
        return outputSchema(name).parse({
          ...failure(new BoundaryError("APPROVAL_REQUIRED"), requestId),
          proposal
        }) as CommerceResult;
      }
      data = await execute(db, session, name, args, actionId, requestId);
    } else if (actionId) {
      throw new BoundaryError("ACTION_CONFLICT", 409);
    } else {
      data = await read(db, session, secret, name, args);
      await db
        .prepare(
          "INSERT INTO audit_events(ns,event_id,request_id,customer_id,actor_type,event_type,outcome,occurred_at) VALUES (?,?,?,?,'system',?,'ok',?)"
        )
        .bind(
          session.ns,
          crypto.randomUUID(),
          requestId,
          session.customer_id,
          `read:${name}`,
          new Date().toISOString()
        )
        .run();
    }
    return outputSchema(name).parse({
      ok: true,
      data,
      request_id: requestId
    }) as CommerceResult;
  } catch (error) {
    const result = failure(error, requestId);
    if (session) {
      try {
        await db
          .prepare(
            "INSERT INTO audit_events(ns,event_id,request_id,customer_id,actor_type,event_type,outcome,reason,occurred_at) VALUES (?,?,?,?,'system',?,'denied',?,?)"
          )
          .bind(
            session.ns,
            crypto.randomUUID(),
            requestId,
            session.customer_id,
            `tool:${name}`,
            !result.ok ? result.error.code : "TEMPORARILY_UNAVAILABLE",
            new Date().toISOString()
          )
          .run();
      } catch {
        return failure(new Error("Audit unavailable"), requestId);
      }
    }
    return result;
  }
}
