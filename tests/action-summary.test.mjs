import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const { outputFiles } = await build({
  entryPoints: ["src/action-summary.tsx"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic"
});
const { actionOutcome, linkActionSummaries, ActionSummary } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const now = Date.parse("2026-10-23T12:00:00Z");
const action = (changes = {}) => ({
  actionId: "action_1",
  digest: "a".repeat(64),
  tool: "refund_order",
  payload: { arguments: { order_id: "ord_501" } },
  state: "completed",
  expiresAt: "2026-10-23T11:00:00Z",
  decision: "approved",
  result: {
    action_id: "action_1",
    replayed: false,
    disposition: "accepted",
    refund: {
      refund_id: "ref_1",
      order_id: "ord_501",
      amount_minor: 8100,
      currency: "EUR",
      status: "failed",
      attempt_number: 1,
      outcome: "confirmed_no_refund",
      retry_requires_approval: true,
      needs_attention: false,
      updated_at: "2026-10-23T11:59:00Z"
    }
  },
  ...changes
});
const refundAction = (status, changes = {}) => {
  const value = action(changes);
  value.result.refund = {
    ...value.result.refund,
    status,
    outcome: status === "completed" ? "confirmed_succeeded" : "unknown",
    ...changes.refund
  };
  return value;
};
test("completed processing of a failed refund is red and never labelled successful", () => {
  assert.deepEqual(actionOutcome(action(), now), {
    label: "Refund failed",
    tone: "failure"
  });
  const html = renderToStaticMarkup(
    createElement(ActionSummary, { action: action(), now })
  );
  assert.match(html, /Refund failed/);
  assert.match(html, /bg-rose-50/);
  assert.match(html, /ord_501/);
  assert.match(html, /failed.*81.00 EUR/);
  assert.doesNotMatch(html, /Refund completed|bg-emerald/);
});
test("pending and attention refunds remain amber, even when action processing finished", () => {
  assert.deepEqual(actionOutcome(refundAction("pending"), now), {
    label: "Refund processing",
    tone: "pending"
  });
  assert.deepEqual(
    actionOutcome(
      refundAction("pending", { refund: { needs_attention: true } }),
      now
    ),
    { label: "Refund needs attention", tone: "pending" }
  );
});
test("only verified successful refund is green; old expiry never hides accepted outcomes", () => {
  assert.deepEqual(actionOutcome(refundAction("completed"), now), {
    label: "Refund completed",
    tone: "success"
  });
  assert.equal(
    actionOutcome(action({ result: null }), now).label,
    "Action result unavailable"
  );
  assert.notEqual(
    actionOutcome(action({ result: { refund: { status: "completed" } } }), now)
      .tone,
    "success"
  );
});
test("rejected, revoked, expired and conflicting proposals explain what happened", () => {
  for (const [changes, label] of [
    [{ state: "proposed", decision: "rejected" }, "Action rejected"],
    [{ state: "proposed", decision: "revoked" }, "Approval revoked"],
    [{ state: "proposed", decision: "pending" }, "Approval expired"],
    [{ state: "conflict" }, "Action not applied"]
  ])
    assert.equal(actionOutcome(action(changes), now).label, label);
});
const message = (id, value) => ({
  id,
  parts: [
    {
      type: "dynamic-tool",
      toolName: "refund_order",
      toolCallId: id,
      state: "output-available",
      output: {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: "Approval required",
          retryable: false
        },
        request_id: "request_1",
        proposal: value
      }
    }
  ]
});
test("action updates attach once to the original proposal and survive message pruning", () => {
  const value = action();
  const orphan = action({ actionId: "older_action" });
  const { byMessage, unlinked } = linkActionSummaries(
    [message("original", value), message("repeated", value)],
    [value, orphan, value]
  );
  assert.deepEqual(byMessage.get("original"), [value]);
  assert.equal(byMessage.has("repeated"), false);
  assert.deepEqual(unlinked, [orphan]);
});
test("malformed historical tool output cannot claim a canonical action's position", () => {
  const { byMessage, unlinked } = linkActionSummaries(
    [message("malformed", { actionId: "action_1" })],
    [action()]
  );
  assert.equal(byMessage.size, 0);
  assert.equal(unlinked.length, 1);
});
