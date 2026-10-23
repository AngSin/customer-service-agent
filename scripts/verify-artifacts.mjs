import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const app = await read("dist/customer_service_agent/wrangler.json");
const commerce = await read("dist/customer_service_commerce/wrangler.json");
assert.equal(app.name, "customer-service-agent-demo");
assert.ok(app.assets.run_worker_first.includes("/mcp"));
assert.ok(!("PUBLIC_MCP_TOKEN" in app.vars));
assert.ok(!("PUBLIC_MCP_TOKEN" in commerce.vars));
assert.deepEqual(app.services, [
  { binding: "COMMERCE_MCP", service: "customer-service-commerce-demo" }
]);
assert.equal(commerce.name, "customer-service-commerce-demo");
assert.equal(commerce.workers_dev, false);
assert.equal(commerce.preview_urls, false);
assert.deepEqual(commerce.routes, []);
assert.equal(app.vars.APP_STAGE, "demo");
assert.equal(app.vars.MCP_AUDIENCE, "commerce-mcp:demo");
assert.equal(commerce.vars.MCP_AUDIENCE, app.vars.MCP_AUDIENCE);
assert.equal(
  app.d1_databases[0].database_id,
  commerce.d1_databases[0].database_id
);
assert.equal(app.d1_databases[0].database_name, "customer-service-demo");
assert.match(app.d1_databases[0].database_id, /^[a-f0-9-]{36}$/);
assert.notEqual(
  app.d1_databases[0].database_id,
  "00000000-0000-0000-0000-000000000001"
);
for (const config of [app, commerce]) {
  assert.ok(
    !("MCP_CONTEXT_KEY" in config.vars),
    "Local test key must not enter demo artifacts"
  );
  assert.ok(config.secrets.required.includes("MCP_CONTEXT_KEY"));
}
assert.deepEqual(app.triggers.crons, ["*/15 * * * *"]);
for (const config of [app, commerce]) {
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.traces.enabled, true);
}
assert.equal(app.workflows.length, 0);
assert.deepEqual(commerce.workflows, [
  {
    binding: "REFUNDS",
    name: "commerce-refunds-demo",
    class_name: "RefundWorkflow"
  }
]);
assert.deepEqual(commerce.triggers.crons, ["* * * * *"]);
console.log(
  "Verified demo binding target, private Commerce ingress, shared demo D1, and absence of local signing keys, and Commerce refund Workflow/repair schedule. No deployed resources were checked."
);
