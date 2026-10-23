### Testing:

Deployed on: [Example Parcel Shop](https://customer-service-agent-demo.customer-service-lisbon.workers.dev).

For setup and architecture, see [TECH.md](TECH.md).

Choose the customer and click Start new session before each independent test. That restores their starting data. Every mutation requires clicking Approve.

Some example flows:

1. Successful cancellation → refund — Ada, ord_101
   “Cancel order ord_101.” Approve cancellation. Then: “Refund my cancelled order ord_101.” Approve the separate refund. Final state: cancelled/refunded.
2. Actual refund processing failure → retry — Elin, ord_501
   “Refund order ord_501.” Approve and wait for failure. Then: “Retry the refund for ord_501.” Approve again. This tests a processing failure rather than an eligibility rejection.
3. Recovery after a lost response — Fenn, ord_601
   “Refund order ord_601.” Approve once. It should eventually complete; the internal connection failure may resolve too quickly to notice in the UI.
4. Existing failed refund — Cora, ord_302
   “What happened to refund ref_302?” Then: “Retry the refund for ord_302.” Approve the retry.

**These are the starting states for a fresh session. Your actions can change them within that session; other reviewers have isolated data. Click Start new session to restore the starting data.**

Full summary of the seeded/sample data in the database:

| Customer / order | Starting state | Cancellation | Refund |
| --- | --- | --- | --- |
| Ada — ord_101 (€42) | Unshipped, paid | Succeeds | Succeeds after cancellation, with separate approval |
| Ada — ord_102 (€73) | Shipped, paid | Rejected: shipped | Succeeds |
| Brad — ord_201 (€19) | Unshipped, unpaid | Succeeds | Rejected: unpaid |
| Brad — ord_202 (€58) | Delivered, refund pending | Rejected: delivered | Existing pending refund recovers to success |
| Cora — ord_301 (€91) | Delivered, already refunded | Rejected: delivered | Returns existing completed refund; no duplicate |
| Cora — ord_302 (€36) | Shipped, previous refund failed | Rejected: shipped | Newly approved retry succeeds |
| Dax — ord_401 (€65) | Already cancelled, paid | Already cancelled | Succeeds directly |
| Dax — ord_402 (€27) | Unshipped, paid | Succeeds | Succeeds after cancellation |
| Elin — ord_501 (€81) | Delivered, paid | Rejected: delivered | First approved attempt fails; separately approved retry succeeds |
| Elin — ord_502 (€33) | Unshipped, paid | Succeeds | Succeeds after cancellation |
| Fenn — ord_601 (€49) | Shipped, paid | Rejected: shipped | Simulates a lost processor response, then recovers successfully without a duplicate refund |
| Fenn — ord_602 (€22) | Cancelled, unpaid | Already cancelled | Rejected: unpaid |
