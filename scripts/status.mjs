import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// D1 --file is an import path: it discards SELECT result rows. Use --command
// with a structured argument so the operational checks actually print results.
const sql = await readFile(new URL("./status.sql", import.meta.url), "utf8");
const result = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "customer-service-demo",
    "--remote",
    "--env",
    "demo",
    "--config",
    "workers/commerce/wrangler.jsonc",
    `--command=${sql}`,
    "--json"
  ],
  { stdio: "inherit", timeout: 60000 }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
