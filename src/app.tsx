import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { refundSchema } from "../shared/commerce-contract";
import { CommerceResultView } from "./commerce-result";
import { ActionSummary, linkActionSummaries } from "./action-summary";
import type { ChatAgent } from "./server";
import type { actionView } from "../shared/consent";

type SessionView = {
  persona: string;
  name: string;
  chatName: string;
  active: boolean;
};
type ActionView = ReturnType<typeof actionView>;
type Bootstrap = {
  session: SessionView | null;
  personas: { id: string; name: string }[];
  csrfToken: string;
};

async function api(path: string, csrf?: string, body?: unknown) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf ?? ""
          },
          body: JSON.stringify(body)
        }
      : {})
  });
  const data = (await response.json()) as Bootstrap & {
    error?: { code: string };
    actions: ActionView[];
    refunds?: unknown[];
    result?: { ok: boolean; error?: { message: string } };
  };
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? `Demo usage limit reached. Try again in ${response.headers.get("Retry-After") ?? "60"} seconds.`
        : (data.error?.code ?? "Request failed")
    );
  return data;
}

function ApprovalCard({
  action,
  csrf,
  refresh
}: {
  action: ActionView;
  csrf: string;
  refresh: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const payload = action.payload as {
    arguments: {
      order_id?: string;
      address?: Record<string, string>;
      category?: string;
      subject?: string;
      body?: string;
    };
    amountMinor?: number;
  };
  const labels: Record<string, string> = {
    cancel_order: "Cancel order",
    refund_order: "Refund order",
    update_shipping_address: "Change shipping address",
    create_support_ticket: "Create support ticket"
  };
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = new Date(action.expiresAt).getTime() <= clock;
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      await api(`/api/actions/${action.actionId}/decision`, csrf, {
        digest: action.digest,
        decision
      });
      if (decision === "approve") await execute();
      refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to record your decision"
      );
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    const data = await api(`/api/actions/${action.actionId}/execute`, csrf, {
      digest: action.digest
    });
    if (data.result && !data.result.ok)
      throw new Error(
        data.result.error?.message ?? "Unable to complete the action"
      );
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await execute();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to complete the action"
      );
    } finally {
      refresh();
      setBusy(false);
    }
  }
  const active =
    action.state === "proposed" &&
    ["pending", "approved"].includes(action.decision) &&
    !expired;
  const approvalLabel =
    action.tool === "cancel_order"
      ? "Approve cancellation"
      : action.tool === "refund_order"
        ? "Approve refund"
        : "Approve action";
  return (
    <Surface
      className={
        active
          ? "rounded-xl border-2 border-amber-400 bg-amber-50 p-5 space-y-3 text-amber-950"
          : "rounded-xl p-4 space-y-2"
      }
    >
      {active && (
        <>
          <h2 className="text-lg font-bold">
            {action.decision === "pending"
              ? "Approval required"
              : "Approved action needs attention"}
          </h2>
          <p>
            {action.decision === "pending"
              ? `Review the details, then click ${approvalLabel} below to continue. No change has been made yet. Sending a chat message does not approve this action.`
              : "Your approval is recorded. Click Retry approved action to finish."}
          </p>
        </>
      )}
      <Text bold>{labels[action.tool] ?? "Proposed action"}</Text>
      {payload.arguments.order_id && <p>Order: {payload.arguments.order_id}</p>}
      {action.tool === "cancel_order" && (
        <p>
          Cancels fulfillment only. To receive a refund, approve cancellation
          first, then request a separate refund approval.
        </p>
      )}
      {payload.amountMinor !== undefined && (
        <p>Full refund: {(payload.amountMinor / 100).toFixed(2)} EUR</p>
      )}
      {payload.arguments.address && (
        <p className="whitespace-pre-wrap">
          {Object.values(payload.arguments.address).join("\n")}
        </p>
      )}
      {payload.arguments.subject && (
        <>
          <p>
            {payload.arguments.category}: {payload.arguments.subject}
          </p>
          <p className="whitespace-pre-wrap">{payload.arguments.body}</p>
        </>
      )}
      <p>Expires: {new Date(action.expiresAt).toLocaleTimeString()}</p>
      <p>
        {expired
          ? "Expired — a new proposal is required."
          : action.decision === "approved"
            ? "Approved — awaiting execution."
            : "Awaiting your decision."}
      </p>
      {action.state === "proposed" &&
        action.decision === "pending" &&
        !expired && (
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {busy ? "Processing…" : approvalLabel}
            </button>
            <button
              type="button"
              className="rounded-lg border border-amber-700 bg-white px-4 py-3 font-semibold text-amber-950 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void decide("reject")}
            >
              Reject
            </button>
          </div>
        )}
      {action.state === "proposed" &&
        action.decision === "approved" &&
        !expired && (
          <Button disabled={busy} onClick={() => void retry()}>
            Retry approved action
          </Button>
        )}
      {error && <p role="alert">{error}</p>}
    </Surface>
  );
}

function Chat({ session, csrf }: { session: SessionView; csrf: string }) {
  const [input, setInput] = useState("");
  const messageField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = messageField.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [input]);
  const [notice, setNotice] = useState("");
  const [actions, setActions] = useState<ActionView[]>([]);
  const [actionClock, setActionClock] = useState(() => Date.now());
  const [currentOrders, setCurrentOrders] = useState<unknown>(null);
  const [refunds, setRefunds] = useState<unknown[]>([]);
  const [refundError, setRefundError] = useState("");
  const refundRequest = useRef(0);
  const refreshRefunds = useCallback(() => {
    const request = ++refundRequest.current;
    void api("/api/refunds")
      .then((data) => {
        if (request !== refundRequest.current) return;
        setRefunds(data.refunds ?? []);
        setRefundError("");
      })
      .catch((error: unknown) => {
        if (request === refundRequest.current)
          setRefundError(
            error instanceof Error
              ? error.message
              : "Unable to refresh refunds. Please retry."
          );
      });
  }, []);
  const pendingRefund = refunds.some((r) => {
    const parsed = refundSchema.safeParse(r);
    return parsed.success && parsed.data.status === "pending";
  });
  const [ordersError, setOrdersError] = useState("");
  const orderRequest = useRef(0);
  const refundRevision = refunds
    .map((refund) => {
      const parsed = refundSchema.safeParse(refund);
      return parsed.success
        ? `${parsed.data.refund_id}:${parsed.data.status}`
        : "";
    })
    .join(",");
  const orderRevision = actions
    .map((a) => `${a.actionId}:${a.state}`)
    .join(",");
  const refreshOrders = useCallback(() => {
    const request = ++orderRequest.current;
    void api("/api/orders")
      .then((data) => {
        if (request !== orderRequest.current) return;
        setCurrentOrders(data);
        setOrdersError("");
      })
      .catch((error: unknown) => {
        if (request === orderRequest.current)
          setOrdersError(
            error instanceof Error
              ? error.message
              : "Unable to refresh orders. Please retry."
          );
      });
  }, []);
  useEffect(() => {
    refreshOrders();
  }, [refreshOrders, orderRevision, refundRevision]);
  useEffect(() => {
    refreshRefunds();
  }, [refreshRefunds, orderRevision]);
  useEffect(() => {
    if (!pendingRefund) return;
    const timer = setInterval(refreshRefunds, 3000);
    return () => clearInterval(timer);
  }, [pendingRefund, refreshRefunds]);
  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: session.chatName,
    onMessage: (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          message: string;
        };
        if (["identity_switch_denied", "usage_limit"].includes(message.type))
          setNotice(message.message);
      } catch {
        /* Streaming text is handled by the chat SDK. */
      }
    }
  });
  const { messages, sendMessage, status, stop, error } = useAgentChat({
    agent
  });
  const busy = status === "streaming" || status === "submitted";
  const refresh = useCallback(() => {
    void api("/api/actions")
      .then((data) => {
        setActions(data.actions);
        setActionClock(Date.now());
      })
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error
            ? error.message
            : "Your session may have expired. Refresh to reconnect."
        )
      );
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh, busy]);
  const activeActions = actions.filter(
    (action) =>
      action.state === "proposed" &&
      ["pending", "approved"].includes(action.decision) &&
      new Date(action.expiresAt).getTime() > actionClock
  );
  const previousActions = actions.filter(
    (action) => !activeActions.includes(action)
  );
  const summaries = linkActionSummaries(messages, previousActions);
  return (
    <>
      <Surface className="rounded-xl p-4 space-y-2" aria-label="Current orders">
        <Text bold>Current orders</Text>
        {currentOrders != null && (
          <CommerceResultView
            name="list_customer_orders"
            result={currentOrders}
          />
        )}
        {ordersError && <p role="alert">{ordersError}</p>}
        <Button onClick={refreshOrders}>Refresh orders</Button>
      </Surface>
      {(refunds.length > 0 || refundError) && (
        <Surface
          className="rounded-xl p-4 space-y-2"
          aria-label="Current refunds"
        >
          <Text bold>Current refunds</Text>
          {refunds.map((refund, i) => (
            <CommerceResultView
              key={i}
              name="get_refund_status"
              result={{ ok: true, data: { refund }, request_id: "current" }}
            />
          ))}
          {refundError && <p role="alert">{refundError}</p>}
          <Button onClick={refreshRefunds}>Refresh refunds</Button>
        </Surface>
      )}
      <section
        aria-label="Conversation"
        className="rounded-xl border border-slate-200 bg-slate-100 p-4 space-y-4 min-h-64 text-slate-950"
      >
        {messages.length === 0 && (
          <p>
            Ask about your previous orders, delivery details, or saved address.
          </p>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            aria-label={
              message.role === "user" ? "Your message" : "Assistant message"
            }
            className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 shadow-sm break-words"
          >
            <p className="text-sm font-semibold text-slate-600">
              {message.role === "user" ? "You" : "Assistant"}
            </p>
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <p className="whitespace-pre-wrap" key={index}>
                  {part.text}
                </p>
              ) : "output" in part && part.state === "output-available" ? (
                <div key={index} className="rounded-lg border p-3">
                  <p>Shop result when checked:</p>
                  <CommerceResultView
                    name={
                      part.type === "dynamic-tool"
                        ? part.toolName
                        : part.type.replace(/^tool-/, "")
                    }
                    result={part.output}
                  />
                </div>
              ) : null
            )}
            {summaries.byMessage.get(message.id)?.map((action) => (
              <ActionSummary
                key={action.actionId}
                action={action}
                now={actionClock}
              />
            ))}
          </article>
        ))}
        {summaries.unlinked.map((action) => (
          <article
            key={action.actionId}
            aria-label="Action update"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <ActionSummary action={action} now={actionClock} />
          </article>
        ))}
      </section>
      <section
        aria-label="Actions awaiting approval"
        aria-live="polite"
        className="space-y-3"
      >
        {activeActions.map((action) => (
          <ApprovalCard
            key={action.actionId}
            action={action}
            csrf={csrf}
            refresh={refresh}
          />
        ))}
      </section>
      <form
        className="w-full space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim() || busy) return;
          setNotice("");
          void sendMessage({ text: input }).catch(() =>
            setNotice("Unable to send. Refresh to reconnect.")
          );
          setInput("");
        }}
      >
        <textarea
          ref={messageField}
          rows={1}
          className="block w-full min-h-11 resize-none rounded-lg border px-3 py-2"
          aria-label="Message"
          aria-describedby="message-keyboard-hint"
          placeholder="Type a message…"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <p id="message-keyboard-hint" className="text-sm">
          Enter to send · Shift+Enter for a new line
        </p>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !input.trim()}>
            Send
          </Button>
          {busy && (
            <Button type="button" onClick={() => void stop()}>
              Stop
            </Button>
          )}
        </div>
      </form>
      {(notice || error) && (
        <p role="alert">
          {notice || "Unable to connect. Refresh to check your session."}
        </p>
      )}
    </>
  );
}

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [persona, setPersona] = useState("ada");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const replacement = useRef<{ key: string; persona: string } | null>(null);
  useEffect(() => {
    void api("/api/session")
      .then(setData)
      .catch(() => setError("Unable to load the demo. Refresh to retry."));
  }, []);
  async function start() {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const active = data.session?.active;
      if (!replacement.current || replacement.current.persona !== persona)
        replacement.current = { key: crypto.randomUUID(), persona };
      const result = await api(
        active ? "/api/sessions/replace" : "/api/sessions",
        data.csrfToken,
        { persona, ...(active ? { requestKey: replacement.current.key } : {}) }
      );
      setData({ ...data, session: result.session });
      replacement.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to start a session");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <header className="space-y-2">
        <Text as="h1" size="lg" bold>
          Example Parcel Shop
        </Text>
        <p>Choose a fictional customer to start an isolated demo session.</p>
      </header>
      {data && (
        <Surface className="rounded-xl p-4 space-y-3">
          {data.session?.active && (
            <p>
              Current customer: <strong>{data.session.name}</strong>
            </p>
          )}
          <label className="block">
            Customer for new session{" "}
            <select
              aria-label="Customer for new session"
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
            >
              {data.personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy} onClick={() => void start()}>
            {data.session?.active ? "Start new session" : "Start session"}
          </Button>
          {data.session?.active && (
            <p>
              Starting again creates a fresh chat and invalidates unexecuted
              approvals in this session.
            </p>
          )}
        </Surface>
      )}
      {error && <p role="alert">{error}</p>}
      {data?.session?.active && (
        <Chat
          key={data.session.chatName}
          session={data.session}
          csrf={data.csrfToken}
        />
      )}
    </main>
  );
}
