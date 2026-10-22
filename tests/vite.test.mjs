import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { startLocalRuntime } from "../scripts/local-runtime.mjs";
import { MessageType } from "agents/chat";
import { WebSocket } from "ws";

test(
  "Vite runs both Workers locally, binds commerce, and sees the seeded D1 marker",
  { timeout: 40000 },
  async () => {
    for (const command of ["db:migrate", "db:seed"]) {
      const result = spawnSync("npm", ["run", command], {
        encoding: "utf8",
        env: {
          ...process.env,
          CLOUDFLARE_ENV: "",
          WRANGLER_SEND_METRICS: "false"
        }
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const seed = spawnSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "d1",
        "execute",
        "commerce-local",
        "--local",
        "--config",
        "workers/commerce/wrangler.jsonc",
        "--persist-to",
        ".wrangler/state",
        "--file",
        "tests/fixtures/probe.sql"
      ],
      {
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve(".wrangler/logs")
        },
        encoding: "utf8"
      }
    );
    assert.equal(seed.status, 0, seed.stderr);
    const runtime = await startLocalRuntime();
    try {
      const response = await fetch(`${runtime.base}/api/milestone/probe`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.appMarker, "milestone-1-local-d1");
      assert.equal(result.commerce.marker, result.appMarker);
      assert.deepEqual(result.tools, ["milestone_ping"]);
      const inventory = await (
        await fetch(`${runtime.base}/cdn-cgi/local/explorer/api/local/workers`)
      ).json();
      assert.deepEqual(inventory.result.map((worker) => worker.name).sort(), [
        "customer-service-agent",
        "customer-service-commerce"
      ]);
      const dbIds = inventory.result.map((worker) => worker.bindings.d1[0].id);
      assert.equal(dbIds[0], dbIds[1]);

      const bootstrap = await fetch(`${runtime.base}/api/session`);
      const { csrfToken } = await bootstrap.json();
      const csrfCookie = `__Host-csa_csrf=${csrfToken}`;
      const created = await fetch(`${runtime.base}/api/sessions`, {
        method: "POST",
        headers: {
          Origin: runtime.base,
          Cookie: csrfCookie,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ persona: "ada" })
      });
      assert.equal(created.status, 200, await created.clone().text());
      const { session } = await created.json();
      const sessionCookie = created.headers.get("Set-Cookie").split(";")[0];
      // Exercise the real AIChatAgent/DO protocol, not just streamText in a harness.
      const socket = new WebSocket(
        `${runtime.base.replace("http:", "ws:")}/agents/chat-agent/${session.chatName}`,
        {
          headers: {
            Origin: runtime.base,
            Cookie: `${csrfCookie}; ${sessionCookie}`
          }
        }
      );
      try {
        await new Promise((resolve, reject) => {
          let frames = "";
          const timeout = setTimeout(
            () => reject(new Error("AIChatAgent fake-model turn timed out")),
            15000
          );
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            reject(new Error("Chat WebSocket failed"));
          });
          socket.addEventListener("open", () =>
            socket.send(
              JSON.stringify({
                type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
                id: "milestone-chat-turn",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "probe-user",
                        role: "user",
                        parts: [
                          {
                            type: "text",
                            text: "Check the private MCP connection"
                          }
                        ]
                      }
                    ]
                  })
                }
              })
            )
          );
          socket.addEventListener("message", (event) => {
            frames += String(event.data);
            if (
              frames.includes("session-authorized") &&
              frames.includes("No commerce mutations")
            ) {
              clearTimeout(timeout);
              resolve();
            }
          });
        });
      } finally {
        socket.close();
      }
    } finally {
      await runtime.stop();
    }
  }
);
