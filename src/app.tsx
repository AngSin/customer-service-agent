import { useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import { Button, InputArea, Surface, Text } from "@cloudflare/kumo";
import type { ChatAgent } from "./server";

export default function App() {
  const [input, setInput] = useState("");
  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: "milestone-1"
  });
  const { messages, sendMessage, status, stop } = useAgentChat({ agent });
  const busy = status === "streaming" || status === "submitted";
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <header className="space-y-2">
        <Text as="h1" size="lg" bold>
          Customer service agent — Milestone 1
        </Text>
        <p>
          Transport proof only. The local fake model calls one read-only MCP
          probe. Customer sessions, orders, refunds, approvals, and other
          business actions are not implemented.
        </p>
      </header>
      <Surface className="rounded-xl p-4 space-y-4 min-h-64">
        {messages.length === 0 && (
          <p>Send “Check the private MCP connection” to run the probe.</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <Text bold>{message.role}</Text>
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <p key={index}>{part.text}</p>
              ) : isToolUIPart(part) ? (
                <pre
                  key={index}
                  className="text-xs whitespace-pre-wrap overflow-auto"
                >
                  {JSON.stringify(part, null, 2)}
                </pre>
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
          void sendMessage({ text: input });
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
      <p className="text-sm">
        Demo agent routes remain disabled until session authorization is
        implemented.
      </p>
    </main>
  );
}
