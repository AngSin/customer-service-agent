-- Canonical commerce data. Every live entity belongs to a session namespace.
CREATE TABLE data_assertions (ok INTEGER PRIMARY KEY CHECK (ok = 1));

CREATE TABLE fixture_versions (
  version TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1))
);
CREATE UNIQUE INDEX one_active_fixture ON fixture_versions(active) WHERE active = 1;
CREATE TABLE fixture_records (
  fixture_version TEXT NOT NULL REFERENCES fixture_versions(version),
  entity_type TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (fixture_version, entity_type, fixture_id)
);
CREATE TRIGGER fixture_version_immutable BEFORE UPDATE OF version, checksum, installed_at ON fixture_versions
BEGIN SELECT RAISE(ABORT, 'Installed fixture version is immutable'); END;
CREATE TRIGGER fixture_version_no_delete BEFORE DELETE ON fixture_versions
BEGIN SELECT RAISE(ABORT, 'Installed fixture version is immutable'); END;
CREATE TRIGGER fixture_version_no_unseal BEFORE UPDATE OF sealed ON fixture_versions
WHEN OLD.sealed = 1 AND NEW.sealed <> 1
BEGIN SELECT RAISE(ABORT, 'Installed fixture catalog cannot be unsealed'); END;
CREATE TRIGGER fixture_record_no_update BEFORE UPDATE ON fixture_records
BEGIN SELECT RAISE(ABORT, 'Installed fixture record is immutable'); END;
CREATE TRIGGER fixture_record_no_delete BEFORE DELETE ON fixture_records
BEGIN SELECT RAISE(ABORT, 'Installed fixture record is immutable'); END;
CREATE TRIGGER fixture_record_sealed BEFORE INSERT ON fixture_records
WHEN (SELECT sealed FROM fixture_versions WHERE version = NEW.fixture_version) = 1
BEGIN SELECT RAISE(ABORT, 'Active fixture catalog is sealed'); END;

CREATE TABLE demo_sessions (
  ns TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  customer_id TEXT NOT NULL,
  chat_name TEXT NOT NULL UNIQUE,
  fixture_version TEXT NOT NULL REFERENCES fixture_versions(version),
  provisioning_state TEXT NOT NULL DEFAULT 'provisioning' CHECK (provisioning_state IN ('provisioning','ready')),
  approval_epoch INTEGER NOT NULL DEFAULT 1 CHECK (approval_epoch >= 1),
  mutation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mutation_enabled IN (0,1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  replaced_by TEXT UNIQUE REFERENCES demo_sessions(ns),
  FOREIGN KEY (ns, customer_id) REFERENCES customers(ns, customer_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER session_identity_immutable BEFORE UPDATE OF ns, token_hash, customer_id, chat_name, fixture_version ON demo_sessions
BEGIN SELECT RAISE(ABORT, 'Session identity is immutable'); END;
CREATE TRIGGER session_no_reprovision BEFORE UPDATE OF provisioning_state ON demo_sessions
WHEN OLD.provisioning_state = 'ready' AND NEW.provisioning_state <> 'ready'
BEGIN SELECT RAISE(ABORT, 'Session cannot be reprovisioned'); END;

CREATE TABLE customers (
  ns TEXT NOT NULL REFERENCES demo_sessions(ns),
  customer_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL CHECK (email LIKE '%.test'),
  address_json TEXT NOT NULL CHECK (json_valid(address_json)),
  display_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  PRIMARY KEY (ns, customer_id)
);
CREATE TABLE orders (
  ns TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('unshipped','cancelled','shipped','delivered')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid','paid','refunded')),
  total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  address_json TEXT NOT NULL CHECK (json_valid(address_json)),
  tracking_carrier TEXT,
  tracking_number TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, order_id),
  UNIQUE (ns, order_id, customer_id),
  FOREIGN KEY (ns, customer_id) REFERENCES customers(ns, customer_id)
);
CREATE INDEX orders_owner ON orders(ns, customer_id, order_id);
CREATE TABLE order_items (
  ns TEXT NOT NULL,
  order_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  unit_minor INTEGER NOT NULL CHECK (typeof(unit_minor) = 'integer' AND unit_minor >= 0),
  line_minor INTEGER NOT NULL CHECK (typeof(line_minor) = 'integer' AND line_minor = quantity * unit_minor),
  PRIMARY KEY (ns, order_id, item_id),
  FOREIGN KEY (ns, order_id) REFERENCES orders(ns, order_id)
);
CREATE TABLE support_tickets (
  ns TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  order_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('delivery','refund','cancellation','address','other')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status = 'open'),
  action_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ns, ticket_id),
  UNIQUE (ns, action_id),
  FOREIGN KEY (ns, customer_id) REFERENCES customers(ns, customer_id),
  FOREIGN KEY (ns, order_id, customer_id) REFERENCES orders(ns, order_id, customer_id)
);
CREATE INDEX tickets_owner ON support_tickets(ns, customer_id, order_id);
