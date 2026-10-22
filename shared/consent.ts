import { z } from "zod";
import { assertion, executeBatch, sha256, type Statement } from "./fixtures";
import { BoundaryError, sessionByHash, type Session } from "./session";

import { idSchema as id, addressSchema as address } from "./commerce-contract";
const orderArgs = z.strictObject({ order_id: id });
export const proposalSchema = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("cancel_order"), arguments: orderArgs }),
  z.strictObject({ tool: z.literal("refund_order"), arguments: orderArgs }),
  z.strictObject({
    tool: z.literal("update_shipping_address"),
    arguments: z.strictObject({ order_id: id, address })
  }),
  z.strictObject({
    tool: z.literal("create_support_ticket"),
    arguments: z.strictObject({
      order_id: id.optional(),
      category: z.enum([
        "delivery",
        "refund",
        "cancellation",
        "address",
        "other"
      ]),
      subject: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(2000)
    })
  })
]);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
interface Action {
  ns: string;
  action_id: string;
  customer_id: string;
  approval_epoch: number;
  tool: string;
  arguments_json: string;
  digest: string;
  policy_version: string;
  target_id: string | null;
  target_version: number | null;
  state: string;
  result_json: string | null;
  approval_id: string;
  expires_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  revoked_at: string | null;
  consumed_at: string | null;
}
const actionSelect =
  "SELECT a.*,p.approval_id,p.expires_at,p.approved_at,p.rejected_at,p.revoked_at,p.consumed_at FROM mutation_actions a JOIN approvals p ON p.ns=a.ns AND p.action_id=a.action_id";
export async function ownedAction(
  db: D1Database,
  session: Session,
  actionId: string
) {
  const action = await db
    .prepare(
      `${actionSelect} WHERE a.ns=? AND a.customer_id=? AND a.action_id=?`
    )
    .bind(session.ns, session.customer_id, actionId)
    .first<Action>();
  if (!action) throw new BoundaryError("NOT_FOUND", 404);
  return action;
}
export function actionView(action: Action) {
  return {
    actionId: action.action_id,
    digest: action.digest,
    tool: action.tool,
    payload: JSON.parse(action.arguments_json) as unknown,
    state: action.state,
    result: action.result_json
      ? (JSON.parse(action.result_json) as unknown)
      : null,
    expiresAt: action.expires_at,
    decision: action.revoked_at
      ? "revoked"
      : action.rejected_at
        ? "rejected"
        : action.approved_at
          ? "approved"
          : "pending"
  };
}
export async function listActions(db: D1Database, session: Session) {
  const { results } = await db
    .prepare(
      `${actionSelect} WHERE a.ns=? AND a.customer_id=? ORDER BY a.created_at DESC LIMIT 30`
    )
    .bind(session.ns, session.customer_id)
    .all<Action>();
  return results.map(actionView);
}
export function audit(
  ns: string,
  actionId: string,
  event: string,
  now: string,
  digest: string
): Statement {
  return {
    sql: "INSERT INTO audit_events(ns,event_id,action_id,actor_type,event_type,outcome,action_digest,occurred_at) VALUES (?,?,?,'system',?,'ok',?,?)",
    values: [ns, crypto.randomUUID(), actionId, event, digest, now]
  };
}
function activeGuard(session: Session, now: string): Statement {
  return assertion(
    "EXISTS (SELECT 1 FROM demo_sessions WHERE ns=? AND token_hash=? AND customer_id=? AND approval_epoch=? AND mutation_enabled=1 AND provisioning_state='ready' AND expires_at>?)",
    [
      session.ns,
      session.token_hash,
      session.customer_id,
      session.approval_epoch,
      now
    ]
  );
}
async function target(db: D1Database, session: Session, orderId: string) {
  const order = await db
    .prepare(
      "SELECT o.*,r.status AS refund_status,r.version AS refund_version FROM orders o LEFT JOIN refunds r ON r.ns=o.ns AND r.order_id=o.order_id WHERE o.ns=? AND o.customer_id=? AND o.order_id=?"
    )
    .bind(session.ns, session.customer_id, orderId)
    .first<{
      order_id: string;
      version: number;
      fulfillment_status: string;
      payment_status: string;
      total_minor: number;
      refund_status: string | null;
      refund_version: number | null;
    }>();
  if (!order) throw new BoundaryError("NOT_FOUND", 404);
  return order;
}
function eligible(tool: string, order: Awaited<ReturnType<typeof target>>) {
  if (tool === "cancel_order" && order.fulfillment_status !== "unshipped")
    return false;
  if (
    tool === "update_shipping_address" &&
    (order.fulfillment_status !== "unshipped" ||
      order.payment_status === "refunded" ||
      ["pending", "completed"].includes(order.refund_status ?? ""))
  )
    return false;
  if (
    tool === "refund_order" &&
    (order.payment_status !== "paid" ||
      !["cancelled", "shipped", "delivered"].includes(
        order.fulfillment_status
      ) ||
      ["pending", "completed"].includes(order.refund_status ?? ""))
  )
    return false;
  return true;
}
async function propose(
  db: D1Database,
  hash: string,
  input: unknown,
  clock = new Date()
) {
  const session = await sessionByHash(db, hash, true, clock.toISOString());
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new BoundaryError("INVALID_ARGUMENT", 400);
  }
  const proposal = parsed.data;
  const order = proposal.arguments.order_id
    ? await target(db, session, proposal.arguments.order_id)
    : null;
  if (order && !eligible(proposal.tool, order))
    throw new BoundaryError("NOT_ELIGIBLE", 409);
  const payload = {
    ...proposal,
    namespaceId: session.ns,
    customerId: session.customer_id,
    approvalEpoch: session.approval_epoch,
    orderVersion: order?.version ?? null,
    refundVersion: order?.refund_version ?? null,
    ...(proposal.tool === "refund_order"
      ? { amountMinor: order!.total_minor, currency: "EUR" }
      : {}),
    policyVersion: "v1"
  };
  const text = canonical(payload);
  const digest = await sha256(text);
  const existing = await db
    .prepare(
      `${actionSelect} WHERE a.ns=? AND a.customer_id=? AND a.digest=? AND a.state='proposed' AND p.rejected_at IS NULL AND p.revoked_at IS NULL AND p.expires_at>?`
    )
    .bind(session.ns, session.customer_id, digest, clock.toISOString())
    .first<Action>();
  if (existing) return actionView(existing);
  const actionId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  const now = clock.toISOString();
  const expires = new Date(clock.getTime() + 300000).toISOString();
  const statements = [activeGuard(session, now)];
  if (order)
    statements.push(
      assertion(
        "EXISTS (SELECT 1 FROM orders WHERE ns=? AND order_id=? AND customer_id=? AND version=?)",
        [session.ns, order.order_id, session.customer_id, order.version]
      )
    );
  statements.push(
    {
      sql: "INSERT INTO mutation_actions(ns,action_id,customer_id,approval_epoch,tool,arguments_json,digest,policy_version,target_id,target_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'v1',?,?,?,?)",
      values: [
        session.ns,
        actionId,
        session.customer_id,
        session.approval_epoch,
        proposal.tool,
        text,
        digest,
        order?.order_id ?? null,
        order?.version ?? null,
        now,
        now
      ]
    },
    {
      sql: "INSERT INTO approvals(ns,approval_id,action_id,digest,approval_epoch,proposed_at,expires_at) VALUES (?,?,?,?,?,?,?)",
      values: [
        session.ns,
        approvalId,
        actionId,
        digest,
        session.approval_epoch,
        now,
        expires
      ]
    },
    audit(session.ns, actionId, "proposed", now, digest)
  );
  await executeBatch(db, statements);
  return actionView(await ownedAction(db, session, actionId));
}
function assertPending(
  session: Session,
  action: Action,
  digest: string,
  now: string
) {
  if (action.digest !== digest) throw new BoundaryError("ACTION_CONFLICT", 409);
  if (action.revoked_at || action.approval_epoch !== session.approval_epoch)
    throw new BoundaryError("APPROVAL_REVOKED");
  if (action.expires_at <= now)
    throw new BoundaryError("APPROVAL_EXPIRED", 409);
  if (action.rejected_at) throw new BoundaryError("ACTION_CONFLICT", 409);
}
async function decide(
  db: D1Database,
  hash: string,
  actionId: string,
  digest: string,
  decision: "approve" | "reject",
  clock = new Date()
) {
  const now = clock.toISOString();
  const session = await sessionByHash(db, hash, true, now);
  const action = await ownedAction(db, session, actionId);
  assertPending(session, action, digest, now);
  if (action.approved_at) {
    if (decision !== "approve") throw new BoundaryError("ACTION_CONFLICT", 409);
    return actionView(action);
  }
  const column = decision === "approve" ? "approved_at" : "rejected_at";
  try {
    await executeBatch(db, [
      activeGuard(session, now),
      {
        sql: `UPDATE approvals SET ${column}=? WHERE ns=? AND action_id=? AND digest=? AND approved_at IS NULL AND rejected_at IS NULL AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?`,
        values: [now, session.ns, actionId, digest, now]
      },
      assertion("changes()=1"),
      ...(decision === "reject"
        ? [
            {
              sql: "UPDATE mutation_actions SET state='rejected',updated_at=? WHERE ns=? AND action_id=? AND state='proposed'",
              values: [now, session.ns, actionId]
            }
          ]
        : []),
      audit(
        session.ns,
        actionId,
        decision === "approve" ? "approved" : "rejected",
        now,
        digest
      )
    ]);
  } catch {
    throw new BoundaryError("ACTION_CONFLICT", 409);
  }
  return actionView(await ownedAction(db, session, actionId));
}

// Called only by trusted future Commerce executors, never by model/browser approval.
// Business effects must be supplied inside this same transaction in Milestones 4–5.
async function accept(
  db: D1Database,
  hash: string,
  actionId: string,
  digest: string,
  effects: Statement[] = [],
  clock = new Date()
) {
  const now = clock.toISOString();
  const session = await sessionByHash(db, hash, false, now);
  const action = await ownedAction(db, session, actionId);
  if (action.digest !== digest) throw new BoundaryError("ACTION_CONFLICT", 409);
  if (["accepted", "completed"].includes(action.state))
    return { actionId, replayed: true };
  if (!session.mutation_enabled) throw new BoundaryError("SESSION_REVOKED");
  assertPending(session, action, digest, now);
  if (!action.approved_at || action.consumed_at)
    throw new BoundaryError("APPROVAL_REQUIRED");
  if ((await sha256(action.arguments_json)) !== digest)
    throw new BoundaryError("ACTION_CONFLICT", 409);
  const payload = JSON.parse(action.arguments_json) as {
    refundVersion: number | null;
  };
  if (action.target_id) {
    const order = await target(db, session, action.target_id);
    if (
      order.version !== action.target_version ||
      order.refund_version !== payload.refundVersion
    )
      throw new BoundaryError("VERSION_CONFLICT", 409);
    if (!eligible(action.tool, order))
      throw new BoundaryError("NOT_ELIGIBLE", 409);
  }
  const statements = [activeGuard(session, now)];
  if (action.target_id)
    statements.push(
      assertion(
        "EXISTS (SELECT 1 FROM orders o LEFT JOIN refunds r ON r.ns=o.ns AND r.order_id=o.order_id WHERE o.ns=? AND o.customer_id=? AND o.order_id=? AND o.version=? AND r.version IS ?)",
        [
          session.ns,
          session.customer_id,
          action.target_id,
          action.target_version,
          payload.refundVersion
        ]
      )
    );
  statements.push(
    {
      sql: "UPDATE approvals SET consumed_at=? WHERE ns=? AND action_id=? AND digest=? AND consumed_at IS NULL AND approved_at IS NOT NULL AND rejected_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      values: [now, session.ns, actionId, digest, now]
    },
    assertion("changes()=1"),
    {
      sql: "UPDATE mutation_actions SET state='accepted',updated_at=? WHERE ns=? AND action_id=? AND state='proposed'",
      values: [now, session.ns, actionId]
    },
    assertion("changes()=1"),
    ...effects,
    audit(session.ns, actionId, "accepted", now, digest)
  );
  try {
    await executeBatch(db, statements);
  } catch {
    const latest = await ownedAction(db, session, actionId);
    if (["accepted", "completed"].includes(latest.state))
      return { actionId, replayed: true };
    throw new BoundaryError("ACTION_CONFLICT", 409);
  }
  return { actionId, replayed: false };
}

export async function recordDenial(
  db: D1Database,
  hash: string,
  event: string,
  error: unknown
) {
  const row = await db
    .prepare("SELECT ns FROM demo_sessions WHERE token_hash=?")
    .bind(hash)
    .first<{ ns: string }>();
  if (!row) return;
  const code =
    error instanceof BoundaryError ? error.code : "TEMPORARILY_UNAVAILABLE";
  await db
    .prepare(
      "INSERT INTO audit_events(ns,event_id,actor_type,event_type,outcome,reason,occurred_at) VALUES (?,?,'system',?,'denied',?,?)"
    )
    .bind(row.ns, crypto.randomUUID(), event, code, new Date().toISOString())
    .run();
}
export async function createProposal(
  db: D1Database,
  hash: string,
  input: unknown,
  clock = new Date()
) {
  try {
    return await propose(db, hash, input, clock);
  } catch (error) {
    await recordDenial(db, hash, "proposal_denied", error);
    throw error;
  }
}
export async function decideApproval(
  db: D1Database,
  hash: string,
  actionId: string,
  digest: string,
  decision: "approve" | "reject",
  clock = new Date()
) {
  try {
    return await decide(db, hash, actionId, digest, decision, clock);
  } catch (error) {
    await recordDenial(db, hash, "approval_denied", error);
    throw error;
  }
}
export async function acceptAction(
  db: D1Database,
  hash: string,
  actionId: string,
  digest: string,
  effects: Statement[] = [],
  clock = new Date()
) {
  try {
    return await accept(db, hash, actionId, digest, effects, clock);
  } catch (error) {
    await recordDenial(db, hash, "acceptance_denied", error);
    throw error;
  }
}
