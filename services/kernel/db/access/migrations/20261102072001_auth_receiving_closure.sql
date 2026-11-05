-- migrate:up
-- Same-home current receiving authority. Every read is an exact key; locks
-- survive the caller's destructive COMMIT. No Auth database is consulted.
CREATE FUNCTION access.lock_current_auth_receiving_closure(r integer,a uuid,v integer,t timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s access.auth_erasure_source; b access.auth_receiving_control; result jsonb;
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
 PERFORM 1 FROM access.account account JOIN access.erasure e USING(route,account_id)
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
 AND c.version=v AND c.at=t AND c.control_revision=b.revision AND o.custody_revision=b.revision
 AND c.physical_closure=o.physical_closure AND c.receiving_closure=o.receiving_closure
 FOR SHARE OF o,c,h;
 IF octet_length(result::text)>1024 THEN RETURN NULL; END IF;
 RETURN result;
END $$;

-- Native deletion cannot retire a held Auth witness using the early source
-- transfer alone, including callers outside the TypeScript page engine.
CREATE FUNCTION access.guard_auth_receiving_witness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root access.erasure; current_closure jsonb;
BEGIN
 SELECT * INTO root FROM access.erasure WHERE route=OLD.route AND account_id=OLD.account_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth current receiving closure unavailable' USING ERRCODE='23514';
 END IF;
 current_closure:=access.lock_current_auth_receiving_closure(OLD.route,OLD.account_id,root.version,root.at);
 IF current_closure IS NULL OR current_closure->>'sourceReceiptId' IS DISTINCT FROM OLD.receipt_id::text THEN
  RAISE EXCEPTION 'Auth current receiving closure unavailable' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER auth_receiving_witness BEFORE DELETE ON access.lifecycle_fence_receipt
 FOR EACH ROW EXECUTE FUNCTION access.guard_auth_receiving_witness();

-- migrate:down
-- Forward-only receiving witness custody.
