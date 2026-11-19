-- migrate:up
CREATE FUNCTION semantic.enroll_context_role_provenance(
 p_route integer,p_occurrence bigint,p_resource_id uuid,p_original_creator uuid,p_account_id uuid,
 p_grant_role text,p_valid text,p_side text,p_grant_transaction uuid,p_source_transaction uuid, p_command_transaction uuid)
RETURNS TABLE(state text,context_key bigint) LANGUAGE plpgsql AS $$
DECLARE c semantic.context; native_tx uuid; native_epoch integer; native_position bigint; original_position bigint;
 party record; existing semantic.context_role_enrollment; stage_commit boolean:=false;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0
 OR p_resource_id IS NULL OR p_source_transaction IS NULL
 OR (get_byte(uuid_send(p_resource_id),10)*256+get_byte(uuid_send(p_resource_id),11))<>p_route THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 -- Lock the actual Source key, including deleted-but-retained Contexts. Missing/purged is unresolved.
 SELECT * INTO c FROM semantic.context WHERE route=p_route AND context_id=p_resource_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN; END IF;
 -- Global has an explicit native no-personal-payload policy. Absence never establishes this policy.
 IF c.kind='global' THEN RETURN QUERY SELECT 'not-applicable'::text,NULL::bigint; RETURN; END IF;
 IF p_original_creator IS NULL OR p_account_id IS NULL
 OR p_original_creator IN ('00000000-0000-0000-0000-000000000000','00000000-0000-8000-8000-000000000001')
 OR p_account_id IN ('00000000-0000-0000-0000-000000000000','00000000-0000-8000-8000-000000000001')
 OR NOT coalesce((p_side='creator' AND p_account_id=p_original_creator AND p_grant_role=''
       AND p_grant_transaction IS NULL AND p_valid IS NULL)
    OR (p_side IN ('new','former') AND p_grant_role='semantic.context.owner'
       AND p_grant_transaction IS NOT NULL AND p_valid IS NOT NULL),false) THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 -- Deferred delivery uses the native basis already written by the executor. Redrive runs
 -- before that fence and may stage a Source commit only after the occurrence is validated.
 SELECT b.transaction_id,b.epoch,b.position INTO native_tx,native_epoch,native_position
 FROM core.partition p JOIN editorial.write_basis b ON b.partition_no=p.partition_no AND b.position=p.position
 WHERE p.partition_no=p_route/16 AND p.write_state='active' AND p.epoch=b.epoch
   AND b.xmin::text=pg_current_xact_id()::text FOR UPDATE OF p;
 IF NOT FOUND THEN
  SELECT s.transaction_id,s.epoch,s.position INTO native_tx,native_epoch,native_position
  FROM core.partition p JOIN semantic.erasure_source_commit s ON s.partition_no=p.partition_no
    AND s.epoch=p.epoch AND s.position=p.position+1
  WHERE p.partition_no=p_route/16 AND p.write_state='active'
    AND s.xmin::text=pg_current_xact_id()::text FOR UPDATE OF p;
  IF NOT FOUND AND p_command_transaction IS NOT NULL THEN
   SELECT p_command_transaction,p.epoch,p.position+1 INTO native_tx,native_epoch,native_position
   FROM core.partition p WHERE p.partition_no=p_route/16 AND p.write_state='active' FOR UPDATE OF p;
   stage_commit:=FOUND;
  END IF;
 END IF;
 IF p_command_transaction IS NOT NULL AND p_command_transaction IS DISTINCT FROM native_tx THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 IF native_tx IS NULL OR NOT ((p_source_transaction=native_tx AND NOT stage_commit) OR EXISTS(
   SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=p_route/16 AND b.transaction_id=p_source_transaction))
 OR (p_grant_transaction IS NOT NULL AND (p_grant_transaction<>native_tx OR stage_commit) AND NOT EXISTS(
   SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=p_route/16 AND b.transaction_id=p_grant_transaction)) THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 SELECT b.position INTO original_position FROM editorial.write_basis b
 WHERE b.partition_no=p_route/16 AND b.transaction_id=p_source_transaction;
 original_position:=coalesce(original_position,native_position);
 SELECT * INTO existing FROM semantic.context_role_enrollment WHERE route=p_route AND occurrence=p_occurrence;
 IF FOUND THEN
  IF existing.context_key=c.erasure_key AND existing.side=p_side
    AND existing.source_transaction=p_source_transaction
    AND existing.grant_transaction IS NOT DISTINCT FROM p_grant_transaction THEN
   RETURN QUERY SELECT 'enrolled'::text,c.erasure_key;
  ELSE RETURN QUERY SELECT 'pending'::text,NULL::bigint;
  END IF;
  RETURN;
 END IF;
 IF stage_commit THEN
  -- The deferred Source constraint matches this stamp to the executor's actual fence.
  INSERT INTO semantic.erasure_source_commit(partition_no,transaction_id,epoch,position)
  VALUES(p_route/16,native_tx,native_epoch,native_position);
 END IF;
 -- The native command gate serializes Source sealing and late admission. Only these exact
 -- parties/keys reopen; the ordinary locator relay owns account-home late-item registration.
 FOR party IN SELECT p_original_creator AS account_id,'author'::text AS role
   UNION SELECT p_account_id,'owner'::text WHERE p_side IN ('new','former') ORDER BY account_id,role LOOP
  DELETE FROM semantic.erasure_source_seal WHERE partition_no=p_route/16 AND account_id=party.account_id;
  PERFORM semantic.record_erasure_locator(p_route/16,party.account_id,party.role,'context',c.erasure_key,
    p_source_transaction,original_position);
  UPDATE semantic.erasure_locator SET state='pending'
   WHERE partition_no=p_route/16 AND account_id=party.account_id AND role=party.role
     AND store='context' AND record_key=c.erasure_key;
  UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_route/16 AND account_id=party.account_id;
 END LOOP;
 INSERT INTO semantic.context_role_enrollment(route,occurrence,context_key,side,grant_transaction,source_transaction,
   enrollment_transaction,epoch,position)
 VALUES(p_route,p_occurrence,c.erasure_key,p_side,p_grant_transaction,p_source_transaction,native_tx,native_epoch,native_position);
 RETURN QUERY SELECT 'enrolled'::text,c.erasure_key;
END; $$;

CREATE OR REPLACE FUNCTION semantic.enroll_context_role_provenance(
 p_route integer,p_occurrence bigint,p_resource_id uuid,p_original_creator uuid,p_account_id uuid,
 p_grant_role text,p_valid text,p_side text,p_grant_transaction uuid,p_source_transaction uuid)
RETURNS TABLE(state text,context_key bigint) LANGUAGE sql AS $$
 SELECT * FROM semantic.enroll_context_role_provenance(
  p_route,p_occurrence,p_resource_id,p_original_creator,p_account_id,p_grant_role,p_valid,
  p_side,p_grant_transaction,p_source_transaction,NULL::uuid)
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.enroll_context_role_provenance(
 p_route integer,p_occurrence bigint,p_resource_id uuid,p_original_creator uuid,p_account_id uuid,
 p_grant_role text,p_valid text,p_side text,p_grant_transaction uuid,p_source_transaction uuid)
RETURNS TABLE(state text,context_key bigint) LANGUAGE plpgsql AS $$
DECLARE c semantic.context; native_tx uuid; native_epoch integer; native_position bigint; original_position bigint;
 party record; existing semantic.context_role_enrollment;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0
 OR p_resource_id IS NULL OR p_source_transaction IS NULL
 OR (get_byte(uuid_send(p_resource_id),10)*256+get_byte(uuid_send(p_resource_id),11))<>p_route THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 -- Lock the actual Source key, including deleted-but-retained Contexts. Missing/purged is unresolved.
 SELECT * INTO c FROM semantic.context WHERE route=p_route AND context_id=p_resource_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN; END IF;
 -- Global has an explicit native no-personal-payload policy. Absence never establishes this policy.
 IF c.kind='global' THEN RETURN QUERY SELECT 'not-applicable'::text,NULL::bigint; RETURN; END IF;
 IF p_original_creator IS NULL OR p_account_id IS NULL
 OR p_original_creator IN ('00000000-0000-0000-0000-000000000000','00000000-0000-8000-8000-000000000001')
 OR p_account_id IN ('00000000-0000-0000-0000-000000000000','00000000-0000-8000-8000-000000000001')
 OR NOT coalesce((p_side='creator' AND p_account_id=p_original_creator AND p_grant_role=''
       AND p_grant_transaction IS NULL AND p_valid IS NULL)
    OR (p_side IN ('new','former') AND p_grant_role='semantic.context.owner'
       AND p_grant_transaction IS NOT NULL AND p_valid IS NOT NULL),false) THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 -- The original deferred Access trigger already has a native basis. The TS command-body port
 -- may instead have its actual Source commit, constrained to the executor's forthcoming fence.
 SELECT b.transaction_id,b.epoch,b.position INTO native_tx,native_epoch,native_position
 FROM core.partition p JOIN editorial.write_basis b ON b.partition_no=p.partition_no AND b.position=p.position
 WHERE p.partition_no=p_route/16 AND p.write_state='active' AND p.epoch=b.epoch
   AND b.xmin::text=pg_current_xact_id()::text FOR UPDATE OF p;
 IF NOT FOUND THEN
  SELECT s.transaction_id,s.epoch,s.position INTO native_tx,native_epoch,native_position
  FROM core.partition p JOIN semantic.erasure_source_commit s ON s.partition_no=p.partition_no
    AND s.epoch=p.epoch AND s.position=p.position+1
  WHERE p.partition_no=p_route/16 AND p.write_state='active'
    AND s.xmin::text=pg_current_xact_id()::text FOR UPDATE OF p;
 END IF;
 IF native_tx IS NULL OR NOT (p_source_transaction=native_tx OR EXISTS(
   SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=p_route/16 AND b.transaction_id=p_source_transaction))
 OR (p_grant_transaction IS NOT NULL AND p_grant_transaction<>native_tx AND NOT EXISTS(
   SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=p_route/16 AND b.transaction_id=p_grant_transaction)) THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 SELECT b.position INTO original_position FROM editorial.write_basis b
 WHERE b.partition_no=p_route/16 AND b.transaction_id=p_source_transaction;
 original_position:=coalesce(original_position,native_position);
 SELECT * INTO existing FROM semantic.context_role_enrollment WHERE route=p_route AND occurrence=p_occurrence;
 IF FOUND THEN
  IF existing.context_key=c.erasure_key AND existing.side=p_side
    AND existing.source_transaction=p_source_transaction
    AND existing.grant_transaction IS NOT DISTINCT FROM p_grant_transaction THEN
   RETURN QUERY SELECT 'enrolled'::text,c.erasure_key;
  ELSE RETURN QUERY SELECT 'pending'::text,NULL::bigint;
  END IF;
  RETURN;
 END IF;
 -- The native command gate serializes Source sealing and late admission. Only these exact
 -- parties/keys reopen; the ordinary locator relay owns account-home late-item registration.
 FOR party IN SELECT p_original_creator AS account_id,'author'::text AS role
   UNION SELECT p_account_id,'owner'::text WHERE p_side IN ('new','former') ORDER BY account_id,role LOOP
  DELETE FROM semantic.erasure_source_seal WHERE partition_no=p_route/16 AND account_id=party.account_id;
  PERFORM semantic.record_erasure_locator(p_route/16,party.account_id,party.role,'context',c.erasure_key,
    p_source_transaction,original_position);
  UPDATE semantic.erasure_locator SET state='pending'
   WHERE partition_no=p_route/16 AND account_id=party.account_id AND role=party.role
     AND store='context' AND record_key=c.erasure_key;
  UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_route/16 AND account_id=party.account_id;
 END LOOP;
 INSERT INTO semantic.context_role_enrollment(route,occurrence,context_key,side,grant_transaction,source_transaction,
   enrollment_transaction,epoch,position)
 VALUES(p_route,p_occurrence,c.erasure_key,p_side,p_grant_transaction,p_source_transaction,native_tx,native_epoch,native_position);
 RETURN QUERY SELECT 'enrolled'::text,c.erasure_key;
END; $$;
DROP FUNCTION semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid,uuid);
