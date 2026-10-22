import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import {
  assertion,
  executeBatch,
  fixtureEntities,
  installFixtures,
  localReferenceInput,
  provisionNamespace,
  verifyNamespace
} from "../shared/fixtures.ts";
import { dataCommand, generatedSeedSql } from "../scripts/data.mjs";

let mf, db;
let sequence = 0;
const query = async (sql, ...values) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all()
  ).results;
const run = (sql, ...values) =>
  db
    .prepare(sql)
    .bind(...values)
    .run();
const sqlStatements = (sql) =>
  unstable_splitSqlQuery(sql).map((sql) => ({ sql, values: [] }));

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        "export default {fetch() {return new Response('No public data API')}}",
      compatibilityDate: "2026-06-11",
      d1Databases: { DB: "data-test" }
    })
  );
  db = await mf.getD1Database("DB");
  await run("CREATE TABLE milestone_probe(marker TEXT)");
  await run("INSERT INTO milestone_probe VALUES ('preserve-me')");
  for (const name of (await readdir("migrations")).sort()) {
    await executeBatch(
      db,
      sqlStatements(await readFile(`migrations/${name}`, "utf8"))
    );
  }
  await installFixtures(db);
});
after(async () => mf?.dispose());

async function namespace(customerId = "cus_ada") {
  const input = await localReferenceInput();
  input.ns = `test_${++sequence}`;
  input.chatName = input.ns;
  input.tokenHash = sequence.toString(16).padStart(64, "0");
  input.customerId = customerId;
  await provisionNamespace(db, input);
  return input.ns;
}

test("forward migrations preserve the existing marker and generate the expected catalog", async () => {
  assert.deepEqual(await query("SELECT * FROM milestone_probe"), [
    { marker: "preserve-me" }
  ]);
  assert.equal((await query("PRAGMA foreign_key_check")).length, 0);
  assert.equal(
    await readFile("fixtures/seed-v1.sql", "utf8"),
    await generatedSeedSql()
  );
  assert.equal(
    (await query("SELECT * FROM fixture_records")).length,
    fixtureEntities().length
  );
  const ns = await namespace();
  await verifyNamespace(db, ns);
  assert.deepEqual(
    await query(
      "SELECT status, count(*) AS n FROM refunds WHERE ns = ? GROUP BY status ORDER BY status",
      ns
    ),
    [
      { status: "completed", n: 1 },
      { status: "failed", n: 1 },
      { status: "pending", n: 1 }
    ]
  );
  assert.equal(
    (
      await query(
        "SELECT * FROM refund_attempts WHERE ns = ? AND origin = 'fixture' AND action_id IS NULL AND approval_id IS NULL",
        ns
      )
    ).length,
    3
  );
  assert.equal(
    (
      await query(
        "SELECT * FROM workflow_dispatches WHERE ns = ? AND state = 'queued'",
        ns
      )
    ).length,
    1
  );
  assert.equal(
    (
      await query(
        "SELECT * FROM demo_sessions WHERE ns = ? AND mutation_enabled = 0 AND provisioning_state = 'ready'",
        ns
      )
    ).length,
    1
  );
});

test("repeated seed preserves the immutable catalog and mutated namespaces", async () => {
  const ns = await namespace();
  const catalog = await query(
    "SELECT * FROM fixture_records ORDER BY entity_type, fixture_id"
  );
  const versions = await query("SELECT * FROM fixture_versions");
  await run(
    "UPDATE orders SET fulfillment_status = 'cancelled', version = 2 WHERE ns = ? AND order_id = 'ord_101'",
    ns
  );
  await installFixtures(db);
  await installFixtures(db);
  assert.deepEqual(
    await query(
      "SELECT * FROM fixture_records ORDER BY entity_type, fixture_id"
    ),
    catalog
  );
  assert.deepEqual(await query("SELECT * FROM fixture_versions"), versions);
  assert.equal(
    (
      await query(
        "SELECT fulfillment_status FROM orders WHERE ns = ? AND order_id = 'ord_101'",
        ns
      )
    )[0].fulfillment_status,
    "cancelled"
  );
  await assert.rejects(
    run("UPDATE fixture_records SET payload_json = '{}'"),
    /immutable/
  );
  await assert.rejects(run("DELETE FROM fixture_records"), /immutable/);
  await assert.rejects(
    run("UPDATE fixture_versions SET checksum = ?", "0".repeat(64)),
    /immutable/
  );
});

test("SQL catalog bootstrap can be repeated and refuses mismatched installed versions", async () => {
  await executeBatch(db, sqlStatements(await generatedSeedSql()));
  await executeBatch(db, sqlStatements(await generatedSeedSql()));
  const statements = sqlStatements(await generatedSeedSql());
  // Simulate shipping changed v1 contents without changing its version.
  statements[0].values = [];
  statements[0].sql = statements[0].sql.replace(
    /'[a-f0-9]{64}'/,
    `'${"f".repeat(64)}'`
  );
  statements[1].sql = statements[1].sql.replace(
    /'[a-f0-9]{64}'/,
    `'${"f".repeat(64)}'`
  );
  await assert.rejects(executeBatch(db, statements), /CHECK/);
});

test("namespaces copy all six personas independently with distinct processor and Workflow keys", async () => {
  const a = await namespace(),
    b = await namespace("cus_bram");
  const original = (
    await query(
      "SELECT address_json FROM orders WHERE ns = ? AND order_id = 'ord_101'",
      b
    )
  )[0].address_json;
  await run(
    "UPDATE orders SET address_json = ?, version = 2 WHERE ns = ? AND order_id = 'ord_101'",
    JSON.stringify({ line1: "Changed synthetic address" }),
    a
  );
  assert.equal(
    (
      await query(
        "SELECT address_json FROM orders WHERE ns = ? AND order_id = 'ord_101'",
        b
      )
    )[0].address_json,
    original
  );
  assert.equal(
    (
      await query(
        "SELECT address_json FROM customers WHERE ns = ? AND customer_id = 'cus_ada'",
        a
      )
    )[0].address_json,
    original
  );
  const keys = await query(
    "SELECT attempt_key, workflow_instance_id FROM refund_attempts WHERE ns IN (?, ?)",
    a,
    b
  );
  assert.equal(new Set(keys.map((row) => row.attempt_key)).size, 6);
  assert.equal(new Set(keys.map((row) => row.workflow_instance_id)).size, 6);
  await assert.rejects(
    run(
      "UPDATE support_tickets SET customer_id = 'cus_bram' WHERE ns = ? AND ticket_id = 'tkt_102'",
      a
    ),
    /FOREIGN KEY/
  );
  await assert.rejects(
    run(
      "UPDATE orders SET customer_id = 'missing' WHERE ns = ? AND order_id = 'ord_101'",
      a
    ),
    /FOREIGN KEY/
  );
  await assert.rejects(
    run("UPDATE demo_sessions SET customer_id = 'cus_bram' WHERE ns = ?", a),
    /immutable/
  );
});

test("money, item sums, statuses, and one logical refund per order are constrained", async () => {
  const ns = await namespace();
  for (const value of [-1, 1.5, 0, "invalid"]) {
    await assert.rejects(
      run(
        "UPDATE orders SET total_minor = ? WHERE ns = ? AND order_id = 'ord_101'",
        value,
        ns
      ),
      /CHECK/
    );
  }
  await assert.rejects(
    run("UPDATE orders SET currency = 'USD' WHERE ns = ?", ns),
    /CHECK/
  );
  await assert.rejects(
    run("UPDATE orders SET fulfillment_status = 'flying' WHERE ns = ?", ns),
    /CHECK/
  );
  await assert.rejects(
    run("UPDATE order_items SET line_minor = 1 WHERE ns = ?", ns),
    /CHECK/
  );
  await assert.rejects(
    run(
      "INSERT INTO refunds SELECT ns, 'duplicate', order_id, customer_id, amount_minor, currency, status, current_attempt_number, version, created_at, updated_at FROM refunds WHERE ns = ? AND refund_id = 'ref_301'",
      ns
    ),
    /UNIQUE/
  );
  await run(
    "UPDATE orders SET total_minor = total_minor + 1 WHERE ns = ? AND order_id = 'ord_101'",
    ns
  );
  await assert.rejects(verifyNamespace(db, ns), /CHECK/);
});

test("namespace provisioning rolls back completely on late failure and rejects existing namespaces", async () => {
  const input = {
    ...(await localReferenceInput()),
    ns: "rollback",
    chatName: "rollback",
    tokenHash: "e".repeat(64)
  };
  const failingDb = {
    prepare: db.prepare.bind(db),
    batch: (statements) =>
      db.batch([...statements, db.prepare(assertion("0").sql)])
  };
  await assert.rejects(provisionNamespace(failingDb, input), /CHECK/);
  assert.equal(
    (await query("SELECT * FROM demo_sessions WHERE ns = 'rollback'")).length,
    0
  );
  assert.equal(
    (await query("SELECT * FROM orders WHERE ns = 'rollback'")).length,
    0
  );
  await provisionNamespace(db, input);
  await assert.rejects(provisionNamespace(db, input), /UNIQUE/);
  await assert.rejects(
    provisionNamespace(db, { ...input, ns: "bad", customerId: "cus_stranger" }),
    /Unknown/
  );
});

test("terminal refund/attempt/processor outcomes cannot be replayed as pending", async () => {
  const ns = await namespace();
  await assert.rejects(
    run(
      "UPDATE refunds SET status = 'pending' WHERE ns = ? AND refund_id = 'ref_301'",
      ns
    ),
    /transition/
  );
  await assert.rejects(
    run(
      "UPDATE refund_attempts SET execution_state = 'running', processor_outcome = 'unknown' WHERE ns = ? AND refund_id = 'ref_302'",
      ns
    ),
    /transition/
  );
  await assert.rejects(
    run(
      "UPDATE mock_processor_operations SET outcome = 'unknown', receipt_id = NULL WHERE ns = ? AND refund_id = 'ref_301'",
      ns
    ),
    /terminal/
  );
  await assert.rejects(
    run(
      "UPDATE mock_processor_operations SET amount_minor = amount_minor + 1 WHERE ns = ?",
      ns
    ),
    /immutable/
  );
  await assert.rejects(
    run(
      "UPDATE demo_sessions SET provisioning_state = 'provisioning' WHERE ns = ?",
      ns
    ),
    /reprovisioned/
  );
});

test("action payload and audit are immutable; no acceptance without exact active consent", async () => {
  const ns = await namespace();
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 300000).toISOString();
  await run(
    "INSERT INTO mutation_actions(ns, action_id, customer_id, approval_epoch, tool, arguments_json, digest, policy_version, target_id, target_version, created_at, updated_at) VALUES (?, 'action', 'cus_ada', 1, 'cancel_order', '{}', ?, 'v1', 'ord_101', 1, ?, ?)",
    ns,
    "a".repeat(64),
    now,
    now
  );
  await assert.rejects(
    run(
      'UPDATE mutation_actions SET arguments_json = \'{"order_id":"ord_201"}\' WHERE ns = ?',
      ns
    ),
    /immutable/
  );
  await assert.rejects(
    run("UPDATE mutation_actions SET state = 'accepted' WHERE ns = ?", ns),
    /approval/
  );
  await run(
    "INSERT INTO approvals(ns, approval_id, action_id, digest, approval_epoch, proposed_at, expires_at, approved_at) VALUES (?, 'approval', 'action', ?, 1, ?, ?, ?)",
    ns,
    "a".repeat(64),
    now,
    expiry,
    now
  );
  await assert.rejects(
    run("UPDATE approvals SET consumed_at = ? WHERE ns = ?", now, ns),
    /inactive/
  );
  await run("UPDATE demo_sessions SET mutation_enabled = 1 WHERE ns = ?", ns);
  await executeBatch(db, [
    {
      sql: "UPDATE approvals SET consumed_at = ? WHERE ns = ?",
      values: [now, ns]
    },
    {
      sql: "UPDATE mutation_actions SET state = 'accepted' WHERE ns = ?",
      values: [ns]
    },
    {
      sql: "INSERT INTO audit_events(ns, event_id, action_id, actor_type, event_type, outcome, occurred_at) VALUES (?, 'event', 'action', 'reviewer', 'accepted', 'ok', ?)",
      values: [ns, now]
    }
  ]);
  await assert.rejects(
    run("UPDATE approvals SET consumed_at = ? WHERE ns = ?", now, ns),
    /consumed/
  );
  await assert.rejects(
    run("UPDATE audit_events SET outcome = 'edited' WHERE ns = ?", ns),
    /append-only/
  );
  await assert.rejects(
    run("DELETE FROM audit_events WHERE ns = ?", ns),
    /append-only/
  );
});

test("local reset preserves schema/catalog and restores append-only audit protection", async () => {
  // All tests use an isolated ephemeral D1; no developer data is reset here.
  const catalog = await query("SELECT * FROM fixture_versions");
  await executeBatch(
    db,
    sqlStatements(await readFile("fixtures/reset-local.sql", "utf8"))
  );
  assert.equal((await query("SELECT * FROM demo_sessions")).length, 0);
  assert.deepEqual(await query("SELECT * FROM fixture_versions"), catalog);
  assert.deepEqual(await query("SELECT * FROM milestone_probe"), [
    { marker: "preserve-me" }
  ]);
  assert.equal(
    (
      await query(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_no_delete'"
      )
    ).length,
    1
  );
  await namespace();
  assert.equal((await query("PRAGMA foreign_key_check")).length, 0);
});

test("verification rejects missing processor evidence instead of skipping the refund", async () => {
  const ns = await namespace();
  await run(
    "DELETE FROM mock_processor_operations WHERE ns = ? AND refund_id = 'ref_301'",
    ns
  );
  await assert.rejects(verifyNamespace(db, ns), /CHECK/);
});

test("security fixture text stays literal data in scoped customer/item/ticket fields", async () => {
  const ns = await namespace();
  const payloads = JSON.parse(
    await readFile("tests/fixtures/injection.json", "utf8")
  );
  await run(
    "UPDATE customers SET display_note = ? WHERE ns = ? AND customer_id = 'cus_ada'",
    payloads.display_note,
    ns
  );
  await run(
    "UPDATE order_items SET name = ? WHERE ns = ? AND item_id = 'item_101'",
    payloads.item_name,
    ns
  );
  await run(
    "UPDATE support_tickets SET body = ? WHERE ns = ? AND ticket_id = 'tkt_102'",
    payloads.ticket_body,
    ns
  );
  assert.equal(
    (await query("SELECT customer_id FROM demo_sessions WHERE ns = ?", ns))[0]
      .customer_id,
    "cus_ada"
  );
  assert.equal(
    (
      await query(
        "SELECT display_note FROM customers WHERE ns = ? AND customer_id = 'cus_ada'",
        ns
      )
    )[0].display_note,
    payloads.display_note
  );
  assert.equal(
    (
      await query(
        "SELECT name FROM order_items WHERE ns = ? AND item_id = 'item_101'",
        ns
      )
    )[0].name,
    payloads.item_name
  );
  assert.equal(
    (
      await query(
        "SELECT body FROM support_tickets WHERE ns = ? AND ticket_id = 'tkt_102'",
        ns
      )
    )[0].body,
    payloads.ticket_body
  );
  // Model/tool authorization and browser rendering are later milestone checks.
});

test("partial unique indexes reject a second unresolved attempt or second settlement", async () => {
  for (const kind of ["pending", "completed"]) {
    const input = {
      ...(await localReferenceInput()),
      ns: `unique_${kind}`,
      chatName: `unique_${kind}`,
      tokenHash: (kind === "pending" ? "b" : "c").repeat(64)
    };
    const refundId = kind === "pending" ? "ref_202" : "ref_301";
    const attempt = db
      .prepare(
        "INSERT INTO refund_attempts SELECT ns, refund_id, 2, attempt_id || '_second', attempt_key || '_second', workflow_instance_id || '_second', origin, action_id, approval_id, execution_state, processor_outcome, failure_code, evidence_reference, created_at, updated_at FROM refund_attempts WHERE ns = ? AND refund_id = ?"
      )
      .bind(input.ns, refundId);
    const ledger = db
      .prepare(
        "INSERT INTO mock_processor_operations SELECT attempt_key || '_second', ns, refund_id, 2, amount_minor, currency, scenario, outcome, receipt_id || '_second', reconciliation_count FROM mock_processor_operations WHERE ns = ? AND refund_id = ?"
      )
      .bind(input.ns, refundId);
    const duplicateDb = {
      prepare: db.prepare.bind(db),
      batch: (statements) =>
        db.batch([
          ...statements.slice(0, -1),
          attempt,
          ...(kind === "completed" ? [ledger] : []),
          statements.at(-1)
        ])
    };
    await assert.rejects(provisionNamespace(duplicateDb, input), /UNIQUE/);
    assert.equal(
      (await query("SELECT * FROM demo_sessions WHERE ns = ?", input.ns))
        .length,
      0
    );
  }
});

test("local reset rejects remote/demo/extra arguments before touching storage", () => {
  for (const args of [
    ["reset", "--remote"],
    ["reset", "--env", "demo"],
    ["reset", "demo"],
    ["seed", "--config", "other.json"]
  ]) {
    assert.throws(() => dataCommand(args, {}), /no additional flags/);
    const result = spawnSync(process.execPath, ["scripts/data.mjs", ...args], {
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
  }
  assert.throws(
    () => dataCommand(["reset"], { CLOUDFLARE_ENV: "demo" }),
    /refuse/
  );
  assert.equal(dataCommand(["reset"], {}), "reset");
});
