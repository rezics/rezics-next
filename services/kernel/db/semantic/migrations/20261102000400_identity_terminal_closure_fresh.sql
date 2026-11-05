-- migrate:up
-- A native ACK/maintenance commit lends the two already charged ticket roles
-- to a separate, irreversible cleanup original. It never refills its predecessor.
ALTER TABLE semantic.identity_epoch_bootstrap_page
 ADD COLUMN closure_cleanup_original uuid,
 ADD COLUMN closure_cleanup_transaction uuid,
 ADD COLUMN closure_cleanup_epoch integer,
 ADD COLUMN closure_cleanup_position bigint,
 ADD COLUMN closure_cleanup_deadline bigint,
 ADD COLUMN closure_cleanup_complete boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT identity_terminal_cleanup_receipt CHECK (
   (closure_cleanup_original IS NULL AND closure_cleanup_transaction IS NULL
     AND closure_cleanup_epoch IS NULL AND closure_cleanup_position IS NULL
     AND closure_cleanup_deadline IS NULL AND NOT closure_cleanup_complete)
   OR (closure_cleanup_original IS NOT NULL AND closure_cleanup_transaction IS NOT NULL
     AND closure_cleanup_epoch IS NOT NULL AND closure_cleanup_position IS NOT NULL
     AND closure_cleanup_deadline IS NOT NULL
     AND closure_cleanup_epoch>0 AND closure_cleanup_position>0 AND closure_cleanup_deadline>0 AND acknowledged));

ALTER TABLE semantic.identity_terminal_closure_original
 DROP CONSTRAINT identity_terminal_closure_original_operation_check,
 ADD COLUMN predecessor uuid,
 ADD COLUMN cleanup_id uuid,
 ADD CONSTRAINT identity_terminal_original_operation CHECK (
   (operation='bootstrap-owner-read' AND predecessor IS NULL)
   OR (operation='bootstrap-original-maintenance' AND predecessor IS NOT NULL AND cleanup_id IS NULL));
-- Only maintenance rows acquire this index entry. Canonical owner-read rows do
-- not acquire another inverse or foreign-key liability during normal retirement.
CREATE UNIQUE INDEX identity_terminal_original_predecessor
 ON semantic.identity_terminal_closure_original(partition_no,predecessor) WHERE predecessor IS NOT NULL;

ALTER TABLE semantic.identity_terminal_closure_ticket
 DROP CONSTRAINT identity_terminal_closure_ticket_operation_check,
 DROP CONSTRAINT identity_terminal_closure_ticket_phase_check,
 DROP CONSTRAINT identity_terminal_closure_ticket_check,
 ADD CONSTRAINT identity_terminal_ticket_operation CHECK (
   (ordinal=1 AND operation='owner-read' AND phase='observe-owner')
   OR (ordinal=2 AND operation='retire-original' AND phase='retire-original')
   OR (ordinal=1 AND operation='cleanup-predecessor' AND phase='cleanup-predecessor'));

CREATE OR REPLACE FUNCTION semantic.guard_identity_terminal_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.partition_no,NEW.original_id,NEW.source_transaction,NEW.source_epoch,NEW.source_position,
     NEW.source_generation,NEW.source_phase,NEW.operation,NEW.deadline,NEW.plan_digest,NEW.price,NEW.reservation,NEW.predecessor)
 IS DISTINCT FROM
    (OLD.partition_no,OLD.original_id,OLD.source_transaction,OLD.source_epoch,OLD.source_position,
     OLD.source_generation,OLD.source_phase,OLD.operation,OLD.deadline,OLD.plan_digest,OLD.price,OLD.reservation,OLD.predecessor)
 OR NEW.ordinal<OLD.ordinal
 OR NEW.spent[1]<OLD.spent[1] OR NEW.spent[2]<OLD.spent[2]
 OR NEW.spent[3]<OLD.spent[3] OR NEW.spent[4]<OLD.spent[4]
 OR NEW.spent[5]<OLD.spent[5] OR NEW.spent[6]<OLD.spent[6]
 OR NEW.spent[7]<OLD.spent[7] OR NEW.spent[8]<OLD.spent[8]
 OR (NEW.cleanup_id IS DISTINCT FROM OLD.cleanup_id
   AND (NEW.predecessor IS NOT NULL OR NEW.cleanup_id IS NULL OR NEW.ordinal<>2))
 THEN RAISE EXCEPTION 'identity_epoch_unavailable: immutable original or refill'; END IF;
 RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Native maintenance custody requires forward retirement'; END; $$;
