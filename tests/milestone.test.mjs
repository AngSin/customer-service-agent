import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf, directory;
const databaseId = "00000000-0000-0000-0000-000000000001";
const bindingConfig = {
  MCP_CONTEXT_KEY: randomBytes(32).toString("hex"),
  MCP_AUDIENCE: "commerce-mcp:local",
  APP_STAGE: "local",
  MODEL_MODE: "fake"
};

before(
  async () => {
    directory = await mkdtemp(join(tmpdir(), "csa-milestone-1-"));
    const workers = [];
    for (const [name, entry] of [
      ["customer-service-agent", "src/server.ts"],
      ["customer-service-commerce", "workers/commerce/src/index.ts"],
      ["test-harness", "tests/harness.ts"]
    ]) {
      const scriptPath = join(directory, `${name}.mjs`);
      await build({
        entryPoints: [entry],
        outfile: scriptPath,
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        conditions: ["workerd", "worker", "browser"],
        external: ["cloudflare:*", "node:*"],
        logLevel: "warning",
        banner: {
          js: 'globalThis.fetch = () => { throw new Error("Global network fetch forbidden in CI"); };'
        },
        plugins: [
          {
            name: "worker-node-builtins",
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, ({ path }) =>
                builtinModules.includes(path)
                  ? {
                      path: path.startsWith("node:") ? path : `node:${path}`,
                      external: true
                    }
                  : undefined
              );
            }
          }
        ]
      });
      workers.push({
        name,
        scriptPath,
        modulesRoot: directory,
        modules: true,
        compatibilityDate: "2026-06-11",
        compatibilityFlags: ["nodejs_compat"],
        bindings: bindingConfig,
        d1Databases: { DB: databaseId },
        serviceBindings:
          name === "customer-service-commerce"
            ? {}
            : { COMMERCE_MCP: "customer-service-commerce" },
        durableObjects:
          name === "customer-service-agent"
            ? { ChatAgent: { className: "ChatAgent", useSQLite: true } }
            : {}
      });
    }
    mf = new Miniflare(
      convertV4MiniflareOptions({ workers, d1Persist: join(directory, "d1") })
    );
    const db = await mf.getD1Database("DB", "customer-service-agent");
    const statements = (await readFile("tests/fixtures/probe.sql", "utf8"))
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean);
    await db.batch(statements.map((sql) => db.prepare(sql)));
  },
  { timeout: 60000 }
);

after(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fetchHarness(path) {
  return (await mf.getWorker("test-harness")).fetch(
    `https://test.internal${path}`
  );
}

test("MCP handshake/catalog/read uses signed service-binding fetch and shared D1", async () => {
  const response = await fetchHarness("/transport");
  assert.equal(response.status, 200);
  const { probe, calls } = await response.json();
  assert.deepEqual(probe.tools, ["milestone_ping"]);
  assert.equal(probe.appMarker, "milestone-1-local-d1");
  assert.equal(probe.commerce.marker, probe.appMarker);
  assert.equal(probe.commerce.subject, "milestone-1-probe");
  assert.ok(calls.length >= 3);
  assert.ok(
    calls.every(
      (call) =>
        call.signed &&
        !call.cookie &&
        call.url === "https://commerce-mcp.internal/mcp"
    )
  );
  assert.ok(
    calls.some((call) => call.contentType?.includes("text/event-stream"))
  );
});

for (const kind of [
  "missing",
  "signature",
  "audience",
  "expired",
  "future",
  "malformed"
]) {
  test(`commerce rejects ${kind} context even through a valid binding`, async () => {
    const response = await fetchHarness(`/context/${kind}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  });
}

test("adapter rejects alternate hosts and redirects, strips cookies, never falls back", async () => {
  assert.deepEqual(await (await fetchHarness("/adapter-guards")).json(), {
    destinationRejected: true,
    redirectRejected: true,
    called: 1
  });
});

test("no commerce mutation tool is registered", async () => {
  assert.deepEqual(await (await fetchHarness("/unknown-tool")).json(), {
    rejected: true
  });
});

test("fake AI SDK model executes the same bound MCP tool with no Cloudflare access", async () => {
  const response = await fetchHarness("/fake-model");
  const result = await response.json();
  assert.match(result.text, /No commerce mutations/);
  assert.equal(result.results.length, 1);
  assert.equal(
    result.results[0].output.commerce.marker,
    "milestone-1-local-d1"
  );
});

test("fake-model streamed chat includes tool result and final text", async () => {
  const response = await fetchHarness("/fake-stream");
  const stream = await response.text();
  assert.match(stream, /tool-output-available/);
  assert.match(stream, /milestone-1-local-d1/);
  assert.match(stream, /No commerce mutations/);
});

test("Application Worker probe resolves its actual binding", async () => {
  const app = await mf.getWorker("customer-service-agent");
  const response = await app.fetch("https://app.internal/api/milestone/probe");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tools, ["milestone_ping"]);
  assert.equal(
    (
      await app.fetch("https://app.internal/mcp", {
        method: "POST",
        body: "{}"
      })
    ).status,
    404
  );
});
