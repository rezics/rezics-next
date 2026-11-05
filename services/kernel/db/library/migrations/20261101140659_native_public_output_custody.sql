-- migrate:up
-- The combined producer commits the canonical accepted row with its native binding.
-- These functions resolve only exact same-home keys, after all Library/Semantic migrations exist.
CREATE FUNCTION library.check_public_output_semantic_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_accepted a
  JOIN library.native_public_output_binding b USING(partition_no,capture_id)
  WHERE a.partition_no=NEW.partition_no AND a.capture_id=NEW.capture_id
   AND a.hold_id=b.hold_id AND a.binding_digest=b.binding_digest AND a.definition_digest=b.definition_digest
   AND a.binding=b.payload AND a.transaction_id=b.accepted_transaction_id
   AND a.native_epoch=b.owner_epoch AND a.native_position=b.accepted_position
   AND a.xmin=b.xmin AND b.native_xid=pg_current_xact_id())
 THEN RAISE EXCEPTION 'native_public_output_requires_same_command_semantic_acceptance'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_public_output_semantic_binding AFTER INSERT ON library.native_public_output_binding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_semantic_binding();
CREATE FUNCTION library.check_public_output_semantic_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_stage s
  JOIN semantic.identity_public_output_disposition d USING(partition_no,capture_id,hold_id,binding_digest,kind,native_epoch,native_position,transaction_id)
  JOIN semantic.identity_public_output_transition t USING(partition_no,capture_id,kind,native_epoch,native_position,transaction_id)
  WHERE s.partition_no=NEW.partition_no AND s.capture_id=NEW.capture_id AND s.hold_id=NEW.hold_id
   AND s.binding_digest=NEW.binding_digest AND s.kind=NEW.kind AND s.purpose=NEW.purpose
   AND (s.native_epoch,s.native_position,s.transaction_id)=(NEW.epoch,NEW.position,NEW.transaction_id)
   AND s.native_xid=NEW.native_xid AND s.native_xid=pg_current_xact_id() AND s.xmin=d.xmin AND s.xmin=t.xmin
   AND s.successor_hold_id IS NOT DISTINCT FROM NEW.successor_hold_id
   AND s.cancellation_epoch IS NOT DISTINCT FROM NEW.cancellation_epoch
   AND t.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id)
 THEN RAISE EXCEPTION 'native_public_output_requires_same_command_semantic_disposition'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_public_output_semantic_disposition AFTER INSERT ON library.native_public_output_transition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_semantic_disposition();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Native public output canonical custody is forward only'; END $$;
