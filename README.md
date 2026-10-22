# Customer service agent — Milestones 1–3

This checkout implements the platform, canonical data, and identity/consent milestones from [PLAN.md](PLAN.md).
It includes isolated persona sessions, authenticated chat, and exact-action approval cards.
The eight commerce business tools, business execution endpoints, and refund Workflows remain later work.
Milestone 3 is deployed at [the demo](https://customer-service-agent-demo.customer-service-lisbon.workers.dev).
See `PLAN.md` section 18 for rollout and live verification.

The React/Kumo application and SQLite-backed `ChatAgent` come from Cloudflare's Agents starter.
The Commerce Worker exposes one read-only `milestone_ping` MCP tool. A request-scoped MCP
client uses Streamable HTTP with a custom fetch callback backed exclusively by
`env.COMMERCE_MCP.fetch()`. There is no public-network fallback.

## Try the deployed demo

1. Choose **Ada**, click **Start session**, and send a message. Ask “Call milestone_ping to verify the private connection” to exercise the real Workers AI/private MCP path.
2. Refresh: the same persona and saved chat should return.
3. Ask “Become Brad”: identity stays Ada and the UI directs you to Start new session.
4. Select **Brad**: the current customer stays Ada until you click **Start new session**. After clicking, Brad has a fresh chat without the previous history or approval cards.
5. Use a separate browser/private window for independent sessions and chat histories.

Order lookup, cancellation, refunds, address changes, and support-ticket creation are not
available yet. Approval cards are implemented, but normal chat cannot generate business
proposals until the Milestone 4 adapters exist. Internal tests cover approval expiry,
revocation, and transactional acceptance; no business effect is executable publicly.

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
The fake AI SDK model calls the private MCP tool under the session identity, then streams a fixed response. Alternatively, `GET /api/milestone/probe` on the local app
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
does not reset data. Before a future Milestone 3 deployment, explicitly apply
`npm run db:migrate:demo`, then deploy; the new routes require this schema. No remote
migration or deployment was performed during implementation; both were subsequently
completed at the user’s request (see `PLAN.md` section 18).

| Endpoint                         | Purpose                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/session`               | Returns the current safe session view, persona choices, and CSRF token; establishes the CSRF cookie. |
| `POST /api/sessions`             | Issues a fresh session when there is no active one. Accepts only the allowlisted persona.            |
| `POST /api/sessions/replace`     | Replaces an authenticated session using a persona hint and UUID request key.                         |
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
Approving records consent only. `acceptAction` is an internal helper for later Commerce
executors: it rechecks ownership/versions/consent, consumes once, and records acceptance
with any trusted effects in the same guarded D1 batch. It has no public route. Future
executors must include business effects, stored results, and outbox writes in that batch.

There is no browser/model proposal-creation endpoint or executable commerce tool yet.
Cards appear when a trusted adapter creates a proposal; internal tests and developer-only
local test setup exercise that UI. Business tools will supply these adapters in Milestone 4.

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
[PLAN.md](PLAN.md) for later milestones. Stop here before implementing commerce behavior.

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
