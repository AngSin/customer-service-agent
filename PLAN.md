# Customer Service Agent Build Plan

## Summary

Build two TypeScript Cloudflare Workers:

1. **Application Worker** — hosts the React SPA as Worker static assets, routes authenticated demo sessions to a `ChatAgent` Durable Object, and runs Workers AI.
2. **Commerce MCP Worker** — a separate stateless Worker exposing exactly the eight required MCP tools, owning all access to D1, and exporting the refund Workflow.

Retain the starter's Vite, React, Kumo, `AIChatAgent`, streaming, approval UI, and Worker static-assets architecture. Replace the demo tools, scheduling, image handling, and reviewer-configurable MCP connections.

Use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: it remains Cloudflare-hosted, has a 24,000-token context window, and supports function calling. Configure temperature `0`, a stable seed where supported, bounded tool steps, and deterministic business fixtures. See the [Workers AI model documentation](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/).

Before feature development, upgrade the repository's `agents` dependency from `0.17.4` to the current compatible release and update related Cloudflare/AI SDK packages together. Current MCP server code must use the stateless SDK v2 `createMcpHandler` factory; do not use deprecated `McpAgent`. See the [MCP handler documentation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).

## Architecture and Principal Flows

### Application Worker

- Continue serving the SPA through Worker static assets rather than Pages. This fits the existing Vite starter and deploys UI and agent routing as one unit. See the [Static Assets documentation](https://developers.cloudflare.com/workers/static-assets/).
- Keep `ChatAgent extends AIChatAgent`; its Durable Object SQLite stores messages, approval presentation state, selected persona, and conversation metadata only. Commerce records never live there.
- Add:
  - `GET /api/personas` — public summaries of the six synthetic personas.
  - `POST /api/demo-sessions` — validate a persona slug against the committed fixture, create a fresh opaque session/DO identity, bind that session permanently to the persona, and set a `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
  - An explicit “switch persona/start over” action that creates a new session rather than rewriting an existing session's identity.
- Agent/WebSocket routing must derive the Durable Object from the validated session cookie. Reject client-selected DO names that do not match the cookie.
- Remove the UI and callable methods that let reviewers add arbitrary MCP URLs. The application connects only to the configured Commerce MCP Worker.
- Define local AI SDK tool wrappers with the exact public schemas below. Read wrappers execute immediately; mutation wrappers set `needsApproval: true`.
- Treat all tool results and stored order, item, address, and ticket text as untrusted data, never as instructions.

### Trusted identity and MCP boundary

- Deploy the MCP Worker separately and connect from the Application Worker through a Wrangler service binding using stateless MCP-over-HTTP.
- Each MCP request receives a freshly issued server-side authorization assertion. It is never exposed to the browser, model, chat transcript, or public tool inputs.
- Assertion claims: issuer, audience, session ID, authorized synthetic customer ID, allowed scopes, issued/expiry times, and nonce. Sign with HMAC-SHA-256 using a secret installed independently in both Workers.
- MCP middleware verifies signature, issuer, audience, expiry, scope, and session/customer consistency before constructing request auth context.
- Customer IDs appearing in prompts or tool arguments have no authorization value. Public tool schemas deliberately omit `customerId`.
- Browser CORS is disabled for the MCP route; reject unsigned public requests even if the endpoint is reached directly.

### Approval binding

For every cancellation, refund, address change, and ticket creation:

1. Validate and canonicalize the model-proposed arguments.
2. Render a human-readable confirmation containing tool, target order, money amount where applicable, and the exact normalized change.
3. On approval, generate a one-use signed assertion containing `approvalId`, session/customer, tool, target, SHA-256 of canonical arguments, approval timestamp, expiry, and idempotency key.
4. Send it in a transport header on that single stateless MCP `tools/call` request.
5. The MCP Worker recomputes the argument hash and rejects missing, expired, mismatched, or cross-session assertions.
6. Record the assertion and result in `mutation_requests`. An exact retry returns the recorded result; reuse with different arguments fails.
7. Rejection makes no MCP mutation call. The rejection remains in Durable Object conversation history.
8. Re-check authorization and eligibility in D1 at execution time; approval does not reserve eligibility.

The financial audit record stores the approval ID, timestamp, payload hash, idempotency key, actor, result, and target without storing signing tokens or unnecessary PII.

## Public MCP Interfaces

Shared types:

```ts
type Money = {
  currency: string;       // ISO-4217 uppercase
  amountMinor: number;    // integer; never floating point
};

type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND_OR_FORBIDDEN"
  | "NOT_ELIGIBLE"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "CONFLICT"
  | "TEMPORARY_UNAVAILABLE";

type ToolResult<T> =
  | { ok: true; requestId: string; data: T }
  | {
      ok: false;
      requestId: string;
      error: {
        code: ToolErrorCode;
        message: string;
        retryable: boolean;
      };
    };
```

Unknown and foreign-owned records both return `NOT_FOUND_OR_FORBIDDEN`. Raw SQL errors, stack traces, internal IDs, workflow exceptions, and the existence of another customer's record must never be disclosed.

| Tool | Model-visible input and output | Authorization and eligibility | Relevant failures |
|---|---|---|---|
| `get_order` | Input `{ orderId: string }`. Output `ToolResult<{ order: OrderDetail }>` with items, totals, fulfillment/refund summary, and order-specific shipping address. | Require `orders.customer_id = auth.customerId`. Select by order and customer in the same parameterized query. | Invalid ID; unknown/foreign order; temporary D1 failure. |
| `list_customer_orders` | Input `{ status?: OrderStatus, limit?: integer 1..20 }`, default 10. Output `ToolResult<{ orders: OrderSummary[] }>` sorted newest-first with stable ID tie-breaker. | Customer comes exclusively from auth context; no customer ID input. | Invalid filter; temporary D1 failure. |
| `cancel_order` | Input `{ orderId: string, reason?: string <= 200 }`. Output `ToolResult<{ orderId, status: "cancelled", cancelledAt, idempotentReplay }>` | Approval required. Own order; status `pending` or `processing`; `shipped_at IS NULL`; not already refunded. Use a conditional update so a fulfillment race becomes `CONFLICT`. Already-cancelled own orders return the existing result without another transition. | Missing/tampered approval; foreign order; shipped/delivered/refunded order; concurrent state change; idempotency mismatch. |
| `refund_order` | Input `{ orderId: string, reasonCode: "customer_request" \| "item_not_received" \| "damaged_or_incorrect", note?: string <= 500 }`. Output `ToolResult<{ refundId, orderId, amount: Money, status: "pending" \| "completed" \| "failed", workflowInstanceId, idempotentReplay }>` | Approval required. Own paid order in `shipped` or `delivered`; amount is always read from `orders.total_minor`, never supplied by model; one full-order refund record per order. Existing refund returns its current state. | Invalid approval; ineligible/cancelled/unpaid order; duplicate request; workflow trigger temporarily unavailable. |
| `update_shipping_address` | Input `{ orderId, address: { recipient, line1, line2?, city, region, postalCode, countryCode } }`, with bounded strings and two-letter country code. Output `ToolResult<{ orderId, address, version, updatedAt, idempotentReplay }>` | Approval required. Own order; only `pending` or `processing`; not shipped/cancelled. Update only that order's shipping fields. Use the observed order version in a conditional update. Never update the customer profile address. | Invalid address; foreign order; already shipped; concurrent fulfillment/address change; approval mismatch. |
| `get_customer_profile` | Input `{}`. Output `ToolResult<{ profile: { displayName, email, savedAddress } }>` containing synthetic data only. | Lookup exclusively by authenticated customer ID. | Invalid session identity; temporary D1 failure. |
| `create_support_ticket` | Input `{ orderId?: string, category: "order" \| "shipping" \| "refund" \| "other", subject: string 1..100, description: string 1..1000 }`. Output `ToolResult<{ ticketId, status: "open", createdAt, idempotentReplay }>` | Approval required. If an order is supplied, verify ownership before creating the ticket. Store content as inert text. | Foreign order; invalid category/content; approval/idempotency failure. |
| `get_refund_status` | Input `{ refundId: string }`. Output `ToolResult<{ refund: { refundId, orderId, amount: Money, status, failureCode?, requestedAt, completedAt? } }>` | Join refund to its order and require authenticated ownership. Expose only a stable, reviewer-safe failure code. | Unknown/foreign refund; temporary D1 or Workflow-status failure. |

## D1 Schema, State Changes, and Fixtures

### Versioned migration

Create `migrations/0001_initial.sql` with foreign keys, checks, indexes, and these tables:

- `customers`
  - Stable text primary key and unique `persona_slug`.
  - Fake display name, unique `.test` email, synthetic saved-address columns, timestamps.
- `orders`
  - Stable text primary key, `customer_id` foreign key, checked status, currency, integer subtotal/shipping/tax/total minor units, order-specific shipping columns, timestamps, and integer `version`.
  - Checks prevent negative money and inconsistent shipped/cancelled timestamps.
  - Index `(customer_id, placed_at DESC)`.
- `order_items`
  - Stable ID, order foreign key, synthetic SKU/name, positive quantity, non-negative integer unit price, stable sort position.
- `refunds`
  - Stable ID, order/customer foreign keys, full amount/currency, reason, checked status, stable failure code, unique workflow instance ID, timestamps.
  - `UNIQUE(order_id)` enforces at most one refund lifecycle per order.
- `support_tickets`
  - Stable ID, customer and optional order foreign keys, checked category/status, subject/description, timestamps, unique creation idempotency key.
- `mutation_requests`
  - Primary-key idempotency key, unique approval ID, session/customer/action/target, canonical payload hash, checked execution status, result JSON, timestamps.
- `audit_events`
  - Append-only event ID, timestamp, actor/session/customer, action, target, outcome/reason code, approval ID, request/idempotency IDs, payload hash, and redacted metadata JSON.

All runtime SQL uses `DB.prepare(...).bind(...)`; D1 documents parameter binding as the SQL-injection-safe approach. Related writes use `DB.batch()` where atomic batching is sufficient. See [Prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) and [D1 batching](https://developers.cloudflare.com/d1/worker-api/d1-database/).

### Mutation behavior

- Cancellation and address updates use ownership-scoped conditional SQL and optimistic state/version checks.
- Exact idempotent retries return the stored `mutation_requests.result_json`.
- Reusing an idempotency key or approval ID with a different action hash fails without mutation.
- Every execution attempt produces a redacted audit event, including authorization, eligibility, conflict, success, and replay outcomes.
- Logging excludes email, full addresses, free-text ticket content, credentials, and signed assertions.

### Refund Workflow

Export `RefundWorkflow extends WorkflowEntrypoint` from the MCP Worker and bind it in that Worker's Wrangler configuration.

- `refund_order` first inserts the unique pending refund and mutation/audit records, then starts a Workflow with deterministic ID `refund-${refundId}`.
- If Workflow creation succeeds but the response is lost, retrying the same ID retrieves the existing instance instead of creating another.
- If creation fails before acceptance, the pending refund remains discoverable and the same idempotency key safely retries the trigger.
- Workflow steps:
  1. Validate the typed payload and load the pending refund.
  2. Reconfirm ownership-independent financial invariants and terminal status.
  3. Execute the synthetic full-refund adapter using `refundId` as its processor idempotency key.
  4. Conditionally mark the refund `completed` or `failed`.
  5. Append the terminal audit event.
- Each step is individually idempotent; completed refunds are terminal and never execute money movement again. Failed demo refunds retain the same refund ID and are restarted deliberately rather than creating a second refund.
- Use fixed fixture outcomes so the demo does not depend on an external processor. Cloudflare recommends idempotent Workflow steps because steps may retry. See [Workflow reliability rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).

### Synthetic seed

Create an idempotent seed fixture with six unmistakably fictional personas:

- Avery Testwell — `avery@shopper.test`
- Blake Sample — `blake@shopper.test`
- Casey Demo — `casey@shopper.test`
- Devon Fixture — `devon@shopper.test`
- Emery Mock — `emery@shopper.test`
- Finley Sandbox — `finley@shopper.test`

Use stable `cus_*`, `ord_*`, `ref_*`, and `tkt_*` IDs, synthetic street names, and two orders per customer. Include:

- Pending and processing orders eligible for cancellation/address changes.
- Shipped and delivered orders ineligible for cancellation/address changes.
- Cancelled orders.
- No-refund, pending, completed, and failed refund examples.
- Three tickets spanning shipping, refund, and general order issues.
- Easily recognizable adjacent IDs owned by different personas for cross-customer tests.
- One item/ticket fixture containing prompt-injection-like text to verify it remains inert data.

Seed SQL uses stable-key upserts and does not erase runtime records. A separate explicit local reset script deletes fixture/runtime rows in foreign-key order before rerunning the seed.

Commands to document:

```bash
npx wrangler d1 migrations apply DB --local
npx wrangler d1 execute DB --local --file=./seed/demo.sql

npx wrangler d1 execute DB --local --file=./seed/reset-local.sql
npx wrangler d1 execute DB --local --file=./seed/demo.sql
```

For the deployed demo, create a separate D1 database, apply migrations with `--env demo --remote`, and load `seed/demo.sql` through an explicit one-time/manual command. Deployment automation must never run the seed or reset script.

## Repository and Deployment Changes

Organize the implementation around:

```text
src/                         # existing SPA and ChatAgent application Worker
src/shared/                  # tool schemas, DTOs, canonicalization, error codes
workers/commerce-mcp/        # stateless MCP Worker and RefundWorkflow
migrations/                  # versioned D1 schema
seed/                        # idempotent fixture and explicit local reset
test/                        # unit, MCP/D1, Workflow, and end-to-end tests
wrangler.jsonc               # Application Worker
workers/commerce-mcp/wrangler.jsonc
.github/workflows/           # CI and controlled demo deployment
```

Wrangler configuration:

- Application Worker: static assets, `ChatAgent` Durable Object, Workers AI, MCP service binding, non-secret model/config vars.
- MCP Worker: D1 binding, Refund Workflow definition/binding, observability, and no browser CORS.
- Separate local/demo resource names and D1 IDs.
- Run `npx wrangler types` after binding changes and generate types for both configurations.
- Store shared signing keys only through `.dev.vars` locally and `wrangler secret put` remotely; commit only `.dev.vars.example`.
- Use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub environment secrets with least-privilege deployment permissions.

GitHub Actions:

1. Install from the lockfile.
2. Format-check, lint, type-check, and test.
3. Build both Workers.
4. On protected/manual demo deployment, apply pending remote D1 migrations.
5. Deploy the MCP Worker first, then the Application Worker.
6. Run read-only smoke tests.
7. Never provision, seed, reset, or delete D1 automatically.

## Test and Acceptance Plan

- **Authorization:** every read and mutation rejects foreign order/refund IDs with the same response as an unknown ID; model-supplied customer IDs have no effect.
- **Identity:** tampered, expired, wrong-audience, or browser-supplied assertions fail before D1 access.
- **Approval:** mutation cannot run without approval; rejection changes nothing; changing any argument after approval invalidates the assertion; an assertion cannot cross sessions, tools, or targets.
- **Eligibility:** shipped orders cannot be cancelled or re-addressed; cancellation/address races return a conflict; profile address remains unchanged.
- **Money safety:** refund amount always equals the D1 order total; concurrent and repeated refund calls produce one refund and one synthetic processor operation.
- **Idempotency:** exact retries return the same cancellation, address, ticket, or refund result; mismatched payload reuse fails.
- **Workflow:** deterministic success, deterministic failure, retry after ambiguous trigger response, step retry after partial progress, and terminal-completion replay.
- **Audit:** successful, failed, conflicting, and replayed mutations have correlated audit records with no secrets or raw PII.
- **Prompt injection:** malicious text in an item name, address, refund note, or ticket cannot cause extra tool calls, identity changes, approval bypass, or disclosure.
- **E2E reviewer flows:** select each persona; list/get orders; reject and approve each mutation type; observe pending/completed/failed refund states; reproduce results after refresh.
- **Deployment:** verify separate Workers, separate local/demo D1 databases, generated bindings, migration state, health endpoints, and deterministic seeded records.

## Milestones and Acceptance Criteria

1. **Foundation:** upgrade compatible SDK packages, remove obsolete demo surfaces, add shared schemas/configs, and pass the existing build.
2. **Data:** migrations, constraints, seed/reset workflow, and repository tests produce exactly six customers and approximately twelve orders.
3. **Security boundary:** stateless MCP Worker exposes only the eight named tools; identity and ownership tests pass.
4. **Sensitive actions:** approval binding, mutation idempotency, conditional updates, and auditing pass concurrency and tampering tests.
5. **Refund orchestration:** Workflow success/failure/retry cases prove one full-order refund operation.
6. **Reviewer experience:** persona UI and deterministic guided scenarios work from a clean local setup.
7. **Delivery:** Wrangler and GitHub Actions paths deploy in the documented order without automatically reseeding production/demo data.

## Assumptions, Risks, and Unresolved Questions

- Public persona selection is intentionally not real customer authentication; the security property demonstrated is that a session is server-bound to one chosen synthetic identity and model/user-supplied IDs cannot override it.
- Real payment rails, carrier APIs, email delivery, staff dashboards, partial refunds, saved-address editing, and production identity providers are out of scope.
- The supplied screenshot was unavailable and was not inspected.
- The main compatibility risk is upgrading the fast-moving Agents/MCP packages. Mitigate it in milestone 1 with pinned versions, generated types, and a minimal stateless MCP integration test before business logic.
- No product decisions remain unresolved.
