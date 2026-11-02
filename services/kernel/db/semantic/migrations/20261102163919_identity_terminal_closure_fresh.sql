-- migrate:up
-- Pricing has no runtime producer. Retire its physical rows, not the native
-- source, directory, export or generation records that share their reservations.
-- Count only actual deleted rows: an unused provisional copy is not evidence
-- that another native operation has disposed of its retained physical state.
WITH retired AS (
 SELECT partition_no,reservation,count(*) AS copies
 FROM (
   SELECT partition_no,reservation FROM semantic.identity_terminal_closure_original
   UNION ALL
   SELECT partition_no,reservation FROM semantic.identity_terminal_closure_ticket
 ) physical
 GROUP BY partition_no,reservation
)
UPDATE semantic.identity_epoch_mapping_generation g
 SET closure_copies=g.closure_copies-retired.copies
 FROM retired
 WHERE g.partition_no=retired.partition_no AND g.generation=retired.reservation
   AND g.job_id=g.generation;

DROP TABLE semantic.identity_terminal_closure_ticket;
DROP TABLE semantic.identity_terminal_closure_original;
DROP FUNCTION semantic.guard_identity_terminal_ticket();
DROP FUNCTION semantic.guard_identity_terminal_original();

-- The page's native ACK and reservation remain the recovery authority. These
-- columns belonged only to the removed execution-grant cleanup protocol.
ALTER TABLE semantic.identity_epoch_bootstrap_page
 DROP CONSTRAINT identity_terminal_cleanup_receipt,
 DROP COLUMN closure_cleanup_original,
 DROP COLUMN closure_cleanup_transaction,
 DROP COLUMN closure_cleanup_epoch,
 DROP COLUMN closure_cleanup_position,
 DROP COLUMN closure_cleanup_deadline,
 DROP COLUMN closure_cleanup_complete;

CREATE OR REPLACE FUNCTION semantic.guard_identity_prearm_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.node,NEW.epoch,NEW.write_state,NEW.moved_to)
   IS NOT DISTINCT FROM (OLD.node,OLD.epoch,OLD.write_state,OLD.moved_to) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_control WHERE partition_no=OLD.partition_no AND prepare_job IS NOT NULL)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold WHERE partition_no=OLD.partition_no AND NOT closed)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=OLD.partition_no)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping WHERE route BETWEEN OLD.partition_no*16 AND OLD.partition_no*16+15
   AND (closure_state<>'legacy' OR closure_successor_ticket IS NOT NULL))
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=OLD.partition_no AND closure_claim IS NOT NULL)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Terminal pricing retirement requires a forward migration'; END; $$;
