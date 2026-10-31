-- migrate:up
-- Persist the terminal-detachment transform in the immutable native job, not the public intent.
-- The existing protect_identity_epoch_job trigger protects every column except state.
ALTER TABLE semantic.identity_epoch_job ADD COLUMN remainder_terminal uuid;
ALTER TABLE semantic.identity_epoch_job ADD CONSTRAINT identity_epoch_job_remainder_check
 CHECK(remainder_terminal IS NULL OR (intent->>'kind' IN ('repoint','unmerge') AND remainder_terminal::text<>intent->>'original'));
CREATE INDEX identity_epoch_live_original ON semantic.identity_epoch_original(partition_no,generation,original) WHERE present;

-- Presentation visibility of an admitted nonterminal member does not select a different remainder.
-- Input terminals retain their current visible/ordinary eligibility and all native ownership gates.
CREATE OR REPLACE FUNCTION semantic.apply_identity_epoch_mapping_source(r integer,id uuid,previous uuid,destination uuid,release_digest text,tid uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE m semantic.identity_epoch_mapping;s semantic.subject;revision_no integer;sequence_no integer;actual uuid;
BEGIN
 IF r<>get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11)
   OR NOT semantic.identity_epoch_mapping_owns(r,id)
   OR NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence f WHERE f.route=r AND f.destination=id AND f.transaction_id=tid)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 SELECT * INTO STRICT m FROM semantic.identity_epoch_mapping WHERE route=r AND original=id FOR UPDATE;
 SELECT * INTO STRICT s FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 SELECT target,sequence INTO actual,sequence_no FROM semantic.redirect WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1;
 IF m.terminal<>previous OR (destination<>id AND coalesce(actual,id)<>previous)
   OR (s.visibility<>'visible' AND previous=id) OR EXISTS(SELECT 1 FROM semantic.account_agent_subject WHERE route=r AND subject_id=id)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF previous=destination THEN RETURN true; END IF;
 SELECT revision INTO STRICT revision_no FROM semantic.revision WHERE route=r AND subject_id=id ORDER BY revision DESC LIMIT 1;
 IF destination=id THEN
  DELETE FROM semantic.redirect WHERE route=r AND subject_id=id AND sequence=sequence_no;
  IF EXISTS(SELECT 1 FROM semantic.redirect WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1) THEN RETURN false; END IF;
 ELSE
  INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
    VALUES(r,id,coalesce(sequence_no,0)+1,destination,tid);
 END IF;
 INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
 VALUES(r,id,revision_no+1,'merge',release_digest,tid);
 UPDATE semantic.subject SET current_release=release_digest,projection_pending=true WHERE route=r AND subject_id=id;
 IF s.visibility='visible' AND previous=id AND destination<>id THEN
  UPDATE semantic.partition_subjects SET visible=visible-1 WHERE partition_no=r/16;
 ELSIF s.visibility='visible' AND previous<>id AND destination=id THEN
  UPDATE semantic.partition_subjects SET visible=visible+1 WHERE partition_no=r/16;
 END IF;
 RETURN true;
END; $$;

-- migrate:down
-- Forward-only immutable terminal-detachment transforms cannot be discarded.
