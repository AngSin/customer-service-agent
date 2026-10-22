# Customer service agent — Milestones 1–4

This checkout implements the platform, canonical data, identity/consent, and commerce-tool
milestones from [PLAN.md](PLAN.md). Milestone 4 adds owned order/profile/refund reads and
approved cancellation, shipping-address, and support-ticket writes. Refund execution and
retries remain Milestone 5 work.

The [deployed demo](https://customer-service-agent-demo.customer-service-lisbon.workers.dev)
now runs Milestone 4 with the existing customer-name migration and fixture v2.
See `PLAN.md` sections 18–21 for rollout status and implementation evidence.

The React/Kumo application and SQLite-backed `ChatAgent` come from Cloudflare's Agents starter.
The private Commerce Worker exposes eight business MCP tools to authenticated sessions.
A request-scoped client uses Streamable HTTP exclusively through `env.COMMERCE_MCP.fetch()`;
there is no public-network fallback. The legacy `milestone_ping` tool remains available
only to the separate local transport-test context, not the session business catalog.

## Try Milestone 4 locally

After the setup below, choose **Ada** and click **Start session**. Natural-language examples:

1. “Tell me the details of all the orders I placed previously.” Ada owns `ord_101` and `ord_102`.
2. “What do you know about order ord_102?” Inspect items, shipping address and tracking.
3. “What address do you have saved for me?” The profile uses the current session identity.
4. “Cancel ord_101.” Inspect the action card and click **Approve** or **Reject**. Typing “yes”
   does not approve. After approval, fulfillment is cancelled while payment stays paid;
   the card explicitly says payment has not been refunded.
5. In a fresh session, ask “Change ord_101's shipping address to recipient Ada, 123 New Road,
   Lisbon, postal code 1000-001, country PT.” Approve the exact normalized address.
   The order changes; the saved customer profile address stays unchanged.
6. “Create a delivery support ticket for ord_102. Subject: Where is my parcel? Body: Please
   check my delayed delivery.” Approve the complete text; duplicate execution retries
   return the same ticket.
7. Start a **Brad** session and ask “What is the refund status for ref_202?” It is pending.
   **Cora** has completed `ref_301` and failed `ref_302`. Reads never start or restart work.

The **Current orders** panel loads canonical data from private MCP when the chat mounts,
when proposal/completion state changes, or when **Refresh orders** is clicked. Historical
chat tool results are labelled “when checked”; completed approval cards retain their saved
result after refresh. If a response is lost after approving, use **Retry approved action**;
the same action ID cannot apply its effects twice. Unaccepted approvals expire after five
minutes and are revoked by **Start new session**. Use a private browser window for an
independent session; chat cannot change customer identity.

New refunds and failed-refund retries return a clear unavailable message (`FEATURE_UNAVAILABLE`)
and create no approval, attempt, ledger entry, dispatch, or Workflow. Pending/completed refunds
return existing status. No real payments, emails, or external ticket system are involved.

## Run locally

Use Node 24 and npm. No Cloudflare login is needed for the default fake-model path.

```bash
npm ci
npm run types
npm run db:migrate
npm run db:seed
npm run db:probe
npm run dev
```

Open the Vite URL, choose a fictional customer, and click **Start session** before sending a message.
The fake AI SDK model routes a small set of test phrases (previous orders, explicit order IDs,
cancellation, and profile/connection checks) to real private MCP tools, then streams a fixed
response. It is a test fixture, not a full natural-language model. Alternatively, `GET /api/milestone/probe` on the local app
returns the marker read independently through both Workers' D1 bindings.

Vite starts Commerce as an auxiliary Worker. It has no separate public listener.
An ephemeral random signing key is injected into both Workers only during default local
Vite development. No real credential is committed; that key is not emitted into builds.
Signed context has a fixed **test-only** subject/scope, a 60-second expiry, issuer, audience,
and nonce. Commerce verifies it before MCP dispatch, even through the service binding.
This legacy context is accepted only by the local probe path. Session chat uses separate signed claims
loaded from D1, and Commerce rejects the legacy probe context in demo.

`tests/fixtures/probe.sql` initializes one marker table in the **local emulator**. It is not
commerce schema/seed data or a Milestone 2 migration. The setup is idempotent and preserves
an existing marker. Both default Worker configs bind `commerce-local` using the same local
database ID, separate from `customer-service-demo`. The demo Workers were deployed after
Milestone 1; Milestone 2 does not automatically migrate or seed their remote database.

## Migrate and seed commerce data

Stop local development while applying migrations or resetting. Use Node 24, including for
the data scripts, which import the shared TypeScript fixture helpers directly.

```bash
npm run db:migrate
npm run db:seed
npm run db:verify
```

These commands use the local emulator at `.wrangler/state/v3/d1`, shared with Vite and
`db:probe`. No Cloudflare login is required. The first three migrations create commerce,
consent/audit, and refund execution **tables**, without enabling business actions or
starting Workflows. Wrangler tracks applied files in `d1_migrations`; never edit an
applied migration after release. Append a new migration instead.

`db:seed` installs immutable fixture catalog `v2` and creates `local_reference`, an
inspection namespace with six fictional customers, twelve orders/items, three tickets,
and coherent pending/completed/failed refund histories. Money is integer EUR cents;
all emails end in `.test`. Pending history has a queued dispatch row but remains pending
until Milestone 5 implements execution. The reference namespace is bound to Ada and has
mutations disabled; its deterministic token hash is not a usable browser credential.

Running `db:seed` again validates the catalog and preserves existing namespaces, changed
orders, and audit history. A changed checksum/payload under the same version fails; introduce a new
fixture version for future changes. The trusted `provisionNamespace` helper in
`shared/fixtures.ts` copies the installed catalog into a fresh server-issued namespace
in one atomic D1 batch. IDs are stable inside each namespace; processor/Workflow keys
are namespace-specific. Milestone 3 session endpoints use this same transactional provisioning helper.

To discard **all local commerce namespaces**, retaining migration history, the immutable
catalog, and the Milestone 1 probe marker:

```bash
npm run db:reset
npm run db:seed
```

Local data commands reject extra arguments such as `--remote`, `--env demo`, and
`--config`, and refuse to run with `CLOUDFLARE_ENV` set. Reset executes a transactional
deletion in dependency order and restores the append-only audit trigger. No demo reset
command or public seed/reset endpoint exists. Do not manually execute `reset-local.sql`
against a remote database.

For an **explicit demo bootstrap**, check both configs point to the intended shared demo
database, authenticate Wrangler, and run these separately from deployment:

```bash
npm run db:migrate:demo
npm run db:seed:demo
```

Remote seeding installs only the catalog; it creates no reference/browser session and
does not reset existing commerce. Deploys never seed or reset data. These remote commands
were added and documented in Milestone 2. They were subsequently run successfully on
2026-10-22 at the user’s request; see the rollout record in `PLAN.md` section 16.
The remote database contains the sealed catalog and no session namespaces yet.

`shared/fixtures.ts` is the source of fixture values. `fixtures/seed-v2.sql` is its checked-in
catalog SQL for the explicit remote bootstrap. Run `npm run fixtures:generate` when
authoring a new fixture version and `npm run fixtures:check` to detect drift. Do not use
generation to replace an already installed version's contents.

## Session identity and approval boundary

The welcome selector is a hint from an allowlist. The server resolves it to a synthetic
customer, creates a random namespace/chat name and opaque credential, and stores only
its hash. Cookies use `Secure`, `HttpOnly`, `SameSite=Strict`, and path `/`. The current
persona label comes from server state. Selecting another option does not change it.
**Start new session** is the only supported persona-change flow: it creates fresh fixtures
and chat, revokes unconsumed approvals in the old session, and leaves already accepted
work intact. Duplicate replacement requests resolve to the same successor, including
retries after the successor cookie was installed.

`0004_session_boundary.sql` adds the replacement lineage table and prevents inserting
an approval with fabricated pre-approved/consumed timestamps. Run `npm run db:migrate`
when upgrading an existing local checkout. It appends to the existing migrations and
does not reset data. This migration and the customer-name migration are already applied
to the demo (see `PLAN.md` sections 18–19). Milestone 4 uses the same schema.

| Endpoint                         | Purpose                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/session`               | Returns the current safe session view, persona choices, and CSRF token; establishes the CSRF cookie. |
| `POST /api/sessions`             | Issues a fresh session when there is no active one. Accepts only the allowlisted persona.            |
| `POST /api/sessions/replace`     | Replaces an authenticated session using a persona hint and UUID request key.                         |
| `GET /api/orders`                | Rehydrates the current customer’s first 20 orders through private MCP.                               |
| `POST /api/actions/:id/execute`  | Executes or replays the exact approved stored action through private MCP.                            |
| `GET /api/actions`               | Lists proposals/decisions owned by the authenticated persona and namespace.                          |
| `POST /api/actions/:id/decision` | Records Approve/Reject for the exact proposal digest.                                                |

Writes require matching Origin, the CSRF cookie, and `X-CSRF-Token`. WebSocket upgrades
require the same origin and the authenticated session. History routes accept only the
server-derived chat name. Open sockets recheck D1 on every frame; expired/revoked sockets
close. Browser RPC, state updates, client tool results, and SDK approval messages cannot
bypass these checks. Browser-supplied chat history cannot overwrite server history.

The trusted `createProposal` helper validates owned targets, eligibility, normalized
arguments, canonical amount/versions, and the session epoch. Proposals expire after five
minutes. Cards show the exact action and consequences; a chat “yes” does not approve.
The decision endpoint records consent only; the browser then calls the execution endpoint.
`acceptAction` rechecks ownership/versions/consent, consumes once, and records acceptance
with trusted business effects and stored results in the same guarded D1 batch. The helper
itself is internal. Refund outbox effects remain future Milestone 5 work.

There is no browser proposal-creation endpoint. Model tool calls create proposals through
the authenticated private Commerce adapter. Neither model-visible arguments nor browser
SDK approval messages can execute a write without exact stored button consent.

Every session MCP request is signed with a fresh short-lived context derived from D1.
Commerce independently validates its signature, issuer/audience/key ID, expiry, scope,
namespace, persona, session epoch, and active consent for mutation scope. Session cookies
and signed contexts are never forwarded to the model or exposed in the UI. A service
binding alone does not authorize a customer action.

## Verify

```bash
npm run types
npm run types:check
npm run check
npm run fixtures:check
npm test
npm run build:demo
npm run verify:artifacts
```

Type generation covers Application and Commerce, default/local and demo environments.
The two default generated declarations are tracked; demo declarations live under ignored
`.wrangler/types/` and are checked in separate TypeScript projects. Rerun `npm run types`
after binding changes. `types:check` verifies the generated declarations are current.

Tests use real local Workers, D1, and the SDK transport. Global network fetch is blocked
inside the test bundles. They cover MCP handshake/catalog/SSE tool results, shared D1,
missing/invalid/expired/wrong-audience context, destination/redirect guards, absence of
commerce tools, and fake-model generation/streaming. Data tests apply all migrations to
isolated D1 instances and cover fixtures, constraints, namespace isolation, transactional
rollback, seed preservation, and reset safeguards. A Vite integration test also checks
the actual auxiliary binding and chat Durable Object. CI runs these checks without
Cloudflare credentials and never deploys.

Formatting is scoped to application/milestone files; prompt history and generated types
are preserved. Existing unrelated formatting issues in repository guidance/editor/security
configuration are not rewritten by this milestone.

## Opt-in live Workers AI smoke

```bash
npm run smoke:ai
```

The command first runs a read-only `wrangler whoami --json` check, capturing account details.
It skips with a clear message if existing authentication cannot be verified, or account
selection is ambiguous. It never opens a login flow. If needed, select an already authorized
account with `CLOUDFLARE_ACCOUNT_ID` in your environment; do not put credentials in source.

With existing authentication, it starts a separate local Vite runtime and enables **only**
the remote AI binding. Llama 3.3 (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) must call
`milestone_ping` through the private binding and read the local D1 marker. Only inference
uses Cloudflare; commerce and D1 stay local. This consumes Workers AI inference usage but
creates no deployed Worker or database. The local live endpoint is disabled in fake mode
and in demo. The command stops its runtime after completion.

## Private binding and demo configuration

| Environment   | Application Worker            | `COMMERCE_MCP` target            |
| ------------- | ----------------------------- | -------------------------------- |
| Default/local | `customer-service-agent`      | `customer-service-commerce`      |
| Demo          | `customer-service-agent-demo` | `customer-service-commerce-demo` |

Commerce has `workers_dev: false`, `preview_urls: false`, and `routes: []` in both environments.
The logical URL `https://commerce-mcp.internal/mcp` is metadata for the HTTP transport;
Wrangler's service binding selects the target Worker. It needs no DNS record or route.
The adapter supplies Host, preserves MCP headers/body/streaming/cancellation, replaces
Authorization with signed context, strips cookies, and rejects redirects/alternate URLs.

`npm run build:demo` selects `CLOUDFLARE_ENV=demo` before Vite builds.
`npm run verify:artifacts` checks the emitted binding target, private Commerce ingress,
shared demo database, required secret declaration, and absence of local keys or
refund Workflows. This validates build configuration, **not deployed binding resolution**.
To deploy, configure the demo D1 database in both Worker configs and put `MCP_CONTEXT_KEY`
in the root `.env` file. Run `npm run deploy` to build with `CLOUDFLARE_ENV=demo`, deploy
Commerce first, and then deploy the app. Both deploy commands read the same `.env` file
so the Workers share the signing key. Auxiliary Workers must be deployed individually.
Selecting `--env demo` only after a default Vite build does not select the demo build configuration.
The Commerce build may warn that `MCP_CONTEXT_KEY` is missing because it does not read the
root `.env`; deployment supplies it through `--secrets-file .env`. Missing runtime secrets fail closed.

## Verified package/API choices

| Package                | Pin          |
| ---------------------- | ------------ |
| `agents`               | `0.29.0`     |
| `@cloudflare/ai-chat`  | `0.12.2`     |
| `ai`                   | `7.0.148`    |
| `@ai-sdk/provider`     | `4.0.31`     |
| `@ai-sdk/react`        | `4.0.152`    |
| MCP client/server      | `2.3.1` each |
| Cloudflare Vite plugin | `1.64.0`     |
| Wrangler               | `4.151.3`    |

Current official [Workers AI SDK documentation](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/)
deprecates `workers-ai-provider` in favor of `createAI` from `agents/models/ai-sdk`.
The implementation uses that supported built-in provider with AI SDK 7/provider interface 4.
Intermediate Agents/chat releases passed declared peer ranges but failed real export/bundle
checks, so the aligned current stable stack above was selected and tested instead. No
`--force` or `--legacy-peer-deps` dependency resolution was used.

The published [MCP transport API](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/streamableHttp.html)
and installed declarations expose the custom fetch callback. The Commerce handler uses
`createMcpHandler` from `agents/mcp/server`, a fresh server per request, and the SDK's
Workers-compatible JSON-schema validator. Test infrastructure uses Miniflare 5's exported
`convertV4MiniflareOptions` helper; test bundle module roots are explicit to support temporary
output paths. The existing compatibility date and ChatAgent `v1` migration are preserved.

See [PROMPTS.md](PROMPTS.md) for the verbatim requirements/interview history and
[PLAN.md](PLAN.md) for delivered behavior and the remaining refund/release milestones.

Migration `0005_customer_names.sql` preserves the sealed `v1` catalog and installs
`v2` with Ada, Brad, Cora, Dax, Elin, and Fenn. It updates original customer names
and address recipients in existing namespaces, preserving custom recipients and
all customer IDs (Brad still uses `cus_bram`). Changed orders increment their
version so pending approvals based on an older order version cannot execute.
Historical approval payloads and audit records remain unchanged. Apply with
`npm run db:migrate` locally, or `npm run db:migrate:demo` for the demo, and deploy
the matching application code together: older code provisions from `v1`, while
the updated code provisions from `v2`. No reset or additional seed is needed.
`fixtures/seed-v1.sql` remains the historical catalog snapshot.

## Milestone 4 approval execution and rollout

Business schemas are defined in `shared/commerce-contract.ts`, scoped reads and transactional
writes in `shared/commerce.ts`, and the exact eight-tool session catalog in the Commerce Worker.
Tool results validate against strict success/error envelopes. Order cursors are signed for the
current namespace/customer. Foreign and missing record IDs return the same safe not-found error.

A model mutation call creates an immutable proposal and returns `APPROVAL_REQUIRED`. The browser
records a CSRF/Origin-protected `/decision`, then invokes `/execute` with the same action ID and
digest. The application loads the stored arguments and sends signed action-scoped context through
private MCP. Commerce independently verifies consent and exact arguments before accepting.
Consumption, business effects, stored result, and audit are one guarded D1 transaction. Completed
replays return stored results; rejected, expired, revoked, stale, or altered actions cannot write.
New ticket creation is limited to 20 approved tickets per session.

Milestone 4 needs no new schema migration: Milestones 2–3 already supplied action results,
approval/audit records, and commerce tables. Normal deploy uses `npm run deploy`; do not reset or
reseed existing sessions. The previously deployed database already includes migrations 0001–0005.
To test with real Workers AI locally, run `MILESTONE_LIVE_AI=1 npm run dev` using existing
Cloudflare authentication. Commerce and D1 stay local; model inference uses the AI binding.
