import { randomBytes } from "node:crypto";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

export default defineConfig(({ command }) => {
  const local = command === "serve" && !process.env.CLOUDFLARE_ENV;
  const live = local && process.env.MILESTONE_LIVE_AI === "1";
  // Ephemeral, local-only test key; never emitted into built demo artifacts.
  const localKey = randomBytes(32).toString("hex");
  // Wrangler loads declared secrets after vars. Keep root .env deployment
  // secrets from overriding only one Worker's ephemeral local signing key.
  if (local) process.env.MCP_CONTEXT_KEY = localKey;
  return {
    plugins: [
      agents(),
      react(),
      cloudflare({
        configPath: "./wrangler.jsonc",
        config: (config) =>
          local
            ? {
                vars: {
                  ...config.vars,
                  MCP_CONTEXT_KEY: localKey,
                  MODEL_MODE: live ? "workers-ai" : "fake"
                }
              }
            : {},
        auxiliaryWorkers: [
          {
            configPath: "./workers/commerce/wrangler.jsonc",
            config: (config) =>
              local
                ? { vars: { ...config.vars, MCP_CONTEXT_KEY: localKey } }
                : {}
          }
        ],
        persistState: { path: ".wrangler/state" },
        inspectorPort: false,
        remoteBindings: live
      }),
      tailwindcss()
    ]
  };
});
