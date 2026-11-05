-- migrate:up

-- Outgoing cancellation uses the existing native locator. Its enrollment cannot
-- be reused until the actual successor has committed the exact release.
ALTER TABLE semantic.identity_epoch_mapping
 ADD COLUMN closure_cancelled_successor boolean NOT NULL DEFAULT false;
CREATE INDEX identity_terminal_closure_cancelled ON semantic.identity_epoch_mapping(route,original)
 WHERE closure_cancelled_successor;
ALTER TABLE semantic.identity_epoch_bootstrap_home
 ADD COLUMN closure_ticket_after_route integer NOT NULL DEFAULT -1,
 ADD COLUMN closure_ticket_after_original uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 ADD COLUMN closure_cancel_after_route integer NOT NULL DEFAULT -1,
 ADD COLUMN closure_cancel_after_original uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

-- migrate:down
-- A retained outgoing cancellation cannot be abandoned by dropping its fence.
