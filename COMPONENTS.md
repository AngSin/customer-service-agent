# Cloudflare components

Resources configured in this repo; default/local names and deployed demo names are listed below.

| Product / feature | Component and purpose |
| --- | --- |
| Workers — application | `customer-service-agent` / `customer-service-agent-demo`: serves the frontend, session and approval APIs, and routes chat requests to `ChatAgent`. |
| Workers — commerce | `customer-service-commerce` / `customer-service-commerce-demo`: private MCP server for customer, order, support-ticket, cancellation and refund tools. Accessible through the application's `COMMERCE_MCP` service binding; no public URL. |
| Workers Static Assets | Hosts the React single-page application and its static files alongside the application Worker. **Cloudflare Pages is not used.** |
| Durable Objects + Agents SDK | SQLite-backed `ChatAgent` (binding `ChatAgent`): manages each chat's persisted messages, state and live connections. |
| D1 | `commerce-local` (local development) / `customer-service-demo` (deployed demo), binding `DB` in both Workers: shared customers, orders, sessions, approvals, audit records, refunds, processor simulation and usage counters. |
| Workflows | One workflow class, `RefundWorkflow`, named `commerce-refunds-local` / `commerce-refunds-demo` (binding `REFUNDS` on Commerce): validates accepted refunds, executes the simulated processor, reconciles uncertain outcomes and finalizes results, with retries and waits. |
| Workers AI | Application binding `AI`: runs `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for chat and tool selection in the demo. Local development uses a fake model by default. |
| Cron Triggers | Application: every 15 minutes, removes expired usage counters and retires eligible expired chats. Commerce: every minute, dispatches and repairs refund work. |
| Workers Observability | Logs and sampled traces enabled on both Workers; application source maps uploaded for debugging. |
| Workers Secrets | `MCP_CONTEXT_KEY`, shared by both Workers, signs and verifies session context for private MCP requests. |

Configuration: [application Worker](wrangler.jsonc), [Commerce Worker](workers/commerce/wrangler.jsonc), [local/build setup](vite.config.ts). KV, R2, Queues and Vectorize are not configured.

Product references: [Workers](https://developers.cloudflare.com/workers/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [D1](https://developers.cloudflare.com/d1/), [Workflows](https://developers.cloudflare.com/workflows/), [Workers AI](https://developers.cloudflare.com/workers-ai/).
