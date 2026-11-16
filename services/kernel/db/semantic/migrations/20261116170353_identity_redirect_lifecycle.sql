-- migrate:up
-- A NULL target ends the redirect at this sequence. The earlier targets remain evidence.
ALTER TABLE semantic.redirect ALTER COLUMN target DROP NOT NULL;

CREATE OR REPLACE FUNCTION semantic.prevent_redirect_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.target IS NOT NULL THEN RETURN NEW; END IF;
    IF semantic.identity_epoch_mapping_owns(NEW.route,NEW.subject_id) AND EXISTS (
      SELECT 1
      FROM semantic.identity_epoch_mapping_fence f
      JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(f.route,f.destination)
      JOIN LATERAL (
        SELECT sequence,target FROM semantic.redirect
        WHERE (route,subject_id)=(f.route,f.destination) ORDER BY sequence DESC LIMIT 1
      ) head ON head.sequence+1=NEW.sequence AND head.target=m.terminal AND head.target<>m.original
      JOIN LATERAL (
        SELECT kind,recorded_transaction_id,xmin FROM semantic.revision
        WHERE (route,subject_id)=(f.route,f.destination) ORDER BY revision DESC LIMIT 1
      ) revision ON revision.kind='merge' AND revision.recorded_transaction_id=f.transaction_id
        AND revision.xmin::text=pg_current_xact_id()::text
      WHERE (f.route,f.destination,f.transaction_id)=(NEW.route,NEW.subject_id,NEW.recorded_transaction_id)
    ) THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.target IS NOT NULL AND EXISTS (
    -- The legacy Accounts writer can remove the exact redirect it revokes in this transaction.
    SELECT 1 FROM (
      SELECT revocation_receipt_id,revoked_survivor_id,xmin FROM semantic.revision
      WHERE (route,subject_id)=(OLD.route,OLD.subject_id) ORDER BY revision DESC LIMIT 1
    ) revision
    WHERE revision.revocation_receipt_id IS NOT NULL AND revision.revoked_survivor_id=OLD.target
      AND revision.xmin::text=pg_current_xact_id()::text
      AND NOT EXISTS (
        SELECT 1 FROM semantic.identity_epoch_mapping_fence
        WHERE (route,destination)=(OLD.route,OLD.subject_id)
      )
  ) THEN RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Semantic redirects are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER redirect_immutable ON semantic.redirect;
CREATE TRIGGER redirect_immutable BEFORE INSERT OR UPDATE OR DELETE ON semantic.redirect
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_redirect_mutation();

DROP FUNCTION semantic.apply_identity_epoch_mapping_source(integer,uuid,uuid,uuid,text,uuid);
CREATE FUNCTION semantic.apply_identity_epoch_mapping_source(
  r integer,id uuid,previous uuid,destination uuid,release_digest text,tid uuid,
  p_job uuid,p_job_epoch bigint,effect_scope text,effect_unit integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m semantic.identity_epoch_mapping;
  s semantic.subject;
  revision_no integer;
  sequence_no integer;
  actual uuid;
BEGIN
  IF r IS DISTINCT FROM get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11)
    OR NOT EXISTS (
      SELECT 1 FROM semantic.identity_epoch_mapping_effect e
      JOIN semantic.identity_epoch_mapping_fence f
        ON (f.route,f.destination,f.job_id,f.job_epoch,f.transaction_id)=(r,id,e.job_id,e.job_epoch,e.transaction_id)
      JOIN semantic.identity_epoch_home_gate g
        ON (g.route,g.destination,g.original,g.pending_job,g.pending_epoch,g.recorded_transaction_id)=
           (r,id,id,e.job_id,e.job_epoch,e.transaction_id)
      WHERE (e.partition_no,e.job_id,e.job_epoch,e.unit,e.scope_digest,e.transaction_id)=
            (r/16,p_job,p_job_epoch,effect_unit,effect_scope,tid)
        AND e.xmin::text=pg_current_xact_id()::text AND f.xmin=e.xmin AND g.xmin=e.xmin
    )
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  SELECT * INTO STRICT m FROM semantic.identity_epoch_mapping WHERE route=r AND original=id FOR UPDATE;
  SELECT * INTO STRICT s FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
  SELECT target,sequence INTO actual,sequence_no FROM semantic.redirect
    WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1;
  IF m.terminal IS DISTINCT FROM previous OR coalesce(actual,id) IS DISTINCT FROM previous
    OR NOT EXISTS (
      SELECT 1 FROM core.partition p WHERE p.partition_no=r/16 AND p.epoch=m.owner_epoch AND p.write_state='active'
    )
    OR (s.visibility<>'visible' AND previous=id)
    OR (
      EXISTS(SELECT 1 FROM semantic.account_agent_subject WHERE route=r AND subject_id=id)
      AND NOT EXISTS (
        SELECT 1 FROM semantic.identity_epoch_job j WHERE j.job_id=p_job AND j.epoch=p_job_epoch
          AND j.receipt->>'kind' IN ('account-agent.verify','account-agent.unverify')
      )
    )
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  IF previous=destination THEN RETURN; END IF;
  SELECT revision INTO STRICT revision_no FROM semantic.revision
    WHERE route=r AND subject_id=id ORDER BY revision DESC LIMIT 1;
  INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
    VALUES(r,id,revision_no+1,'merge',release_digest,tid);
  INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
    VALUES(r,id,coalesce(sequence_no,0)+1,nullif(destination,id),tid);
  UPDATE semantic.subject SET current_release=release_digest,projection_pending=true
    WHERE route=r AND subject_id=id;
  IF s.visibility='visible' AND previous=id THEN
    UPDATE semantic.partition_subjects SET visible=visible-1 WHERE partition_no=r/16;
  ELSIF s.visibility='visible' AND destination=id THEN
    UPDATE semantic.partition_subjects SET visible=visible+1 WHERE partition_no=r/16;
  END IF;
END;
$$;

-- migrate:down
-- A database that has ended a redirect cannot represent its history with the old schema.
ALTER TABLE semantic.redirect ALTER COLUMN target SET NOT NULL;

DROP FUNCTION semantic.apply_identity_epoch_mapping_source(integer,uuid,uuid,uuid,text,uuid,uuid,bigint,text,integer);
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
   OR (s.visibility<>'visible' AND previous=id)
   OR (
     EXISTS(SELECT 1 FROM semantic.account_agent_subject WHERE route=r AND subject_id=id)
     AND NOT EXISTS(
       SELECT 1 FROM semantic.identity_epoch_mapping_fence f
       JOIN semantic.identity_epoch_job j ON j.job_id=f.job_id AND j.epoch=f.job_epoch
       WHERE f.route=r AND f.destination=id AND f.transaction_id=tid
         AND j.receipt->>'kind' IN ('account-agent.verify','account-agent.unverify')
     )
   )
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


DROP TRIGGER redirect_immutable ON semantic.redirect;
CREATE OR REPLACE FUNCTION semantic.prevent_redirect_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1
      FROM semantic.revision AS revision
      WHERE revision.route = OLD.route AND revision.subject_id = OLD.subject_id
        AND revision.revision = (
          SELECT max(latest.revision)
          FROM semantic.revision AS latest
          WHERE latest.route = OLD.route AND latest.subject_id = OLD.subject_id
        )
        AND revision.revocation_receipt_id IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Semantic redirects are immutable' USING ERRCODE = '23514';
  END;
  $$;

CREATE TRIGGER redirect_immutable BEFORE DELETE OR UPDATE ON semantic.redirect
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_redirect_mutation();
