CREATE TABLE mutation_actions (
  ns TEXT NOT NULL,
  action_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  approval_epoch INTEGER NOT NULL CHECK (approval_epoch >= 1),
  tool TEXT NOT NULL CHECK (tool IN ('cancel_order','refund_order','update_shipping_address','create_support_ticket')),
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  policy_version TEXT NOT NULL,
  target_id TEXT,
  target_version INTEGER CHECK (target_version >= 1),
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','accepted','completed','conflict','rejected')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, action_id),
  FOREIGN KEY (ns, customer_id) REFERENCES customers(ns, customer_id)
);
CREATE TABLE approvals (
  ns TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  approval_epoch INTEGER NOT NULL CHECK (approval_epoch >= 1),
  proposed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > proposed_at),
  approved_at TEXT,
  rejected_at TEXT,
  consumed_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (ns, approval_id),
  UNIQUE (ns, action_id),
  UNIQUE (ns, approval_id, action_id),
  FOREIGN KEY (ns, action_id) REFERENCES mutation_actions(ns, action_id),
  CHECK (approved_at IS NULL OR rejected_at IS NULL),
  CHECK (consumed_at IS NULL OR (approved_at IS NOT NULL AND rejected_at IS NULL AND revoked_at IS NULL))
);
CREATE INDEX approvals_expiry ON approvals(ns, approval_epoch, expires_at);
CREATE TRIGGER action_initial_state BEFORE INSERT ON mutation_actions
WHEN NEW.state <> 'proposed'
BEGIN SELECT RAISE(ABORT, 'Action must begin as a proposal'); END;
CREATE TRIGGER action_payload_immutable BEFORE UPDATE OF ns, action_id, customer_id, approval_epoch, tool, arguments_json, digest, policy_version, target_id, target_version, created_at ON mutation_actions
BEGIN SELECT RAISE(ABORT, 'Action payload is immutable'); END;
CREATE TRIGGER action_transition BEFORE UPDATE OF state ON mutation_actions
WHEN NOT (OLD.state = NEW.state OR (OLD.state = 'proposed' AND NEW.state IN ('accepted','conflict','rejected')) OR (OLD.state = 'accepted' AND NEW.state IN ('completed','conflict')))
BEGIN SELECT RAISE(ABORT, 'Illegal action transition'); END;
CREATE TRIGGER approval_payload_immutable BEFORE UPDATE OF ns, approval_id, action_id, digest, approval_epoch, proposed_at, expires_at ON approvals
BEGIN SELECT RAISE(ABORT, 'Approval payload is immutable'); END;
CREATE TRIGGER approval_timestamps_monotonic BEFORE UPDATE OF approved_at, rejected_at, consumed_at, revoked_at ON approvals
WHEN (OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT OLD.approved_at)
  OR (OLD.rejected_at IS NOT NULL AND NEW.rejected_at IS NOT OLD.rejected_at)
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'Approval decisions cannot be cleared or changed'); END;
CREATE TRIGGER approval_matches_action BEFORE INSERT ON approvals
WHEN NOT EXISTS (SELECT 1 FROM mutation_actions a WHERE a.ns = NEW.ns AND a.action_id = NEW.action_id AND a.digest = NEW.digest AND a.approval_epoch = NEW.approval_epoch AND a.state = 'proposed')
BEGIN SELECT RAISE(ABORT, 'Approval does not match proposal'); END;
CREATE TRIGGER approval_consumption BEFORE UPDATE OF consumed_at ON approvals
WHEN NEW.consumed_at IS NOT NULL AND (OLD.consumed_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM demo_sessions s JOIN mutation_actions a ON a.ns = s.ns
  WHERE s.ns = NEW.ns AND a.action_id = NEW.action_id AND s.customer_id = a.customer_id
    AND s.mutation_enabled = 1 AND s.provisioning_state = 'ready'
    AND s.approval_epoch = NEW.approval_epoch AND a.approval_epoch = NEW.approval_epoch
    AND a.digest = NEW.digest AND a.state = 'proposed'
    AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.approved_at IS NOT NULL AND NEW.rejected_at IS NULL AND NEW.revoked_at IS NULL
))
BEGIN SELECT RAISE(ABORT, 'Approval is inactive or already consumed'); END;
CREATE TRIGGER action_acceptance BEFORE UPDATE OF state ON mutation_actions
WHEN NEW.state = 'accepted' AND OLD.state <> 'accepted' AND NOT EXISTS (
  SELECT 1 FROM approvals p JOIN demo_sessions s ON s.ns = p.ns
  WHERE p.ns = NEW.ns AND p.action_id = NEW.action_id AND p.digest = NEW.digest
    AND p.approval_epoch = NEW.approval_epoch AND s.approval_epoch = NEW.approval_epoch
    AND s.customer_id = NEW.customer_id AND s.mutation_enabled = 1
    AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND p.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND p.consumed_at IS NOT NULL AND p.approved_at IS NOT NULL
    AND p.rejected_at IS NULL AND p.revoked_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'Acceptance requires active consumed approval'); END;

CREATE TABLE audit_events (
  ns TEXT NOT NULL REFERENCES demo_sessions(ns),
  event_id TEXT NOT NULL,
  request_id TEXT,
  customer_id TEXT,
  action_id TEXT,
  order_id TEXT,
  refund_id TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  workflow_instance_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','reviewer','model','workflow')),
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  from_version INTEGER,
  to_version INTEGER,
  action_digest TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (ns, event_id),
  UNIQUE (ns, action_id, event_type, attempt_number),
  FOREIGN KEY (ns, action_id) REFERENCES mutation_actions(ns, action_id)
);
CREATE INDEX audit_action_time ON audit_events(ns, action_id, occurred_at);
CREATE INDEX audit_refund_time ON audit_events(ns, refund_id, occurred_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;

-- The action table is introduced here to preserve migration ordering.
CREATE TRIGGER ticket_action_required BEFORE INSERT ON support_tickets
WHEN NEW.action_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mutation_actions a WHERE a.ns = NEW.ns AND a.action_id = NEW.action_id
    AND a.customer_id = NEW.customer_id AND a.tool = 'create_support_ticket' AND a.state = 'accepted'
)
BEGIN SELECT RAISE(ABORT, 'Ticket requires accepted action'); END;
CREATE TRIGGER fixture_ticket_provisioning BEFORE INSERT ON support_tickets
WHEN NEW.action_id IS NULL AND (SELECT provisioning_state FROM demo_sessions WHERE ns = NEW.ns) <> 'provisioning'
BEGIN SELECT RAISE(ABORT, 'Fixture tickets require provisioning'); END;
