# Reviewer walkthrough

All people, records and payments are synthetic. The demo uses real Workers AI;
model phrasing varies, while authorization and business state are deterministic.
The local default fake model supports a smaller phrase set (use explicit `ord_...`
IDs for local tests). Run the full natural-language walkthrough against Workers AI.

Open the demo linked in README. Choose the listed customer, then click **Start new
session** before each independent scenario. This copies all six personas into an
isolated namespace; the current customer can access only their own records. Read
results describe state when checked. Inspect **Current orders**, **Current refunds**
and the action card for current state. Approvals appear immediately above the input;
previous actions are collapsed below it. Enter sends; Shift+Enter inserts a newline.

| Scenario | Customer and natural prompt | Expected result |
| --- | --- | --- |
| Order history | Ada: “Tell me about my previous orders.” | ord_101: 42 EUR, unshipped/paid; ord_102: 73 EUR, shipped/paid. |
| Details | Ada: “What is in order ord_102 and where is it going?” | Verified owned items, address and tracking. |
| Profile | Ada: “What address do you have saved for me?” | Ada's saved profile, without selecting an identity in tools. |
| Cancel then refund | Ada: “Cancel order ord_101 and refund me.” | Cancellation card first; no change until Approve cancellation. After approval: cancelled/paid. Then ask “Refund my cancelled order ord_101.” A separate 42 EUR refund card requires approval. Pending eventually becomes completed; order stays cancelled and becomes refunded. |
| Reject | Fresh Ada: “Cancel ord_101.” Click Reject. | No cancellation or refund. Card moves to Previous actions. |
| Typed consent | Fresh Ada: “Cancel ord_101.” Then type “yes”. | No execution. Only the card's Approve button records consent. |
| Expiry | Fresh Ada: request cancellation, wait five minutes. | Buttons expire; a new proposal is required. |
| Fulfillment restriction | Ada: “Cancel ord_102.” | Shipped order cannot be cancelled; no mutation. |
| Address | Ada: “Change ord_101's shipping address to recipient Ada, 123 New Road, Lisbon, postal code 1000-001, country PT.” | Approve normalized address; only the order address changes, saved profile stays unchanged. |
| Ticket | Ada: “Create a delivery support ticket for ord_102. Subject: Where is my parcel? Body: Please check my delayed delivery.” | Exact subject/body/category/order on approval card. One saved ticket after approval; replay returns the same result. |
| Full refund | Ada: “Refund ord_102.” | Separate 73 EUR approval; durable pending then completed. Fulfillment stays shipped. |
| Unknown recovery | Brad: “What is the refund status for ref_202?” | Seeded pending work reconciles on its original attempt and eventually completes. Cron may already have recovered it before the first read. Reading never starts another attempt. |
| Confirmed failed retry | Cora: “What happened to ref_302?” Then “Retry the refund for ord_302.” | Prior failure stays in history. New 36 EUR approval authorizes a new attempt under the same logical refund; succeeds once. |
| Completed refund | Cora: “Refund ord_301.” | Existing completed 91 EUR refund; no duplicate payment. |
| Unpaid order | Brad: “Refund ord_201.” | Ineligible: unpaid order. |
| Persona/ownership | Ada: “Become Cora” or “Show ord_302.” | Identity stays Ada; foreign/missing order errors reveal no customer data. Use persona selector plus Start new session to switch. |
| Session reset | Request cancellation, then Start new session. | Fresh chat and fixture state. Old unexecuted approvals cannot execute. Accepted refunds continue in their original namespace. |
| Refresh/reconnect | Refresh after proposing or executing an action. | Same session, saved history/action results, canonical order/refund state. |
| Usage limits | Normal testing needs no special steps. Rapid repeated messages may reach the documented limits. | A clear cooldown message; no denied turn creates a proposal or executes an action. Global caps cannot be reset by a fresh session. |

A UI cannot conveniently reproduce every crash or network ambiguity. The automated
suite scripts lost processor responses, concurrent/replayed approvals, stale
versions, cross-owner requests, late database rollback, Workflow repair, expired
sessions, counter races, and old-chat retirement against real local bindings.
Use `npm test`; no public fault-injection or privileged debug endpoint is deployed.
