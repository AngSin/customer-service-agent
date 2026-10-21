import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const check = process.argv.includes("--check");
mkdirSync(".wrangler/logs", { recursive: true });
mkdirSync(".wrangler/types", { recursive: true });
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: resolve(".wrangler/logs")
};
for (const worker of [
  { config: "wrangler.jsonc", output: "env.d.ts", name: "Env" },
  {
    config: "workers/commerce/wrangler.jsonc",
    output: "workers/commerce/env.d.ts",
    name: "CommerceEnv"
  }
]) {
  for (const environment of ["local", "demo"]) {
    const output =
      environment === "local"
        ? worker.output
        : `.wrangler/types/${worker.name}-demo.d.ts`;
    const args = [
      "node_modules/wrangler/bin/wrangler.js",
      "types",
      output,
      "--config",
      worker.config,
      "--env-interface",
      worker.name,
      "--strict-vars=false"
    ];
    if (environment === "demo") args.push("--env", "demo");
    if (check) args.push("--check");
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
