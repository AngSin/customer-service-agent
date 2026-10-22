import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Button, InputArea, Surface, Text } from "@cloudflare/kumo";
import { CommerceResultView } from "./commerce-result";
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
    result?: { ok: boolean; error?: { message: string } };
  };
  if (!response.ok) throw new Error(data.error?.code ?? "Request failed");
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
  return (
    <Surface className="rounded-xl p-4 space-y-2">
      <Text bold>{labels[action.tool] ?? "Proposed action"}</Text>
      {payload.arguments.order_id && <p>Order: {payload.arguments.order_id}</p>}
      {action.tool === "cancel_order" && (
        <p>Stops fulfillment. Payment will not be refunded.</p>
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
        {["accepted", "completed"].includes(action.state)
          ? action.state
          : expired && ["pending", "approved"].includes(action.decision)
            ? "Expired — a new proposal is required."
            : action.decision}
      </p>
      {action.state === "proposed" &&
        action.decision === "pending" &&
        !expired && (
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void decide("approve")}>
              Approve
            </Button>
            <Button disabled={busy} onClick={() => void decide("reject")}>
              Reject
            </Button>
          </div>
        )}
      {action.state === "proposed" &&
        action.decision === "approved" &&
        !expired && (
          <Button disabled={busy} onClick={() => void retry()}>
            Retry approved action
          </Button>
        )}
      {action.state === "completed" && action.result != null && (
        <CommerceResultView
          name={action.tool}
          result={{ ok: true, data: action.result, request_id: "stored" }}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </Surface>
  );
}

function Chat({ session, csrf }: { session: SessionView; csrf: string }) {
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [actions, setActions] = useState<ActionView[]>([]);
  const [currentOrders, setCurrentOrders] = useState<unknown>(null);
  const [ordersError, setOrdersError] = useState("");
  const orderRequest = useRef(0);
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
      .catch(() => {
        if (request === orderRequest.current)
          setOrdersError("Unable to refresh orders. Please retry.");
      });
  }, []);
  useEffect(() => {
    refreshOrders();
  }, [refreshOrders, orderRevision]);
  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: session.chatName,
    onMessage: (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          message: string;
        };
        if (message.type === "identity_switch_denied")
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
      .then((data) => setActions(data.actions))
      .catch(() =>
        setNotice("Your session may have expired. Refresh to reconnect.")
      );
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
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
      <Surface className="rounded-xl p-4 space-y-4 min-h-64">
        {messages.length === 0 && (
          <p>
            Ask about your previous orders, delivery details, or saved address.
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <Text bold>{message.role}</Text>
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
          </div>
        ))}
      </Surface>
      <form
        className="flex gap-2"
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
        <InputArea
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          Send
        </Button>
        {busy && (
          <Button type="button" onClick={() => void stop()}>
            Stop
          </Button>
        )}
      </form>
      {(notice || error) && (
        <p role="alert">
          {notice || "Unable to connect. Refresh to check your session."}
        </p>
      )}
      <section aria-label="Actions awaiting approval" className="space-y-3">
        {actions.map((action) => (
          <ApprovalCard
            key={action.actionId}
            action={action}
            csrf={csrf}
            refresh={refresh}
          />
        ))}
      </section>
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
