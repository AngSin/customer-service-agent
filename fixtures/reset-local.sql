-- Run only through npm run db:reset. Keep migrations, catalog, and probe marker.
DROP TRIGGER audit_no_delete;
DELETE FROM audit_events;
DELETE FROM workflow_dispatches;
DELETE FROM mock_processor_operations;
DELETE FROM refund_attempts;
DELETE FROM refunds;
DELETE FROM support_tickets;
DELETE FROM approvals;
DELETE FROM mutation_actions;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM customers;
DELETE FROM demo_sessions;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit history is append-only'); END;
