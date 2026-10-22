CREATE TABLE refunds (
  ns TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  current_attempt_number INTEGER NOT NULL CHECK (current_attempt_number >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, refund_id),
  UNIQUE (ns, order_id),
  FOREIGN KEY (ns, order_id, customer_id) REFERENCES orders(ns, order_id, customer_id),
  FOREIGN KEY (ns, refund_id, current_attempt_number) REFERENCES refund_attempts(ns, refund_id, attempt_number) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX refunds_owner ON refunds(ns, customer_id, order_id);
CREATE TABLE refund_attempts (
  ns TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (typeof(attempt_number) = 'integer' AND attempt_number >= 1),
  attempt_id TEXT NOT NULL UNIQUE,
  attempt_key TEXT NOT NULL UNIQUE,
  workflow_instance_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('fixture','reviewer')),
  action_id TEXT,
  approval_id TEXT,
  execution_state TEXT NOT NULL CHECK (execution_state IN ('accepted','running','reconciling','completed','failed')),
  processor_outcome TEXT NOT NULL CHECK (processor_outcome IN ('unknown','confirmed_succeeded','confirmed_no_refund')),
  failure_code TEXT,
  evidence_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, refund_id, attempt_number),
  UNIQUE (ns, refund_id, attempt_number, attempt_key),
  UNIQUE (ns, refund_id, attempt_number, workflow_instance_id),
  FOREIGN KEY (ns, refund_id) REFERENCES refunds(ns, refund_id),
  FOREIGN KEY (ns, approval_id, action_id) REFERENCES approvals(ns, approval_id, action_id),
  CHECK ((origin = 'fixture' AND action_id IS NULL AND approval_id IS NULL) OR (origin = 'reviewer' AND action_id IS NOT NULL AND approval_id IS NOT NULL)),
  CHECK ((execution_state IN ('accepted','running','reconciling') AND processor_outcome = 'unknown') OR (execution_state = 'completed' AND processor_outcome = 'confirmed_succeeded') OR (execution_state = 'failed' AND processor_outcome = 'confirmed_no_refund'))
);
CREATE UNIQUE INDEX one_unresolved_attempt ON refund_attempts(ns, refund_id) WHERE execution_state IN ('accepted','running','reconciling');
CREATE TABLE workflow_dispatches (
  workflow_instance_id TEXT PRIMARY KEY NOT NULL,
  ns TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  action_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','dispatched')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ns, refund_id, attempt_number),
  FOREIGN KEY (ns, refund_id, attempt_number, workflow_instance_id) REFERENCES refund_attempts(ns, refund_id, attempt_number, workflow_instance_id),
  FOREIGN KEY (ns, action_id) REFERENCES mutation_actions(ns, action_id)
);
CREATE INDEX dispatch_queue ON workflow_dispatches(state, updated_at);
CREATE TABLE mock_processor_operations (
  attempt_key TEXT PRIMARY KEY NOT NULL,
  ns TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  scenario TEXT NOT NULL CHECK (scenario IN ('success','confirmed_failure','unknown_then_success','lost_response')),
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown','confirmed_succeeded','confirmed_no_refund')),
  receipt_id TEXT UNIQUE,
  reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_count >= 0),
  CHECK ((outcome = 'confirmed_succeeded' AND receipt_id IS NOT NULL) OR (outcome <> 'confirmed_succeeded' AND receipt_id IS NULL)),
  FOREIGN KEY (ns, refund_id, attempt_number, attempt_key) REFERENCES refund_attempts(ns, refund_id, attempt_number, attempt_key)
);
CREATE UNIQUE INDEX one_settlement ON mock_processor_operations(ns, refund_id) WHERE outcome = 'confirmed_succeeded';
CREATE TRIGGER refund_payload_immutable BEFORE UPDATE OF ns, refund_id, order_id, customer_id, amount_minor, currency, created_at ON refunds
BEGIN SELECT RAISE(ABORT, 'Refund payload is immutable'); END;
CREATE TRIGGER refund_transition BEFORE UPDATE OF status, current_attempt_number ON refunds
WHEN NOT (
  (NEW.status = OLD.status AND NEW.current_attempt_number = OLD.current_attempt_number)
  OR (OLD.status = 'pending' AND NEW.status IN ('completed','failed') AND NEW.current_attempt_number = OLD.current_attempt_number)
  OR (OLD.status = 'failed' AND NEW.status = 'pending' AND NEW.current_attempt_number = OLD.current_attempt_number + 1)
)
BEGIN SELECT RAISE(ABORT, 'Illegal refund transition'); END;
CREATE TRIGGER refund_finalization BEFORE UPDATE OF status ON refunds
WHEN NEW.status IN ('completed','failed') AND NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM refund_attempts a JOIN mock_processor_operations p ON p.attempt_key = a.attempt_key
  WHERE a.ns = NEW.ns AND a.refund_id = NEW.refund_id AND a.attempt_number = NEW.current_attempt_number
    AND a.execution_state = NEW.status AND p.amount_minor = NEW.amount_minor AND p.currency = NEW.currency
    AND p.outcome = CASE NEW.status WHEN 'completed' THEN 'confirmed_succeeded' ELSE 'confirmed_no_refund' END
)
BEGIN SELECT RAISE(ABORT, 'Finalization requires processor evidence'); END;
CREATE TRIGGER attempt_payload_immutable BEFORE UPDATE OF ns, refund_id, attempt_number, attempt_id, attempt_key, workflow_instance_id, origin, action_id, approval_id, created_at ON refund_attempts
BEGIN SELECT RAISE(ABORT, 'Attempt identity is immutable'); END;
CREATE TRIGGER attempt_transition BEFORE UPDATE OF execution_state ON refund_attempts
WHEN NOT (OLD.execution_state = NEW.execution_state OR (OLD.execution_state = 'accepted' AND NEW.execution_state IN ('running','reconciling','completed','failed')) OR (OLD.execution_state = 'running' AND NEW.execution_state IN ('reconciling','completed','failed')) OR (OLD.execution_state = 'reconciling' AND NEW.execution_state IN ('completed','failed')))
BEGIN SELECT RAISE(ABORT, 'Illegal attempt transition'); END;
CREATE TRIGGER fixture_attempt_provisioning BEFORE INSERT ON refund_attempts
WHEN NEW.origin = 'fixture' AND (SELECT provisioning_state FROM demo_sessions WHERE ns = NEW.ns) <> 'provisioning'
BEGIN SELECT RAISE(ABORT, 'Fixture attempts require provisioning'); END;
CREATE TRIGGER reviewer_attempt_approved BEFORE INSERT ON refund_attempts
WHEN NEW.origin = 'reviewer' AND NOT EXISTS (
  SELECT 1 FROM mutation_actions a JOIN approvals p ON p.ns = a.ns AND p.action_id = a.action_id
  JOIN refunds r ON r.ns = a.ns AND r.customer_id = a.customer_id
  WHERE a.ns = NEW.ns AND a.action_id = NEW.action_id AND p.approval_id = NEW.approval_id
    AND r.refund_id = NEW.refund_id AND a.target_id = r.order_id
    AND a.tool = 'refund_order' AND a.state = 'accepted' AND p.consumed_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'Reviewer attempt requires accepted refund approval'); END;
CREATE TRIGGER processor_payload_immutable BEFORE UPDATE OF attempt_key, ns, refund_id, attempt_number, amount_minor, currency, scenario ON mock_processor_operations
BEGIN SELECT RAISE(ABORT, 'Processor payload is immutable'); END;
CREATE TRIGGER processor_outcome_terminal BEFORE UPDATE OF outcome, receipt_id ON mock_processor_operations
WHEN OLD.outcome <> 'unknown' AND (NEW.outcome <> OLD.outcome OR NEW.receipt_id IS NOT OLD.receipt_id)
BEGIN SELECT RAISE(ABORT, 'Confirmed processor outcome is terminal'); END;
