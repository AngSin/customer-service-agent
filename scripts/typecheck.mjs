import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(".wrangler/types", { recursive: true });
const projects = ["tsconfig.json", "workers/commerce/tsconfig.json"];
for (const worker of [
  {
    name: "app",
    base: "tsconfig.json",
    paths: [
      "src/**/*",
      "shared/**/*",
      "vite.config.ts",
      ".wrangler/types/Env-demo.d.ts"
    ]
  },
  {
    name: "commerce",
    base: "workers/commerce/tsconfig.json",
    paths: [
      "workers/commerce/src/**/*",
      "shared/**/*",
      ".wrangler/types/CommerceEnv-demo.d.ts"
    ]
  },
  {
    name: "tests",
    base: "tsconfig.json",
    paths: [
      "tests/harness.ts",
      "tests/security-harness.ts",
      "src/**/*",
      "shared/**/*",
      "env.d.ts"
    ]
  }
]) {
  const path = `.wrangler/types/${worker.name}-tsconfig.json`;
  writeFileSync(
    path,
    JSON.stringify({
      extends: resolve(worker.base),
      include: worker.paths.map((entry) => resolve(entry)),
      exclude: [resolve("node_modules"), resolve("dist")]
    })
  );
  projects.push(path);
}
for (const project of projects) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--noEmit", "--project", project],
    { stdio: "inherit" }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
