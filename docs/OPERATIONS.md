# Release operations

Milestone 6 is deployed to the demo, with migration 0007 applied. The latest manual
rollout and verification are recorded in PLAN.md section 27. GitHub CI environment
configuration remains a separate setup step.
All money remains simulated. Use Node 24 and the pinned npm lockfile.

## Bootstrap and release order

For local development: `npm ci`, `npm run types`, `npm run db:migrate`,
`npm run db:seed`, then `npm run dev`. Seeding is repeatable and preserves live
session changes; see README for fixture details. No reseed is needed for M6.

For an existing demo release:

1. Run `npm run types:check`, `npm run check`, `npm run fixtures:check`, and `npm test`.
2. Verify the intended Cloudflare account and plan in the dashboard. Check AI Neuron
   usage, Workers, Durable Objects, D1 and Workflows quotas against the account's
   actual plan. Application budgets below do not guarantee the free allowance.
3. Run `npm run db:migrate:demo`. Migration 0007 adds admission counters, expiry
   indexes and a chat-retirement timestamp; it does not change business records.
4. Run `npm run deploy`, which builds demo and deploys private Commerce first, app
   second. Both use the existing ignored `.env` signing key. Do not pass `--env`
   against flattened Vite output or change the account/database identifiers.
5. Run `npm run verify:artifacts`, `npm run smoke:demo`, and the reviewer walkthrough.
   Smoke creates one disposable synthetic session and performs owned reads through
   signed private MCP; it uses no model inference or mutation approval. It deliberately
   does not print credentials or response data.
6. Check `npm run ops:demo` for aggregates, outstanding dispatches, needs-attention
   attempts, admission counts, and foreign-key errors. Check both Workers' deployed
   bindings and confirm Commerce has no route, workers.dev URL, or preview URL.

For a completely new account/database, provision resources explicitly first, record
its database ID in both demo configs, install the same signing secret in both
Workers, migrate, then run `npm run db:seed:demo` **once** to install the sealed v2
catalog before first deployment. CI does not provision resources or automatically
seed a missing catalog. Never run a local reset against demo.

## Protected GitHub deployment

The existing CI verifies push/PRs without deployment credentials. Manual
**workflow_dispatch** with `deploy_demo=true`, on `main`, adds a deployment only
when the verification job passes. A preflight with read-only GitHub permissions
checks the real `demo` environment for required reviewers and an explicit `main`
branch policy. Missing settings or an unreadable API fails closed before the
credential-bearing job. Required reviewers must then approve that environment job.

One-time repository setup (not provisioned by this source change):

- Create GitHub environment `demo`, configure required reviewers, and select `main`
  as a deployment branch. Availability depends on repository visibility/GitHub plan.
- Put `CLOUDFLARE_ACCOUNT_ID` in environment variables, and
  `CLOUDFLARE_API_TOKEN` plus `MCP_CONTEXT_KEY` in environment secrets. Scope the
  Cloudflare token to the target account and required Workers deployments, D1
  migrations and Workflow operations; never paste it into chat or source.
- Protect `main` and require this workflow's `verify` job before merging. Settings
  outside the checkout have not been changed or claimed verified here.

The deploy job migrates but does not reseed/reset. It deploys Commerce before app,
checks signed app-origin MCP reads, and removes its ignored mode-0600 secrets file.
Deployments serialize with cancellation disabled, so migrations are not interrupted
by a second deployment. Fork PRs cannot reach this manually triggered path.

## Application budgets

Limits are source-controlled in `src/usage.ts` and enforced in D1 across isolates.
These are fixed server-time windows, rather than a sliding-window rate promise.
Admission reserves counters conservatively: a later validation/model failure may
still consume a reservation; automatic refunds of counters could allow bypasses.

| Resource | Budget |
| --- | --- |
| API requests and agent connection/history HTTP requests | 180/minute per IP |
| New/replacement session requests | 10/hour per IP, 200/day across demo |
| Accepted chat submissions | 12/minute per session, 40 during its 24-hour lifetime, 500/day across demo |
| Model runs, including SDK recovery | 500/day across demo; at most five model steps/run, 512 output tokens/step, no provider retries, 60-second timeout |
| Model tool calls | 20/run, 160/session lifetime, 2,000/day across demo |
| WebSocket frames | 120/minute per session; unsupported frames still denied |
| Submitted text | 4,000 characters total; only text user messages accepted |
| Conversation passed to model | Latest 12 complete UI messages, oldest dropped while serialized history exceeds 24,000 characters |

IP counter keys use a secret-salted daily hash; raw IPs and chat contents are never
logged by these controls. API denial returns HTTP 429, `Retry-After`, and a safe
code. WebSocket chat denial sends a cooldown notice and terminal skipped response,
so the composer does not remain stuck. Existing explicit approval is still required
for every mutation. Background refund repair is not charged against chat budgets.
The UI preserves quota errors during polling. Shared-IP reviewers share admission
limits. A session-lifetime limit requires waiting for that session's expiry; creating
new sessions does not reset global daily caps.

These controls bound admitted expensive work; they are not a network DDoS filter.
Denied traffic still incurs request/counter reads. Watch platform usage and use
Cloudflare edge protections if the public URL attracts sustained abusive traffic.
Free-plan AI allowance exhaustion can still fail requests before an application cap.

## Retention and monitoring

The application cron runs every 15 minutes. Each pass deletes at most 500 expired
usage-counter rows and retires at most 20 chat histories whose sessions expired more
than seven days ago. A namespace with any pending refund, nonterminal attempt, or
accepted unfinished action is excluded, even if that work belongs to a different
fixture persona. The DO independently checks eligibility before deleting persisted
messages; it stamps retirement only after deletion succeeds. A failed pass is retried
on the next schedule. Live session identities, immutable commerce/audit/processor
records, and refund dispatch/recovery evidence are retained. This is deliberately
not full database erasure or unlimited archival storage; monitor D1 growth and export
ledger/audit evidence before designing a separate archive policy.

Commerce's existing one-minute repair cron remains independent. It recovers accepted
work using the original attempt key and Workflow ID. Unknown outcome stays pending;
never manually mark it failed, create a new payment key, or delete its evidence to
force a retry. Needs-attention means inspect original Workflow/processor evidence
and resume reconciliation of that attempt. Only confirmed no-refund failure can
lead to a new user-approved attempt. A session reset/expiry does not revoke already
accepted background work.

Logs are enabled and traces sampled at 1% for both Workers. New structured events:
`usage_denied` (scope only), `maintenance` (counts), `chat_retirement_failed`.
Use `npm run ops:demo`, Workers AI usage dashboard, Workers Logs, and the Workflow
instance view. Never copy cookies, signing keys, prompts, addresses or ticket bodies
into operational logs. In local dev use the Local Explorer API described in AGENTS.md.

## Rollout and recovery checks

Before deploying, accept a refund in an isolated reviewer session and record its
namespace/attempt/Workflow IDs privately. After deploy, verify it settles exactly
once, the original order/refund state remains, and refresh retains history/results.
The automated suite covers expiry/replacement during accepted work and Workflow
replay. Actual cross-version continuity must also be checked during each rollout;
a successful build or fake-model test is not evidence of a deployed service binding.

If app deployment fails after Commerce succeeds, correct/redeploy the app with the
same account/database/secret. Do not reset data. Migration 0007 is additive and older
code ignores its fields. For code rollback, deploy the previous compatible version;
D1 migrations and accepted Workflow work are not rolled back with code. Retain the
Workflow class/steps until existing instances finish. Investigate schema mismatch,
missing private binding, or signing-key mismatch if signed MCP smoke fails; never
fix it by exposing Commerce publicly or weakening authorization.
