-- migrate:up

-- Constant-size native locator. The directory remains identity_epoch_original;
-- no transitive path or inverse is materialized.
ALTER TABLE semantic.identity_epoch_group
 ADD COLUMN closure_incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN closure_state text NOT NULL DEFAULT 'open' CHECK (closure_state IN ('open','closing','drained')),
 ADD COLUMN closure_claim uuid,
 ADD COLUMN closure_after uuid,
 ADD COLUMN closure_close_transaction uuid,
 ADD COLUMN closure_seal_transaction uuid,
 ADD COLUMN closure_cleanup_complete boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.identity_epoch_original
 ADD COLUMN closure_state text NOT NULL DEFAULT 'legacy' CHECK (closure_state IN ('legacy','preparing','installed','withdrawn')),
 ADD COLUMN closure_enrollment uuid,
 ADD COLUMN closure_incarnation uuid,
 ADD COLUMN closure_source_revision bigint,
 ADD COLUMN closure_source_epoch integer,
 ADD COLUMN closure_export_transaction uuid,
 ADD COLUMN closure_registration_transaction uuid,
 ADD COLUMN closure_registration_xid text,
 ADD COLUMN closure_install_transaction uuid,
 ADD COLUMN closure_disposition_transaction uuid,
 ADD COLUMN closure_release_transaction uuid,
 ADD COLUMN closure_disposition_epoch integer,
 ADD COLUMN closure_disposition_position bigint,
 ADD COLUMN closure_claim uuid,
 ADD COLUMN closure_reservation uuid;
CREATE INDEX identity_terminal_closure_directory ON semantic.identity_epoch_original
 (partition_no,terminal,generation,original) INCLUDE (closure_state,closure_enrollment);
CREATE INDEX identity_terminal_closure_unreleased ON semantic.identity_epoch_original
 (partition_no,terminal,generation,original) WHERE closure_state='withdrawn' AND closure_release_transaction IS NULL;
CREATE INDEX identity_terminal_closure_cleanup ON semantic.identity_epoch_group(partition_no,terminal)
 WHERE closure_state IN ('closing','drained') AND NOT closure_cleanup_complete;
ALTER TABLE semantic.identity_epoch_mapping
 ADD COLUMN closure_state text NOT NULL DEFAULT 'legacy' CHECK (closure_state IN ('legacy','exporting','installed','active','withdrawn')),
 ADD COLUMN closure_enrollment uuid,
 ADD COLUMN closure_generation uuid,
 ADD COLUMN closure_incarnation uuid,
 ADD COLUMN closure_immediate uuid,
 ADD COLUMN closure_export_transaction uuid,
 ADD COLUMN closure_hold_transaction uuid,
 ADD COLUMN closure_hold_xid text,
 ADD COLUMN closure_registration_transaction uuid,
 ADD COLUMN closure_install_transaction uuid,
 ADD COLUMN closure_install_xid text,
 ADD COLUMN closure_ack_transaction uuid,
 ADD COLUMN closure_ack_xid text,
 ADD COLUMN closure_source_reservation uuid,
 ADD COLUMN closure_claim uuid,
 ADD COLUMN closure_withdraw_transaction uuid,
 ADD COLUMN closure_withdraw_xid text,
 ADD COLUMN closure_successor_ticket uuid,
 ADD COLUMN closure_successor_original uuid,
 ADD COLUMN closure_ticket_reservation uuid,
 ADD COLUMN closure_mutation_xid text;
CREATE INDEX identity_terminal_closure_pending ON semantic.identity_epoch_mapping(route,original) WHERE closure_state IN ('exporting','installed');
CREATE INDEX identity_terminal_closure_owner ON semantic.identity_epoch_mapping (route,closure_state)
 WHERE closure_state <> 'legacy';
CREATE INDEX identity_terminal_closure_successor ON semantic.identity_epoch_mapping(route,original)
 WHERE closure_successor_ticket IS NOT NULL;
ALTER TABLE semantic.identity_epoch_mapping_generation
 ADD COLUMN closure_copies integer NOT NULL DEFAULT 0 CHECK (closure_copies BETWEEN 0 AND 4096),
 ADD COLUMN closure_source_pool boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.identity_epoch_bootstrap_page ADD COLUMN closure_page_reservation uuid;
ALTER TABLE semantic.identity_epoch_bootstrap_home
 ADD COLUMN closure_after_route integer NOT NULL DEFAULT -1,
 ADD COLUMN closure_after_original uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE semantic.identity_epoch_bootstrap_row
 ADD COLUMN closure_enrollment uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN closure_complete boolean NOT NULL DEFAULT false;

-- The original source hold and all directory states survive a lost SDK result.
-- A writer must have consumed the exact drained claim in THIS native transaction.
CREATE FUNCTION semantic.guard_identity_terminal_closure_key(r integer, id uuid) RETURNS void
 LANGUAGE plpgsql AS $$
DECLARE m semantic.identity_epoch_mapping;
BEGIN
 SELECT * INTO m FROM semantic.identity_epoch_mapping WHERE route=r AND original=id FOR UPDATE;
 IF NOT FOUND OR m.closure_state='legacy' THEN RETURN; END IF;
 IF m.closure_successor_ticket IS NOT NULL OR
    m.closure_state IN ('exporting','installed','active') OR
    (m.closure_state='withdrawn' AND m.closure_mutation_xid IS DISTINCT FROM pg_current_xact_id()::text)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
END; $$;

-- Keep the existing mapping/prearm decisions. The extra interlock executes
-- before dirty-head advancement, so a failed mutation cannot lose a withdrawal.
CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_key(r integer, id uuid) RETURNS void
 LANGUAGE plpgsql AS $$
DECLARE owned boolean;
BEGIN
 PERFORM semantic.guard_identity_terminal_closure_key(r,id);
 PERFORM 1 FROM semantic.identity_epoch_dirty WHERE route=r AND original=id FOR UPDATE;
 owned:=semantic.identity_epoch_mapping_owns(r,id);
 IF (EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold
       WHERE partition_no=r/16 AND route=r AND original=id AND NOT closed)
     OR EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence WHERE route=r AND destination=id)) AND NOT owned
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES(r,id)
 ON CONFLICT(route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
 IF owned THEN
   UPDATE semantic.identity_epoch_dirty SET captured_revision=revision WHERE route=r AND original=id;
   RETURN;
 END IF;
 UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,
   sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=r/16;
 UPDATE semantic.identity_epoch_group SET ready=false,version=version+1
   WHERE partition_no=r/16 AND terminal=id AND pending_job IS NULL;
END; $$;

CREATE OR REPLACE FUNCTION semantic.guard_identity_prearm_owner() RETURNS trigger
 LANGUAGE plpgsql AS $$
BEGIN
 -- The executor advances position on every commit. That path performs no
 -- directory/dependency IO and cannot change the actual owner incarnation.
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
-- Native custody cannot be rolled back by dropping its directory columns.
