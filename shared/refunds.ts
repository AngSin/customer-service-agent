import { acceptAction, ownedAction } from "./consent";
import { assertion, executeBatch, type Statement } from "./fixtures";
import { BoundaryError, type Session } from "./session";
import { dataSchemas } from "./commerce-contract";

export type RefundParams = { workflowId: string };
export interface RefundBinding {
  create(options: { id: string; params: RefundParams }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}
export interface Attempt {
  ns: string;
  refund_id: string;
  order_id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  version: number;
  current_attempt_number: number;
  attempt_number: number;
  attempt_key: string;
  workflow_instance_id: string;
  origin: string;
  action_id: string | null;
  approval_id: string | null;
  execution_state: string;
  processor_outcome: string;
  needs_attention: number;
  updated_at: string;
}
export function refundView(attempt: Attempt) {
  return {
    refund_id: attempt.refund_id,
    order_id: attempt.order_id,
    amount_minor: attempt.amount_minor,
    currency: attempt.currency,
    status: attempt.status,
    attempt_number: attempt.attempt_number,
    outcome: attempt.processor_outcome,
    retry_requires_approval: attempt.status === "failed",
    needs_attention: Boolean(attempt.needs_attention),
    updated_at: attempt.updated_at
  };
}
const attemptSelect =
  "SELECT r.*,a.attempt_number,a.attempt_key,a.workflow_instance_id,a.origin,a.action_id,a.approval_id,a.execution_state,a.processor_outcome,a.needs_attention FROM refunds r JOIN refund_attempts a ON a.ns=r.ns AND a.refund_id=r.refund_id";

export async function acceptRefund(
  db: D1Database,
  session: Session,
  actionId: string
) {
  const action = await ownedAction(db, session, actionId);
  if (["accepted", "completed"].includes(action.state) && action.result_json)
    return {
      ...(JSON.parse(action.result_json) as Record<string, unknown>),
      replayed: true
    };
  const payload = JSON.parse(action.arguments_json) as {
    arguments: { order_id: string };
    amountMinor: number;
    currency: string;
  };
  const order = await db
    .prepare(
      "SELECT total_minor,currency,version FROM orders WHERE ns=? AND customer_id=? AND order_id=?"
    )
    .bind(session.ns, session.customer_id, payload.arguments.order_id)
    .first<{ total_minor: number; currency: string; version: number }>();
  if (
    !order ||
    order.total_minor !== payload.amountMinor ||
    order.currency !== payload.currency
  )
    throw new BoundaryError("ACTION_CONFLICT", 409);
  const prior = await db
    .prepare(
      `${attemptSelect} WHERE r.ns=? AND r.customer_id=? AND r.order_id=? AND a.attempt_number=r.current_attempt_number`
    )
    .bind(session.ns, session.customer_id, payload.arguments.order_id)
    .first<Attempt>();
  if (prior && prior.status !== "failed") {
    const latest = await ownedAction(db, session, actionId);
    if (["accepted", "completed"].includes(latest.state) && latest.result_json)
      return {
        ...(JSON.parse(latest.result_json) as Record<string, unknown>),
        replayed: true
      };
    throw new BoundaryError("ACTION_CONFLICT", 409);
  }
  const now = new Date().toISOString();
  const refundId = prior?.refund_id ?? crypto.randomUUID();
  const number = (prior?.attempt_number ?? 0) + 1;
  const key = `attempt-${session.ns}-${refundId}-${number}`;
  const workflowId = `refund-${session.ns}-${refundId}-${number}`;
  const effects: Statement[] = [];
  if (prior) {
    effects.push(
      assertion(
        "EXISTS (SELECT 1 FROM refund_attempts a JOIN mock_processor_operations p ON p.attempt_key=a.attempt_key WHERE a.ns=? AND a.refund_id=? AND a.attempt_number=? AND a.execution_state='failed' AND a.processor_outcome='confirmed_no_refund' AND p.outcome='confirmed_no_refund' AND p.amount_minor=? AND p.currency=?)",
        [
          session.ns,
          refundId,
          prior.attempt_number,
          order.total_minor,
          order.currency
        ]
      ),
      {
        sql: "UPDATE refunds SET status='pending',current_attempt_number=current_attempt_number+1,version=version+1,updated_at=? WHERE ns=? AND refund_id=? AND status='failed' AND version=?",
        values: [now, session.ns, refundId, prior.version]
      },
      assertion("changes()=1")
    );
  } else
    effects.push(
      {
        sql: "INSERT INTO refunds(ns,refund_id,order_id,customer_id,amount_minor,currency,status,current_attempt_number,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',1,?,?)",
        values: [
          session.ns,
          refundId,
          payload.arguments.order_id,
          session.customer_id,
          order.total_minor,
          order.currency,
          now,
          now
        ]
      },
      assertion("changes()=1")
    );
  effects.push(
    {
      sql: "INSERT INTO refund_attempts(ns,refund_id,attempt_number,attempt_id,attempt_key,workflow_instance_id,origin,action_id,approval_id,execution_state,processor_outcome,created_at,updated_at) VALUES (?,?,?,?,?,?,'reviewer',?,?,'accepted','unknown',?,?)",
      values: [
        session.ns,
        refundId,
        number,
        crypto.randomUUID(),
        key,
        workflowId,
        actionId,
        action.approval_id,
        now,
        now
      ]
    },
    assertion("changes()=1"),
    {
      sql: "UPDATE orders SET version=version+1,updated_at=? WHERE ns=? AND customer_id=? AND order_id=? AND version=? AND total_minor=? AND currency=? AND payment_status='paid' AND fulfillment_status IN ('cancelled','shipped','delivered')",
      values: [
        now,
        session.ns,
        session.customer_id,
        payload.arguments.order_id,
        action.target_version,
        order.total_minor,
        order.currency
      ]
    },
    assertion("changes()=1"),
    {
      sql: "INSERT INTO workflow_dispatches(workflow_instance_id,ns,refund_id,attempt_number,action_id,state,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)",
      values: [workflowId, session.ns, refundId, number, actionId, now, now]
    }
  );
  const result = dataSchemas.refund_order.parse({
    refund: {
      refund_id: refundId,
      order_id: payload.arguments.order_id,
      amount_minor: order.total_minor,
      currency: order.currency,
      status: "pending",
      attempt_number: number,
      outcome: "unknown",
      retry_requires_approval: false,
      needs_attention: false,
      updated_at: now
    },
    action_id: actionId,
    replayed: false,
    disposition: prior ? "retry_accepted" : "accepted"
  });
  effects.push(
    {
      sql: "UPDATE mutation_actions SET result_json=?,updated_at=? WHERE ns=? AND action_id=? AND state='accepted'",
      values: [JSON.stringify(result), now, session.ns, actionId]
    },
    assertion("changes()=1")
  );
  const acceptance = await acceptAction(
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
    replayed: acceptance.replayed
  };
}

// Workflow params identify a persisted attempt only; no amount, customer or scenario is trusted from a trigger.
export async function loadAttempt(
  db: D1Database,
  workflowId: string
): Promise<Attempt> {
  const row = await db
    .prepare(
      `${attemptSelect} JOIN orders o ON o.ns=r.ns AND o.order_id=r.order_id AND o.customer_id=r.customer_id JOIN workflow_dispatches d ON d.ns=a.ns AND d.refund_id=a.refund_id AND d.attempt_number=a.attempt_number AND d.workflow_instance_id=a.workflow_instance_id WHERE a.workflow_instance_id=? AND a.attempt_number=r.current_attempt_number AND r.amount_minor=o.total_minor AND r.currency=o.currency AND o.fulfillment_status IN ('cancelled','shipped','delivered') AND ((r.status='completed' AND o.payment_status='refunded') OR (r.status IN ('pending','failed') AND o.payment_status='paid'))`
    )
    .bind(workflowId)
    .first<Attempt>();
  if (!row) throw new Error("Invalid persisted refund attempt");
  if (row.origin === "reviewer") {
    const consent = await db
      .prepare(
        "SELECT a.arguments_json,a.digest,p.digest AS approved_digest FROM mutation_actions a JOIN approvals p ON p.ns=a.ns AND p.action_id=a.action_id WHERE a.ns=? AND a.action_id=? AND a.customer_id=? AND a.target_id=? AND a.tool='refund_order' AND a.state IN ('accepted','completed') AND p.approval_id=? AND p.consumed_at IS NOT NULL AND p.approved_at IS NOT NULL"
      )
      .bind(
        row.ns,
        row.action_id,
        row.customer_id,
        row.order_id,
        row.approval_id
      )
      .first<{
        arguments_json: string;
        digest: string;
        approved_digest: string;
      }>();
    if (!consent || consent.digest !== consent.approved_digest)
      throw new Error("Missing accepted refund consent");
    const payload = JSON.parse(consent.arguments_json) as {
      amountMinor: number;
      currency: string;
    };
    if (
      payload.amountMinor !== row.amount_minor ||
      payload.currency !== row.currency
    )
      throw new Error("Refund amount mismatch");
  } else if (row.action_id || row.approval_id)
    throw new Error("Invalid fixture attempt");
  if (row.attempt_number > 1) {
    const prior = await db
      .prepare(
        "SELECT a.attempt_key FROM refund_attempts a JOIN mock_processor_operations p ON p.attempt_key=a.attempt_key WHERE a.ns=? AND a.refund_id=? AND a.attempt_number=? AND a.execution_state='failed' AND a.processor_outcome='confirmed_no_refund' AND p.outcome='confirmed_no_refund' AND p.amount_minor=? AND p.currency=?"
      )
      .bind(
        row.ns,
        row.refund_id,
        row.attempt_number - 1,
        row.amount_minor,
        row.currency
      )
      .first();
    if (!prior) throw new Error("Retry lacks definitive failure evidence");
  }
  return row;
}
function event(attempt: Attempt, name: string, outcome: string): Statement {
  return {
    sql: "INSERT INTO audit_events(ns,event_id,customer_id,action_id,order_id,refund_id,attempt_number,workflow_instance_id,actor_type,event_type,outcome,occurred_at) VALUES (?,?,?,?,?,?,?,?,'workflow',?,?,?) ON CONFLICT DO NOTHING",
    values: [
      attempt.ns,
      `${attempt.workflow_instance_id}:${name}`,
      attempt.customer_id,
      attempt.action_id,
      attempt.order_id,
      attempt.refund_id,
      attempt.attempt_number,
      attempt.workflow_instance_id,
      name,
      outcome,
      new Date().toISOString()
    ]
  };
}
interface Operation {
  outcome: string;
  receipt_id: string | null;
  scenario: string;
  reconciliation_count: number;
  amount_minor: number;
  currency: string;
  ns: string;
  refund_id: string;
  attempt_number: number;
}
async function operation(db: D1Database, a: Attempt) {
  const row = await db
    .prepare("SELECT * FROM mock_processor_operations WHERE attempt_key=?")
    .bind(a.attempt_key)
    .first<Operation>();
  if (
    row &&
    (row.ns !== a.ns ||
      row.refund_id !== a.refund_id ||
      row.attempt_number !== a.attempt_number ||
      row.amount_minor !== a.amount_minor ||
      row.currency !== a.currency)
  )
    throw new Error("Processor payload mismatch");
  return row;
}
function scenario(a: Attempt) {
  if (a.order_id === "ord_501" && a.attempt_number === 1)
    return "confirmed_failure";
  if (a.order_id === "ord_202") return "unknown_then_success";
  if (a.order_id === "ord_601") return "lost_response";
  return "success";
}
export async function processAttempt(db: D1Database, workflowId: string) {
  const a = await loadAttempt(db, workflowId);
  const existing = await operation(db, a);
  if (existing) return existing.outcome;
  if (a.status !== "pending") throw new Error("Terminal refund lacks evidence");
  const mode = scenario(a);
  const outcome =
    mode === "confirmed_failure"
      ? "confirmed_no_refund"
      : mode === "unknown_then_success"
        ? "unknown"
        : "confirmed_succeeded";
  await executeBatch(db, [
    {
      sql: "UPDATE refund_attempts SET execution_state='running',updated_at=? WHERE ns=? AND refund_id=? AND attempt_number=? AND execution_state='accepted'",
      values: [new Date().toISOString(), a.ns, a.refund_id, a.attempt_number]
    },
    {
      sql: "INSERT INTO mock_processor_operations(attempt_key,ns,refund_id,attempt_number,amount_minor,currency,scenario,outcome,receipt_id) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_key) DO NOTHING",
      values: [
        a.attempt_key,
        a.ns,
        a.refund_id,
        a.attempt_number,
        a.amount_minor,
        a.currency,
        mode,
        outcome,
        outcome === "confirmed_succeeded" ? `receipt-${a.attempt_key}` : null
      ]
    },
    event(a, "processor_observed", outcome)
  ]);
  const persisted = await operation(db, a);
  if (!persisted) throw new Error("Processor evidence unavailable");
  // Simulated connection loss AFTER committing success. The retried step reads the same key.
  if (mode === "lost_response")
    throw new Error("Simulated processor response lost");
  return persisted.outcome;
}
export async function reconcileAttempt(db: D1Database, workflowId: string) {
  const a = await loadAttempt(db, workflowId);
  const op = await operation(db, a);
  if (!op) return processAttempt(db, workflowId);
  if (op.outcome !== "unknown") return op.outcome;
  await executeBatch(db, [
    {
      sql: "UPDATE mock_processor_operations SET reconciliation_count=reconciliation_count+1,outcome=CASE WHEN reconciliation_count>=1 THEN 'confirmed_succeeded' ELSE 'unknown' END,receipt_id=CASE WHEN reconciliation_count>=1 THEN ? ELSE NULL END WHERE attempt_key=? AND outcome='unknown'",
      values: [`receipt-${a.attempt_key}`, a.attempt_key]
    },
    {
      sql: "UPDATE refund_attempts SET execution_state='reconciling',updated_at=? WHERE ns=? AND refund_id=? AND attempt_number=? AND execution_state IN ('accepted','running','reconciling')",
      values: [new Date().toISOString(), a.ns, a.refund_id, a.attempt_number]
    }
  ]);
  return (await operation(db, a))!.outcome;
}
export async function markAttention(db: D1Database, workflowId: string) {
  const a = await loadAttempt(db, workflowId);
  if (a.status !== "pending") return;
  await executeBatch(db, [
    {
      sql: "UPDATE refund_attempts SET needs_attention=1,execution_state='reconciling',updated_at=? WHERE ns=? AND refund_id=? AND attempt_number=? AND processor_outcome='unknown'",
      values: [new Date().toISOString(), a.ns, a.refund_id, a.attempt_number]
    },
    event(a, "needs_attention", "pending")
  ]);
}
export async function finalizeAttempt(db: D1Database, workflowId: string) {
  const a = await loadAttempt(db, workflowId);
  const op = await operation(db, a);
  if (!op || op.outcome === "unknown")
    throw new Error("No definitive processor confirmation");
  const status = op.outcome === "confirmed_succeeded" ? "completed" : "failed";
  if (a.status === status && a.execution_state === status) return status;
  if (a.status !== "pending") throw new Error("Conflicting terminal refund");
  const now = new Date().toISOString();
  const effects: Statement[] = [
    {
      sql: "UPDATE refund_attempts SET execution_state=?,processor_outcome=?,failure_code=?,evidence_reference=?,needs_attention=0,updated_at=? WHERE ns=? AND refund_id=? AND attempt_number=? AND execution_state IN ('accepted','running','reconciling')",
      values: [
        status,
        op.outcome,
        status === "failed" ? "MOCK_CONFIRMED_FAILURE" : null,
        `mock:${a.attempt_key}`,
        now,
        a.ns,
        a.refund_id,
        a.attempt_number
      ]
    },
    assertion("changes()=1"),
    {
      sql: "UPDATE refunds SET status=?,version=version+1,updated_at=? WHERE ns=? AND refund_id=? AND current_attempt_number=? AND status='pending' AND version=?",
      values: [status, now, a.ns, a.refund_id, a.attempt_number, a.version]
    },
    assertion("changes()=1")
  ];
  if (status === "completed")
    effects.push(
      {
        sql: "UPDATE orders SET payment_status='refunded',version=version+1,updated_at=? WHERE ns=? AND order_id=? AND customer_id=? AND payment_status='paid' AND total_minor=? AND currency=? AND fulfillment_status IN ('cancelled','shipped','delivered')",
        values: [
          now,
          a.ns,
          a.order_id,
          a.customer_id,
          a.amount_minor,
          a.currency
        ]
      },
      assertion("changes()=1")
    );
  if (a.action_id) {
    const action = await db
      .prepare(
        "SELECT result_json FROM mutation_actions WHERE ns=? AND action_id=?"
      )
      .bind(a.ns, a.action_id)
      .first<{ result_json: string }>();
    const result = JSON.parse(action!.result_json) as Record<string, unknown>;
    const final = dataSchemas.refund_order.parse({
      ...result,
      refund: refundView({
        ...a,
        status,
        execution_state: status,
        processor_outcome: op.outcome,
        needs_attention: 0,
        updated_at: now
      })
    });
    effects.push(
      {
        sql: "UPDATE mutation_actions SET state='completed',result_json=?,updated_at=? WHERE ns=? AND action_id=? AND state='accepted'",
        values: [JSON.stringify(final), now, a.ns, a.action_id]
      },
      assertion("changes()=1")
    );
  }
  effects.push(
    event(a, "processor_confirmed", op.outcome),
    event(a, "finalized", status)
  );
  try {
    await executeBatch(db, effects);
  } catch (error) {
    const latest = await loadAttempt(db, workflowId);
    if (latest.status !== status) throw error;
  }
  return status;
}

export async function dispatchRefunds(
  env: { DB: D1Database; REFUNDS: RefundBinding },
  onlyId?: string
) {
  const { results } = await env.DB.prepare(
    "SELECT d.workflow_instance_id FROM workflow_dispatches d JOIN refunds r ON r.ns=d.ns AND r.refund_id=d.refund_id AND r.current_attempt_number=d.attempt_number WHERE d.state='queued' AND r.status='pending' AND (? IS NULL OR d.workflow_instance_id=?) ORDER BY d.updated_at LIMIT 20"
  )
    .bind(onlyId ?? null, onlyId ?? null)
    .all<{ workflow_instance_id: string }>();
  for (const row of results) {
    const id = row.workflow_instance_id;
    try {
      const a = await loadAttempt(env.DB, id);
      try {
        await env.REFUNDS.create({ id, params: { workflowId: id } });
      } catch {
        const instance = await env.REFUNDS.get(id);
        await instance.status();
      }
      await executeBatch(env.DB, [
        {
          sql: "UPDATE workflow_dispatches SET state='dispatched',last_error_code=NULL,updated_at=? WHERE workflow_instance_id=? AND state='queued'",
          values: [new Date().toISOString(), id]
        },
        event(a, "dispatched", "ok")
      ]);
    } catch {
      await env.DB.prepare(
        "UPDATE workflow_dispatches SET retry_count=retry_count+1,last_error_code='DISPATCH_UNAVAILABLE',updated_at=? WHERE workflow_instance_id=? AND state='queued'"
      )
        .bind(new Date().toISOString(), id)
        .run();
    }
  }
}
