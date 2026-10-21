import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { resolve } from "node:path";

export async function startLocalRuntime({
  live = false,
  port = 5187,
  accountId
} = {}) {
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: resolve(".wrangler/logs")
  };
  delete env.CLOUDFLARE_ENV;
  delete env.MILESTONE_LIVE_AI;
  if (live) env.MILESTONE_LIVE_AI = "1";
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const child = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort"
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-12000);
    });
  const base = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Vite exited during startup: ${output}`);
      if (output.includes("Local:")) return { base, stop };
      await delay(100);
    }
    throw new Error("Local Vite startup timed out");
  } catch (error) {
    await stop();
    throw error;
  }
}
