import type { UIMessage } from "ai";
import type { actionView } from "../shared/consent";
import {
  dataSchemas,
  failureSchema,
  refundSchema,
  type ToolName
} from "../shared/commerce-contract";
import { CommerceResultView } from "./commerce-result";

type ActionView = ReturnType<typeof actionView>;
type Outcome = {
  label: string;
  tone: "success" | "failure" | "pending" | "neutral";
  detail?: string;
};

export function actionOutcome(action: ActionView, now: number): Outcome {
  if (action.state === "conflict")
    return {
      label: "Action not applied",
      tone: "failure",
      detail:
        "The proposal could not be applied. Request a new proposal with the current details."
    };
  if (["accepted", "completed"].includes(action.state)) {
    const result =
      action.tool in dataSchemas
        ? dataSchemas[action.tool as ToolName].safeParse(action.result)
        : null;
    if (result?.success) {
      if (action.tool === "refund_order") {
        const refund = refundSchema.parse(
          (result.data as { refund: unknown }).refund
        );
        if (refund.status === "failed")
          return { label: "Refund failed", tone: "failure" };
        if (refund.status === "completed")
          return { label: "Refund completed", tone: "success" };
        return {
          label: refund.needs_attention
            ? "Refund needs attention"
            : "Refund processing",
          tone: "pending"
        };
      }
      if (action.state === "completed")
        return {
          label:
            {
              cancel_order: "Order cancelled",
              update_shipping_address: "Shipping address updated",
              create_support_ticket: "Support ticket created"
            }[action.tool] ?? "Action finished",
          tone: "success"
        };
    }
    return {
      label:
        action.state === "accepted"
          ? "Action processing"
          : "Action result unavailable",
      tone: "pending",
      detail: "Refresh to check the verified result before assuming success."
    };
  }
  if (action.decision === "revoked")
    return {
      label: "Approval revoked",
      tone: "neutral",
      detail: "This proposal can no longer be executed."
    };
  if (action.decision === "rejected" || action.state === "rejected")
    return {
      label: "Action rejected",
      tone: "neutral",
      detail: "You rejected this proposal. It was not executed."
    };
  if (new Date(action.expiresAt).getTime() <= now)
    return {
      label: "Approval expired",
      tone: "pending",
      detail:
        "This proposal was not executed. Request a new proposal to continue."
    };
  return { label: "Awaiting approval", tone: "pending" };
}

// Attach each canonical action to its original proposal message, once. Actions
// whose original messages were pruned still appear at the end of the conversation.
export function linkActionSummaries(
  messages: readonly Pick<UIMessage, "id" | "parts">[],
  actions: readonly ActionView[]
) {
  const messageIds = new Map<string, string>();
  for (const message of messages)
    for (const part of message.parts) {
      if (!("output" in part) || part.state !== "output-available") continue;
      const parsed = failureSchema.safeParse(part.output);
      if (
        parsed.success &&
        parsed.data.error.code === "APPROVAL_REQUIRED" &&
        parsed.data.proposal &&
        !messageIds.has(parsed.data.proposal.actionId)
      )
        messageIds.set(parsed.data.proposal.actionId, message.id);
    }
  const byMessage = new Map<string, ActionView[]>();
  const unlinked: ActionView[] = [];
  const seen = new Set<string>();
  for (const action of [...actions].reverse()) {
    if (seen.has(action.actionId)) continue;
    seen.add(action.actionId);
    const messageId = messageIds.get(action.actionId);
    if (messageId)
      byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), action]);
    else unlinked.push(action);
  }
  return { byMessage, unlinked };
}

const tones = {
  success: "border-emerald-500 bg-emerald-50 text-emerald-950",
  failure: "border-rose-500 bg-rose-50 text-rose-950",
  pending: "border-amber-500 bg-amber-50 text-amber-950",
  neutral: "border-slate-400 bg-slate-100 text-slate-900"
};
export function ActionSummary({
  action,
  now
}: {
  action: ActionView;
  now: number;
}) {
  const outcome = actionOutcome(action, now);
  const payload = action.payload as {
    arguments?: { order_id?: unknown };
  } | null;
  const orderId = payload?.arguments?.order_id;
  const requested =
    {
      cancel_order: "Cancel order",
      refund_order: "Refund order",
      update_shipping_address: "Change shipping address",
      create_support_ticket: "Create support ticket"
    }[action.tool] ?? "Shop action";
  const valid =
    action.tool in dataSchemas &&
    dataSchemas[action.tool as ToolName].safeParse(action.result).success;
  return (
    <section
      aria-label={outcome.label}
      className={`rounded-lg border-l-4 p-4 space-y-2 ${tones[outcome.tone]}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide">
        Action update
      </p>
      <h3 className="font-bold">{outcome.label}</h3>
      <p className="text-sm">
        {requested}
        {typeof orderId === "string" ? ` · ${orderId}` : ""}
      </p>
      {outcome.detail && <p>{outcome.detail}</p>}
      {valid && ["accepted", "completed"].includes(action.state) && (
        <CommerceResultView
          name={action.tool}
          result={{ ok: true, data: action.result, request_id: "stored" }}
        />
      )}
    </section>
  );
}
