import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { startLocalRuntime } from "./local-runtime.mjs";

// Read-only identity check. Capture its output so account details/credentials
// are never printed; never run wrangler login or provision an account/resource.
const env = {
  ...process.env,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: resolve(".wrangler/logs")
};
const identity = spawnSync(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "whoami", "--json"],
  { env, encoding: "utf8", timeout: 30000 }
);
if (identity.status !== 0) {
  console.log(
    "SKIPPED live Workers AI smoke: existing Cloudflare authentication is unavailable or could not be verified. No login was attempted."
  );
  process.exit(0);
}
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId) {
  const info = JSON.parse(identity.stdout);
  if (info.accounts?.length === 1) accountId = info.accounts[0].id;
}
if (!accountId) {
  console.log(
    "SKIPPED live Workers AI smoke: authenticated account selection is ambiguous; set CLOUDFLARE_ACCOUNT_ID for a later opt-in run."
  );
  process.exit(0);
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
  { env, encoding: "utf8" }
);
assert.equal(seed.status, 0, "Local D1 probe fixture initialization failed");
const runtime = await startLocalRuntime({ live: true, port: 5188, accountId });
try {
  const response = await fetch(`${runtime.base}/api/milestone/live`, {
    method: "POST",
    signal: AbortSignal.timeout(90000)
  });
  assert.equal(response.status, 200, await response.text());
  console.log(
    "PASSED live Llama 3.3 tool call through private MCP binding and shared local D1."
  );
} finally {
  await runtime.stop();
}
