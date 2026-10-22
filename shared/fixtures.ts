// Trusted infrastructure helpers only. These are not MCP tools or session endpoints.
type Value = string | number | null;
type Row = Record<string, Value>;
type Entity = { table: string; id: string; row: Row };
export type Statement = { sql: string; values: Value[] };
export const fixtureVersion = "v2";
const fixtureDate = "2026-10-01T12:00:00.000Z";
const tables = [
  "customers",
  "orders",
  "order_items",
  "support_tickets",
  "refunds",
  "refund_attempts",
  "mock_processor_operations",
  "workflow_dispatches"
] as const;

export function fixtureEntities(): Entity[] {
  const entities: Entity[] = [];
  const add = (table: string, id: string, row: Row) =>
    entities.push({ table, id, row });
  const personas = [
    ["ada", "Ada"],
    ["bram", "Brad"],
    ["cora", "Cora"],
    ["dax", "Dax"],
    ["elin", "Elin"],
    ["fenn", "Fenn"]
  ];
  const orders: [number, string, string, number][] = [
    [101, "unshipped", "paid", 4200],
    [102, "shipped", "paid", 7300],
    [201, "unshipped", "unpaid", 1900],
    [202, "delivered", "paid", 5800],
    [301, "delivered", "refunded", 9100],
    [302, "shipped", "paid", 3600],
    [401, "cancelled", "paid", 6500],
    [402, "unshipped", "paid", 2700],
    [501, "delivered", "paid", 8100],
    [502, "unshipped", "paid", 3300],
    [601, "shipped", "paid", 4900],
    [602, "cancelled", "unpaid", 2200]
  ];
  for (const [index, [slug, name]] of personas.entries()) {
    const customerId = `cus_${slug}`;
    const address = JSON.stringify({
      recipient: name,
      line1: `${101 + index} Example Lane`,
      city: "Testville",
      postal_code: `0000-${101 + index}`,
      country: "PT"
    });
    add("customers", customerId, {
      customer_id: customerId,
      display_name: name!,
      email: `${slug}@example.test`,
      address_json: address,
      display_note: "Fictional demo customer",
      version: 1
    });
    for (const [number, fulfillment, payment, amount] of orders.slice(
      index * 2,
      index * 2 + 2
    )) {
      const orderId = `ord_${number}`;
      add("orders", orderId, {
        order_id: orderId,
        customer_id: customerId,
        fulfillment_status: fulfillment,
        payment_status: payment,
        total_minor: amount,
        currency: "EUR",
        address_json: address,
        tracking_carrier: ["shipped", "delivered"].includes(fulfillment)
          ? "TEST-CARRIER"
          : null,
        tracking_number: ["shipped", "delivered"].includes(fulfillment)
          ? `TEST-TRACK-${number}`
          : null,
        version: 1,
        created_at: fixtureDate,
        updated_at: fixtureDate
      });
      add("order_items", `item_${number}`, {
        order_id: orderId,
        item_id: `item_${number}`,
        sku: `SKU-TEST-${number}`,
        name: number % 2 ? "Fixture Mug" : "Demo Tote",
        quantity: 1,
        unit_minor: amount,
        line_minor: amount
      });
      if ([102, 302, 601].includes(number)) {
        add("support_tickets", `tkt_${number}`, {
          ticket_id: `tkt_${number}`,
          customer_id: customerId,
          order_id: orderId,
          category: number === 302 ? "refund" : "delivery",
          subject: `Synthetic enquiry for ${orderId}`,
          body: "Fictional support history. No message was sent.",
          status: "open",
          action_id: null,
          created_at: fixtureDate
        });
      }
      if (![202, 301, 302].includes(number)) continue;
      const status =
        number === 202 ? "pending" : number === 301 ? "completed" : "failed";
      const outcome =
        number === 202
          ? "unknown"
          : number === 301
            ? "confirmed_succeeded"
            : "confirmed_no_refund";
      const refundId = `ref_${number}`;
      const key = `attempt_${number}_1`;
      add("refunds", refundId, {
        refund_id: refundId,
        order_id: orderId,
        customer_id: customerId,
        amount_minor: amount,
        currency: "EUR",
        status,
        current_attempt_number: 1,
        version: 1,
        created_at: fixtureDate,
        updated_at: fixtureDate
      });
      add("refund_attempts", key, {
        refund_id: refundId,
        attempt_number: 1,
        attempt_id: key,
        attempt_key: key,
        workflow_instance_id: `workflow_${number}_1`,
        origin: "fixture",
        action_id: null,
        approval_id: null,
        execution_state: status === "pending" ? "reconciling" : status,
        processor_outcome: outcome,
        failure_code: status === "failed" ? "MOCK_CONFIRMED_FAILURE" : null,
        evidence_reference: status === "pending" ? null : `evidence_${number}`,
        created_at: fixtureDate,
        updated_at: fixtureDate
      });
      add("mock_processor_operations", key, {
        attempt_key: key,
        refund_id: refundId,
        attempt_number: 1,
        amount_minor: amount,
        currency: "EUR",
        scenario:
          number === 202
            ? "unknown_then_success"
            : number === 301
              ? "success"
              : "confirmed_failure",
        outcome,
        receipt_id: status === "completed" ? `receipt_${number}` : null,
        reconciliation_count: 0
      });
      if (status === "pending") {
        add("workflow_dispatches", `workflow_${number}_1`, {
          workflow_instance_id: `workflow_${number}_1`,
          refund_id: refundId,
          attempt_number: 1,
          action_id: null,
          state: "queued",
          retry_count: 0,
          last_error_code: null,
          created_at: fixtureDate,
          updated_at: fixtureDate
        });
      }
    }
  }
  return entities.sort(
    (a, b) =>
      tables.indexOf(a.table as (typeof tables)[number]) -
        tables.indexOf(b.table as (typeof tables)[number]) ||
      a.id.localeCompare(b.id, "en")
  );
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// A SELECT returning zero rows does not abort a D1 batch. A failed CHECK does.
export function assertion(condition: string, values: Value[] = []): Statement {
  return {
    sql: `INSERT INTO data_assertions(ok) VALUES (CASE WHEN (${condition}) THEN 1 ELSE 0 END) ON CONFLICT(ok) DO NOTHING`,
    values
  };
}

export async function catalogStatements(): Promise<Statement[]> {
  const entities = fixtureEntities();
  const checksum = await sha256(JSON.stringify(entities));
  const statements: Statement[] = [
    {
      sql: "INSERT INTO fixture_versions(version, checksum) VALUES (?, ?) ON CONFLICT(version) DO NOTHING",
      values: [fixtureVersion, checksum]
    },
    assertion(
      "EXISTS (SELECT 1 FROM fixture_versions WHERE version = ? AND checksum = ?)",
      [fixtureVersion, checksum]
    )
  ];
  for (const { table, id, row } of entities) {
    const payload = JSON.stringify(row);
    statements.push(
      {
        sql: "INSERT INTO fixture_records(fixture_version, entity_type, fixture_id, payload_json) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM fixture_records WHERE fixture_version = ? AND entity_type = ? AND fixture_id = ?)",
        values: [fixtureVersion, table, id, payload, fixtureVersion, table, id]
      },
      assertion(
        "EXISTS (SELECT 1 FROM fixture_records WHERE fixture_version = ? AND entity_type = ? AND fixture_id = ? AND payload_json = ?)",
        [fixtureVersion, table, id, payload]
      )
    );
  }
  statements.push(
    assertion(
      "(SELECT count(*) FROM fixture_records WHERE fixture_version = ?) = ?",
      [fixtureVersion, entities.length]
    ),
    {
      sql: "UPDATE fixture_versions SET active = 0 WHERE version <> ? AND active = 1",
      values: [fixtureVersion]
    },
    {
      sql: "UPDATE fixture_versions SET active = 1, sealed = 1 WHERE version = ? AND active = 0",
      values: [fixtureVersion]
    }
  );
  return statements;
}

export async function executeBatch(db: D1Database, statements: Statement[]) {
  return db.batch(
    statements.map(({ sql, values }) => db.prepare(sql).bind(...values))
  );
}

export async function installFixtures(db: D1Database) {
  await executeBatch(db, await catalogStatements());
}

export type NamespaceInput = {
  ns: string;
  customerId: string;
  tokenHash: string;
  chatName: string;
  createdAt: string;
  expiresAt: string;
};

export async function namespaceStatements(
  input: NamespaceInput
): Promise<Statement[]> {
  if (
    !/^[a-z0-9_-]{1,64}$/.test(input.ns) ||
    !/^[a-f0-9]{64}$/.test(input.tokenHash)
  ) {
    throw new Error("Invalid server namespace or token hash");
  }
  if (
    !fixtureEntities().some(
      (entity) => entity.table === "customers" && entity.id === input.customerId
    )
  ) {
    throw new Error("Unknown fixture persona");
  }
  // Validate all installed payloads/checksum in the same transaction as copying them.
  const statements = [
    assertion(
      "EXISTS (SELECT 1 FROM fixture_versions WHERE version = ? AND active = 1)",
      [fixtureVersion]
    ),
    ...(await catalogStatements())
  ];
  statements.push({
    sql: "INSERT INTO demo_sessions(ns, token_hash, customer_id, chat_name, fixture_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    values: [
      input.ns,
      input.tokenHash,
      input.customerId,
      input.chatName,
      fixtureVersion,
      input.createdAt,
      input.expiresAt
    ]
  });
  for (const { table, id, row } of fixtureEntities()) {
    const columns = Object.keys(row);
    const expressions = columns.map((column) => {
      const json = `json_extract(payload_json, '$.${column}')`;
      return [
        "attempt_id",
        "attempt_key",
        "workflow_instance_id",
        "receipt_id",
        "evidence_reference"
      ].includes(column)
        ? `CASE WHEN ${json} IS NULL THEN NULL ELSE ? || '_' || ${json} END`
        : json;
    });
    const scopedColumns = columns.filter((column) =>
      [
        "attempt_id",
        "attempt_key",
        "workflow_instance_id",
        "receipt_id",
        "evidence_reference"
      ].includes(column)
    );
    statements.push({
      sql: `INSERT INTO ${table}(ns, ${columns.join(", ")}) SELECT ?, ${expressions.join(", ")} FROM fixture_records WHERE fixture_version = ? AND entity_type = ? AND fixture_id = ?`,
      values: [
        input.ns,
        ...scopedColumns.map(() => input.ns),
        fixtureVersion,
        table,
        id
      ]
    });
  }
  statements.push(...namespaceAssertions(input.ns), {
    sql: "UPDATE demo_sessions SET provisioning_state = 'ready' WHERE ns = ?",
    values: [input.ns]
  });
  return statements;
}

export async function provisionNamespace(
  db: D1Database,
  input: NamespaceInput
) {
  await executeBatch(db, await namespaceStatements(input));
}

export function namespaceAssertions(ns: string): Statement[] {
  const expected = {
    customers: 6,
    orders: 12,
    order_items: 12,
    support_tickets: 3,
    refunds: 3
  };
  return [
    ...Object.entries(expected).map(([table, count]) =>
      assertion(`(SELECT count(*) FROM ${table} WHERE ns = ?) = ?`, [ns, count])
    ),
    assertion(
      "NOT EXISTS (SELECT 1 FROM orders o WHERE o.ns = ? AND o.total_minor <> (SELECT coalesce(sum(i.line_minor),0) FROM order_items i WHERE i.ns = o.ns AND i.order_id = o.order_id))",
      [ns]
    ),
    assertion(
      "NOT EXISTS (SELECT 1 FROM refunds r JOIN orders o ON o.ns = r.ns AND o.order_id = r.order_id JOIN refund_attempts a ON a.ns = r.ns AND a.refund_id = r.refund_id AND a.attempt_number = r.current_attempt_number LEFT JOIN mock_processor_operations p ON p.attempt_key = a.attempt_key WHERE r.ns = ? AND (p.attempt_key IS NULL OR o.fulfillment_status NOT IN ('cancelled','shipped','delivered') OR r.amount_minor <> o.total_minor OR p.amount_minor <> r.amount_minor OR p.currency <> r.currency OR (r.status = 'completed' AND (o.payment_status <> 'refunded' OR a.execution_state <> 'completed' OR p.outcome <> 'confirmed_succeeded')) OR (r.status = 'failed' AND (o.payment_status <> 'paid' OR a.execution_state <> 'failed' OR p.outcome <> 'confirmed_no_refund')) OR (r.status = 'pending' AND (o.payment_status <> 'paid' OR a.execution_state NOT IN ('accepted','running','reconciling') OR p.outcome <> 'unknown'))))",
      [ns]
    ),
    assertion(
      "NOT EXISTS (SELECT 1 FROM orders o WHERE o.ns = ? AND o.payment_status = 'refunded' AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.ns = o.ns AND r.order_id = o.order_id AND r.status = 'completed'))",
      [ns]
    )
  ];
}

export async function verifyNamespace(db: D1Database, ns: string) {
  await executeBatch(db, namespaceAssertions(ns));
  const { results } = await db.prepare("PRAGMA foreign_key_check").all();
  if (results.length) throw new Error("Foreign key validation failed");
}

export async function localReferenceInput(): Promise<NamespaceInput> {
  const created = new Date();
  return {
    ns: "local_reference",
    customerId: "cus_ada",
    tokenHash: await sha256("local-reference-not-a-browser-session"),
    chatName: "local_reference",
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + 86400000).toISOString()
  };
}
