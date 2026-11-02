-- migrate:up
-- A valid source commit has the same current-xact write basis, whose home/position is unique.
-- This is a keyed delivery lookup, not a cardinality bound on original roles.
CREATE UNIQUE INDEX erasure_source_commit_native_position
 ON semantic.erasure_source_commit(partition_no,epoch,position);

-- Operational, transaction-local funding events. They convey no Source support or completion.
-- Every deferred event is represented, including repeated UPDATE of one effect receipt/step.
CREATE TABLE semantic.identity_receiving_capture_pending (
 transaction_xid text NOT NULL,
 ordinal bigint GENERATED ALWAYS AS IDENTITY,
 partition_no integer NOT NULL,
 store text NOT NULL CHECK (store IN ('identity_epoch_receiving_plan','identity_epoch_receiving_record',
  'identity_epoch_receiving_effect','identity_epoch_receiving_custody','identity_epoch_effect_receipt','identity_epoch_step')),
 record_key bigint NOT NULL,
 job_id uuid,
 source_transaction_id uuid,
 native_transaction_id uuid,
 copy_roles bigint,
 source_roles bigint,
 basis_locators integer,
 basis_bytes integer,
 armed boolean NOT NULL DEFAULT false,
 PRIMARY KEY (transaction_xid,ordinal),
 CHECK (NOT armed OR (source_transaction_id IS NOT NULL AND copy_roles IS NOT NULL AND source_roles IS NOT NULL
   AND copy_roles>=0 AND source_roles>=0
   AND (basis_locators IS NULL OR basis_locators BETWEEN 0 AND 5)
   AND (basis_bytes IS NULL OR basis_bytes IN (0,92))
   AND ((basis_locators IS NULL)=(basis_bytes IS NULL))))
);
CREATE INDEX identity_receiving_capture_event
 ON semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,ordinal);

CREATE FUNCTION semantic.enqueue_identity_receiving_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('semantic.identity_receiving_capture',true) IS DISTINCT FROM 'on'
    OR current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME IN ('identity_epoch_effect_receipt','identity_epoch_step') THEN
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,job_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.job_id);
 ELSE
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,source_transaction_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_plan
 FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();
CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_record
 FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();
CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_effect
 FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();
CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_custody
 FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();
CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT OR UPDATE ON semantic.identity_epoch_effect_receipt
 FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();
CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT OR UPDATE ON semantic.identity_epoch_step
 FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();

-- Preserve other callers, including their original capture ordering and write-basis projection.
CREATE FUNCTION semantic.capture_erasure_roles_unfunded(p_home integer, p_store text, p_key bigint, p_tx uuid) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;
BEGIN
 SELECT position INTO native_position FROM core.partition WHERE partition_no=p_home;
 FOR r IN SELECT account_id,role FROM semantic.erasure_copy_role
   WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,p_tx,native_position);
 END LOOP;
 FOR r IN SELECT transaction_id,account_id,role FROM semantic.erasure_source_role
   WHERE partition_no=p_home AND transaction_id IN (p_tx,nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid) LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,r.transaction_id,native_position);
 END LOOP;
 SELECT * INTO b FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
 ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
 RETURNING record_key INTO provenance_key;
 IF b.principal_kind='account' THEN
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor','write_basis',provenance_key,p_tx,b.position);
 END IF;
 IF b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN
  acting_human:=split_part(b.requested_by,':',4)::uuid;
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human','write_basis',provenance_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'delegate',p_store,p_key,p_tx,b.position);
 END IF;
END; $_$;

CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles(p_home integer,p_store text,p_key bigint,p_tx uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 b record; provenance_key bigint; r record; native_position bigint; acting_human uuid;
 native_tx uuid:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 source_tx uuid; previous_account uuid; previous_role text;
 copies bigint:=0; sources bigint:=0; basis_count integer; requested_bytes integer;
 funded boolean:=current_setting('semantic.identity_receiving_capture',true)='on';
 budget semantic.identity_receiving_capture_pending;
BEGIN
 IF NOT coalesce(funded,false) OR p_store NOT IN ('identity_epoch_receiving_plan','identity_epoch_receiving_record',
    'identity_epoch_receiving_effect','identity_epoch_receiving_custody','identity_epoch_effect_receipt','identity_epoch_step') THEN
  PERFORM semantic.capture_erasure_roles_unfunded(p_home,p_store,p_key,p_tx);
  RETURN;
 END IF;
 IF funded THEN
  -- Consume one actual event in this DB transaction, not a caller-supplied count or cached proof.
  SELECT * INTO budget FROM semantic.identity_receiving_capture_pending
   WHERE transaction_xid=pg_current_xact_id()::text AND partition_no=p_home AND store=p_store AND record_key=p_key
   ORDER BY ordinal LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR NOT budget.armed OR budget.source_transaction_id IS DISTINCT FROM p_tx
     OR budget.native_transaction_id IS DISTINCT FROM native_tx THEN
   RAISE EXCEPTION 'identity_receiving_capture_unfunded_event' USING ERRCODE='23514';
  END IF;
  DELETE FROM semantic.identity_receiving_capture_pending
   WHERE transaction_xid=budget.transaction_xid AND ordinal=budget.ordinal;
 END IF;
 SELECT position INTO native_position FROM core.partition WHERE partition_no=p_home;
 LOOP
  IF previous_account IS NULL THEN
   SELECT account_id,role INTO r FROM semantic.erasure_copy_role
    WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx
    ORDER BY account_id,role LIMIT 1;
  ELSE
   SELECT account_id,role INTO r FROM semantic.erasure_copy_role
    WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx
     AND (account_id,role)>(previous_account,previous_role) ORDER BY account_id,role LIMIT 1;
  END IF;
  EXIT WHEN NOT FOUND;
  copies:=copies+1;
  IF funded AND copies>budget.copy_roles THEN
   RAISE EXCEPTION 'identity_receiving_capture_copy_funding_changed' USING ERRCODE='23514';
  END IF;
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,p_tx,native_position);
  previous_account:=r.account_id; previous_role:=r.role;
 END LOOP;
 FOREACH source_tx IN ARRAY ARRAY[p_tx,CASE WHEN native_tx IS DISTINCT FROM p_tx THEN native_tx ELSE NULL END] LOOP
  CONTINUE WHEN source_tx IS NULL;
  previous_account:=NULL; previous_role:=NULL;
  LOOP
   IF previous_account IS NULL THEN
    SELECT account_id,role INTO r FROM semantic.erasure_source_role
     WHERE partition_no=p_home AND transaction_id=source_tx ORDER BY account_id,role LIMIT 1;
   ELSE
    SELECT account_id,role INTO r FROM semantic.erasure_source_role
     WHERE partition_no=p_home AND transaction_id=source_tx AND (account_id,role)>(previous_account,previous_role)
     ORDER BY account_id,role LIMIT 1;
   END IF;
   EXIT WHEN NOT FOUND;
   sources:=sources+1;
   IF funded AND sources>budget.source_roles THEN
    RAISE EXCEPTION 'identity_receiving_capture_source_funding_changed' USING ERRCODE='23514';
   END IF;
   PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,source_tx,native_position);
   previous_account:=r.account_id; previous_role:=r.role;
  END LOOP;
 END LOOP;
 IF funded AND (copies<>budget.copy_roles OR sources<>budget.source_roles) THEN
  RAISE EXCEPTION 'identity_receiving_capture_original_roles_changed' USING ERRCODE='23514';
 END IF;
 -- No full write-basis row or unbounded client/request text is read. The original expression
 -- can match only this exact ASCII length. All original actor/delegation roles are preserved.
 SELECT principal_kind,principal_id,position,
  CASE WHEN octet_length(requested_by)=92 THEN requested_by ELSE NULL END AS requested_by
 INTO b FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx;
 IF NOT FOUND THEN
  IF funded AND budget.basis_locators IS NOT NULL THEN
   RAISE EXCEPTION 'identity_receiving_capture_original_basis_changed' USING ERRCODE='23514';
  END IF;
  RETURN;
 END IF;
 requested_bytes:=coalesce(octet_length(b.requested_by),0);
 basis_count:=CASE WHEN b.principal_kind='account' THEN 2 ELSE 0 END
  + CASE WHEN b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN 3 ELSE 0 END;
 IF funded AND (budget.basis_locators IS DISTINCT FROM basis_count OR budget.basis_bytes IS DISTINCT FROM requested_bytes) THEN
  RAISE EXCEPTION 'identity_receiving_capture_original_basis_changed' USING ERRCODE='23514';
 END IF;
 INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
  ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
  RETURNING record_key INTO provenance_key;
 IF b.principal_kind='account' THEN
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor','write_basis',provenance_key,p_tx,b.position);
 END IF;
 IF b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN
  acting_human:=split_part(b.requested_by,':',4)::uuid;
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human','write_basis',provenance_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'delegate',p_store,p_key,p_tx,b.position);
 END IF;
END; $$;

-- migrate:down
-- Capture semantics and provenance are not safely downgraded with live receiving records.
DO $$ BEGIN RAISE EXCEPTION 'receiving capture cost migration is forward-only'; END; $$;
