-- migrate:up
CREATE OR REPLACE FUNCTION semantic.apply_identity_epoch_mapping_source(
  r integer,id uuid,previous uuid,destination uuid,release_digest text,tid uuid,
  p_job uuid,p_job_epoch bigint,effect_scope text,effect_unit integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m semantic.identity_epoch_mapping;
  s semantic.subject;
  revision_no integer;
  sequence_no integer;
  actual uuid;
  decision jsonb;
  intent jsonb;
  verification text;
  revocation text;
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
  SELECT j.receipt,j.intent INTO STRICT decision,intent FROM semantic.identity_epoch_job j
    WHERE j.partition_no=(get_byte(uuid_send(p_job),10)*256+get_byte(uuid_send(p_job),11))/16
      AND j.job_id=p_job AND j.epoch=p_job_epoch AND j.scope_digest=effect_scope AND j.state='pending'
      AND j.intent->>'release'=release_digest;
  IF m.terminal IS DISTINCT FROM previous OR coalesce(actual,id) IS DISTINCT FROM previous
    OR NOT EXISTS (
      SELECT 1 FROM core.partition p WHERE p.partition_no=r/16 AND p.epoch=m.owner_epoch AND p.write_state='active'
    )
    OR (s.visibility<>'visible' AND previous=id)
    OR (
      EXISTS(SELECT 1 FROM semantic.account_agent_subject WHERE route=r AND subject_id=id)
      AND decision->>'kind' NOT IN ('account-agent.verify','account-agent.unverify')
    )
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  IF previous=destination THEN RETURN; END IF;
  SELECT revision INTO STRICT revision_no FROM semantic.revision
    WHERE route=r AND subject_id=id ORDER BY revision DESC LIMIT 1;
  IF decision->>'kind'='account-agent.verify' AND intent->>'redirected'=id::text THEN
    IF intent->>'kind' IS DISTINCT FROM 'merge' OR intent->>'survivor' IS DISTINCT FROM destination::text THEN
      RAISE EXCEPTION 'identity_effect_stale';
    END IF;
    verification:=decision->>'receipt';
    DELETE FROM semantic.account_agent_subject
      WHERE route=r AND subject_id=id AND agent_id=id AND account_route=r
        AND account_id=(decision->>'account')::uuid AND NOT verified AND receipt_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  ELSIF decision->>'kind'='account-agent.unverify' AND intent->>'original'=id::text THEN
    IF intent->>'kind' IS DISTINCT FROM 'unmerge' OR destination<>id OR intent->>'verificationReceipt' IS NULL THEN
      RAISE EXCEPTION 'identity_effect_stale';
    END IF;
    verification:=intent->>'verificationReceipt';
    revocation:=decision->>'receipt';
  END IF;
  INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id,
    verification_receipt_id,revocation_receipt_id,revoked_survivor_id)
    VALUES(r,id,revision_no+1,'merge',release_digest,tid,verification,revocation,
      CASE WHEN revocation IS NOT NULL THEN previous END);
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
CREATE OR REPLACE FUNCTION semantic.apply_identity_epoch_mapping_source(
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
