-- migrate:up
CREATE OR REPLACE FUNCTION access.lock_current_auth_receiving_closure(r integer,a uuid,v integer,t timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s access.auth_erasure_source; b access.auth_receiving_control; result jsonb; native_receipt uuid;
BEGIN
 SELECT source.* INTO s FROM core.partition p JOIN access.auth_erasure_source source USING(partition_no)
 WHERE p.partition_no=r/16 AND p.write_state='active' AND source.initialized
 AND octet_length(source.source_owner)<=256
 AND p.epoch=source.source_epoch AND p.node=source.source_owner FOR SHARE OF p,source;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM access.auth_receiving_control WHERE partition_no=r/16 AND state='active'
 AND source_generation=s.generation AND source_epoch=s.source_epoch AND source_owner=s.source_owner
 AND (requested_restore IS NULL OR requested_restore=restore_generation) FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT original.receipt_id INTO native_receipt FROM access.account account JOIN access.erasure e USING(route,account_id)
 JOIN access.auth_erasure_obligation original USING(route,account_id)
 WHERE account.route=r AND account.account_id=a AND account.state='deleted' AND account.authn_fenced
 AND original.minimum_authn_epoch IS NOT NULL AND account.minimum_authn_epoch>=original.minimum_authn_epoch
 AND e.version=v AND e.at=t AND original.version=v AND original.at=t FOR SHARE OF account,e,original;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('barrier',jsonb_build_object('accountId',a,'version',v,'at',t::text),'binding',jsonb_build_object(
   'partition',b.partition_no,'sourceGeneration',b.source_generation,'sourceEpoch',b.source_epoch,
   'sourceOwner',b.source_owner,'controlRevision',b.revision::text,'databaseIdentity',b.database_identity,
   'receivingIncarnation',b.receiving_incarnation,'restoreGeneration',b.restore_generation,
   'ownerInstallation',b.owner_installation,'writerFence',b.writer_fence),
   'nativeObligationId',c.native_obligation_id::text,'closureReceiptId',c.closure_receipt_id,
   'continuationId',c.continuation_id,'sourceReceiptId',c.source_receipt_id) INTO result
 FROM access.auth_receiving_obligation o JOIN access.auth_receiving_closure c USING(route,account_id)
 JOIN access.auth_history_proof h ON h.route=c.route AND h.account_id=c.account_id
 AND h.phase='native-consumed' AND h.version=c.version AND h.at=c.at
 AND h.continuation_id=c.continuation_id AND h.receipt_id=c.source_receipt_id
 WHERE o.route=r AND o.account_id=a AND o.partition_no=r/16 AND o.version=v AND o.at=t
 AND c.source_receipt_id=native_receipt
 AND c.version=v AND c.at=t AND c.control_revision=b.revision AND o.custody_revision=b.revision
 AND c.physical_closure=o.physical_closure AND c.receiving_closure=o.receiving_closure
 FOR SHARE OF o,c,h;
 IF octet_length(result::text)>1024 THEN RETURN NULL; END IF;
 RETURN result;
END $$;


-- INSERT must validate the same native binding and original source as current
-- readers. Immutability alone only prevents later mutation of an invalid row.
CREATE FUNCTION access.auth_receiving_closure_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s access.auth_erasure_source; b access.auth_receiving_control; original_receipt uuid;
BEGIN
 SELECT source.* INTO s FROM core.partition p JOIN access.auth_erasure_source source USING(partition_no)
 WHERE p.partition_no=NEW.route/16 AND p.write_state='active' AND source.initialized
 AND octet_length(source.source_owner)<=256
 AND p.epoch=source.source_epoch AND p.node=source.source_owner FOR SHARE OF p,source;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth current receiving closure unavailable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO b FROM access.auth_receiving_control WHERE partition_no=NEW.route/16 AND state='active'
 AND source_generation=s.generation AND source_epoch=s.source_epoch AND source_owner=s.source_owner
 AND revision=NEW.control_revision
 AND (requested_restore IS NULL OR requested_restore=restore_generation) FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth current receiving closure unavailable' USING ERRCODE='23514';
 END IF;
 SELECT original.receipt_id INTO original_receipt FROM access.account account
 JOIN access.erasure e USING(route,account_id)
 JOIN access.auth_erasure_obligation original USING(route,account_id)
 WHERE account.route=NEW.route AND account.account_id=NEW.account_id AND account.state='deleted' AND account.authn_fenced
 AND original.minimum_authn_epoch IS NOT NULL AND account.minimum_authn_epoch>=original.minimum_authn_epoch
 AND e.version=NEW.version AND e.at=NEW.at AND original.version=e.version AND original.at=e.at
 FOR SHARE OF account,e,original;
 IF NOT FOUND OR NEW.source_receipt_id IS DISTINCT FROM original_receipt OR NEW.continuation_id IS NULL
    OR NEW.published_xid<>pg_current_xact_id() THEN
  RAISE EXCEPTION 'Auth receiving source receipt mismatch' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM access.auth_receiving_obligation o JOIN access.auth_history_proof h USING(route,account_id)
 WHERE o.route=NEW.route AND o.account_id=NEW.account_id AND o.partition_no=NEW.route/16
 AND o.version=NEW.version AND o.at=NEW.at AND o.custody_revision=b.revision
 AND o.physical_closure=NEW.physical_closure AND o.receiving_closure=NEW.receiving_closure
 AND h.phase='native-consumed' AND h.version=NEW.version AND h.at=NEW.at
 AND h.continuation_id=NEW.continuation_id AND h.receipt_id=NEW.source_receipt_id FOR SHARE OF o,h;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth receiving custody unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER auth_receiving_closure_insert_guard BEFORE INSERT ON access.auth_receiving_closure
 FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_closure_insert_guard();

-- migrate:down
-- Forward-only original-source and receiving publication guards.
