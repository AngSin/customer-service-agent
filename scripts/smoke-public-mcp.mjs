import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";

const endpoint = new URL(
  process.env.PUBLIC_MCP_URL ??
    "https://customer-service-agent-demo.customer-service-lisbon.workers.dev/mcp"
);
const token = (
  await readFile(
    process.env.PUBLIC_MCP_TOKEN_FILE ?? ".wrangler/public-mcp-token.txt",
    "utf8"
  )
).trim();
assert.match(token, /^[a-f0-9]{64}$/, "Expected a 256-bit hex bearer token");
assert.equal((await fetch(endpoint)).status, 401);
const client = new Client(
  { name: "public-smoke", version: "1.0.0" },
  { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((t) => t.name).sort(), [
    "get_customer_profile",
    "get_order",
    "get_refund_status",
    "list_customer_orders"
  ]);
  const profile = await client.callTool({
    name: "get_customer_profile",
    arguments: {}
  });
  assert.equal(profile.structuredContent.data.customer.customer_id, "cus_ada");
  const orders = await client.callTool({
    name: "list_customer_orders",
    arguments: {}
  });
  assert.deepEqual(
    orders.structuredContent.data.orders.map((o) => o.order_id).sort(),
    ["ord_101", "ord_102"]
  );
  const forbidden = await client.callTool({
    name: "get_order",
    arguments: { order_id: "ord_201" }
  });
  assert.equal(forbidden.structuredContent.error.code, "NOT_FOUND");
  console.log(
    "Verified public bearer authentication, four read tools, Ada orders and cross-customer denial over private MCP."
  );
} finally {
  await client.close();
}
