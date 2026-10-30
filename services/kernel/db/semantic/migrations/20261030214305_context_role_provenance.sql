-- migrate:up
-- Technical occurrence receipts join the existing Context inventory; no party vector is copied.
CREATE TABLE semantic.context_role_enrollment (
 route integer NOT NULL, occurrence bigint NOT NULL CHECK(occurrence>0), context_key bigint NOT NULL,
 side text NOT NULL CHECK(side IN ('creator','new','former')),
 grant_transaction uuid, source_transaction uuid NOT NULL,
 enrollment_transaction uuid NOT NULL, epoch integer NOT NULL, position bigint NOT NULL,
 PRIMARY KEY(route,occurrence),
 FOREIGN KEY(context_key,route) REFERENCES semantic.context(erasure_key,route) ON DELETE CASCADE
);
CREATE INDEX context_role_enrollment_context ON semantic.context_role_enrollment(context_key,route,occurrence);
CREATE FUNCTION semantic.validate_context_role_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM editorial.write_basis b JOIN core.partition p USING(partition_no)
   WHERE b.partition_no=NEW.route/16 AND b.transaction_id=NEW.enrollment_transaction
     AND b.epoch=NEW.epoch AND b.position=NEW.position AND p.epoch=b.epoch
     AND p.position=b.position AND p.write_state='active' AND b.xmin::text=pg_current_xact_id()::text)
 OR NOT EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.route/16 AND b.transaction_id=NEW.source_transaction)
 OR (NEW.grant_transaction IS NOT NULL AND NOT EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.route/16 AND b.transaction_id=NEW.grant_transaction)) THEN
  RAISE EXCEPTION 'Context role enrollment lacks native same-home command provenance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_role_enrollment_native_commit AFTER INSERT ON semantic.context_role_enrollment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_context_role_enrollment();

CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer,p_account uuid,p_role text,p_store text,p_key bigint,p_tx uuid,p_position bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE delivery bigint; is_global boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_seal s WHERE s.partition_no=p_home AND s.account_id=p_account) THEN
  -- Re-reporting unchanged provenance of a survivor's existing row creates no new role.
  IF EXISTS(SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account
    AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.source_transaction_id IS NOT DISTINCT FROM p_tx) THEN RETURN; END IF;
  RAISE EXCEPTION 'Semantic erased Source role admission is sealed' USING ERRCODE='23514';
 END IF;
 -- A command-body Source enrollment has a deferred native fence, never a setting as proof.
 SELECT coalesce((SELECT c.position FROM semantic.erasure_source_commit c
   WHERE c.partition_no=p_home AND c.epoch=p.epoch AND c.position=p.position+1
     AND c.xmin::text=pg_current_xact_id()::text),p.position)
 INTO delivery FROM core.partition p WHERE p.partition_no=p_home;
 IF p_position IS NULL THEN SELECT position INTO p_position FROM core.partition WHERE partition_no=p_home; END IF;
 IF p_store='outbound_link' THEN SELECT context_id='00000000-0000-8000-8000-000000000000' INTO is_global FROM semantic.outbound_link WHERE route BETWEEN p_home*16 AND p_home*16+15 AND erasure_key=p_key;
 ELSIF p_store='inbound_link' THEN SELECT context_id='00000000-0000-8000-8000-000000000000' INTO is_global FROM semantic.inbound_link WHERE route BETWEEN p_home*16 AND p_home*16+15 AND erasure_key=p_key; END IF;
 IF p_account IS NULL OR p_account='00000000-0000-0000-0000-000000000000' OR p_account='00000000-0000-8000-8000-000000000001' THEN RETURN; END IF;
 INSERT INTO semantic.erasure_locator(partition_no,account_id,role,store,record_key,source_transaction_id,source_position,delivery_position,projection_global)
 VALUES(p_home,p_account,p_role,p_store,p_key,p_tx,p_position,delivery,coalesce(is_global,false))
 ON CONFLICT(partition_no,account_id,role,store,record_key) DO UPDATE
 SET source_transaction_id=EXCLUDED.source_transaction_id,source_position=EXCLUDED.source_position,delivery_position=EXCLUDED.delivery_position,
 state=CASE WHEN semantic.erasure_locator.delivery_position IS DISTINCT FROM EXCLUDED.delivery_position THEN 'pending' ELSE semantic.erasure_locator.state END;
 -- A new native local obligation invalidates a previously empty local page. Late resolution uses the account-home inbox.
 UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_home AND account_id=p_account AND state='complete' AND EXISTS (SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.state='pending');
END; $$;
-- Access owns validating/locking route+occurrence. This function never reads foreign Access tables.
CREATE FUNCTION semantic.enroll_context_role_provenance(
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

-- migrate:down
DROP FUNCTION semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid);
DROP TABLE semantic.context_role_enrollment;
DROP FUNCTION semantic.validate_context_role_enrollment();
