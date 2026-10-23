import assert from "node:assert/strict";

// Fixed deployment target; no tokens, cookies or customer data printed.
const base =
  "https://customer-service-agent-demo.customer-service-lisbon.workers.dev";
const get = (path, headers = {}) =>
  fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(30000) });
assert.equal((await get("/")).status, 200);
const boot = await get("/api/session");
assert.equal(boot.status, 200);
const { personas, csrfToken } = await boot.json();
assert.equal(personas.length, 6);
const created = await fetch(`${base}/api/sessions`, {
  method: "POST",
  signal: AbortSignal.timeout(30000),
  headers: {
    Origin: base,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
    Cookie: `__Host-csa_csrf=${csrfToken}`
  },
  body: JSON.stringify({ persona: "ada" })
});
assert.equal(created.status, 200);
const cookie = created.headers.get("set-cookie").split(";")[0];
const orders = await get("/api/orders", { Cookie: cookie });
assert.equal(orders.status, 200);
const result = await orders.json();
assert.equal(result.ok, true);
assert.deepEqual(
  result.data.orders.map((order) => order.order_id),
  ["ord_101", "ord_102"]
);
assert.equal((await get("/api/orders")).status, 401);
assert.equal((await get("/api/milestone/probe")).status, 404);
console.log(
  "Demo app, isolated session, signed private MCP owned reads and anonymous denial passed. No model inference or mutation approval used."
);
