-- migrate:up
-- Stable, account-free evidence for the exact successor already installed by ordinary native disposition.
CREATE FUNCTION library.frozen_public_output_successor(rte integer, cid uuid, gen uuid)
RETURNS TABLE(hold_id uuid, activation_position bigint)
LANGUAGE sql STABLE STRICT AS $$
 SELECT successor.hold_id,b.activation_position
 FROM library.collection_retained_output f
 JOIN library.collection c ON (c.route,c.collection_id)=(f.route,f.collection_id)
 JOIN library.collection_source_output g ON (g.route,g.collection_id,g.generation)=(f.route,f.collection_id,f.generation)
 JOIN library.native_public_output_binding b
  ON b.partition_no=f.partition_no AND b.capture_id=f.generation AND (b.route,b.collection_id)=(f.route,f.collection_id)
  AND b.output_generation=f.generation AND b.activation_transaction_id=f.transaction_id
  AND b.activation_source_generation=f.source_generation
  AND b.payload#>>'{tuple,publication,nativeXid}'=f.native_xid::text
 JOIN library.native_public_output_hold predecessor
  ON (predecessor.partition_no,predecessor.hold_id,predecessor.capture_id)=(b.partition_no,b.hold_id,b.capture_id)
 JOIN library.native_public_output_transition t
  ON (t.partition_no,t.hold_id,t.capture_id,t.binding_digest)=(b.partition_no,b.hold_id,b.capture_id,b.binding_digest)
  AND t.kind='applied' AND t.epoch=b.owner_epoch AND t.transaction_id=predecessor.consumed_by
 JOIN library.native_public_output_hold successor
  ON (successor.partition_no,successor.hold_id,successor.capture_id)=(t.partition_no,t.successor_hold_id,t.capture_id)
  AND successor.role='successor' AND successor.consumed_by IS NULL AND successor.transaction_id=t.transaction_id
  AND (successor.route,successor.collection_id,successor.output_generation,successor.activation_transaction_id,
       successor.activation_position,successor.activation_source_generation,successor.incarnation)=
      (b.route,b.collection_id,b.output_generation,b.activation_transaction_id,
       b.activation_position,b.activation_source_generation,b.incarnation)
 JOIN library.native_public_output_receiving recv
  ON (recv.partition_no,recv.capture_id)=(b.partition_no,b.capture_id)
  AND recv.state='applied' AND recv.transaction_id=t.transaction_id AND recv.receiving_epoch=b.receiving_epoch+1
 JOIN semantic.identity_public_output_disposition d
  ON (d.partition_no,d.capture_id,d.hold_id,d.binding_digest,d.transaction_id,d.native_epoch,d.native_position,d.kind)=
     (t.partition_no,t.capture_id,t.hold_id,t.binding_digest,t.transaction_id,t.epoch,t.position,t.kind)
 JOIN semantic.identity_public_output_transition sd
  ON (sd.partition_no,sd.capture_id,sd.transaction_id,sd.native_epoch,sd.native_position,sd.kind,sd.successor_hold_id)=
     (d.partition_no,d.capture_id,d.transaction_id,d.native_epoch,d.native_position,d.kind,t.successor_hold_id)
 JOIN semantic.identity_public_output_seal seal
  ON (seal.partition_no,seal.capture_id,seal.transaction_id,seal.manifest_digest)=
     (d.partition_no,d.capture_id,d.seal_transaction_id,d.manifest_digest)
  AND seal.raw_count=f.members
 JOIN semantic.identity_epoch_native_commit n
  ON (n.partition_no,n.transaction_id,n.epoch,n.position,n.purpose)=
     (t.partition_no,t.transaction_id,t.epoch,t.position,t.purpose)
  AND n.xmin=t.xmin AND n.xmin=d.xmin AND n.xmin=sd.xmin AND n.xmin=successor.xmin AND n.xmin=recv.xmin
 JOIN core.outbox o ON (o.partition_no,o.epoch,o.position)=(n.partition_no,n.epoch,n.position)
  AND o.event_seq=0 AND o.type='com.rezics.semantic.public-output.capture.v1' AND o.xmin=n.xmin
 JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position
  AND p.write_state='active' AND p.moved_to IS NULL
 WHERE (f.route,f.collection_id,f.generation)=(rte,cid,gen)
  AND c.state='active' AND c.visibility='public' AND c.builtin_kind IN ('everything','state')
  AND c.source_generation=f.source_generation AND b.incarnation=c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
  AND g.state='complete' AND g.expected_members=f.members AND g.written_members=f.members
  AND g.member_count=f.members AND g.member_fence=f.member_fence
  AND t.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
$$;

CREATE FUNCTION library.may_deidentify_frozen_output(rte integer, cid uuid, gen uuid)
RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
 SELECT EXISTS (
   SELECT 1
   FROM library.frozen_public_output_successor(rte,cid,gen) proof
   JOIN library.collection c ON c.route=rte AND c.collection_id=cid
   JOIN access.account a ON a.route=c.route AND a.account_id=c.curator_account_id
   WHERE a.state='deleted' AND a.authn_fenced
    AND NOT EXISTS (
      SELECT 1 FROM library.native_public_output_hold h
      WHERE h.route=rte AND h.collection_id=cid AND h.consumed_by IS NULL AND h.hold_id<>proof.hold_id
    )
 )
$$;

CREATE OR REPLACE FUNCTION library.guard_retained_public_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; step integer; retained boolean; frozen_generation uuid;
BEGIN
 FOR step IN 1..2 LOOP
  IF step=1 THEN
   IF TG_OP='INSERT' THEN CONTINUE; END IF;
   item:=OLD;
  ELSE
   IF TG_OP='DELETE' THEN CONTINUE; END IF;
   item:=NEW;
  END IF;
  PERFORM 1 FROM library.collection WHERE route=item.route AND collection_id=item.collection_id FOR UPDATE;
  PERFORM 1 FROM core.partition WHERE partition_no=item.route >> 4 FOR SHARE;
  IF TG_TABLE_NAME='collection' THEN
   IF TG_OP='UPDATE' AND (NEW.route,NEW.collection_id,NEW.created_at,NEW.curator_account_id)
     IS NOT DISTINCT FROM (OLD.route,OLD.collection_id,OLD.created_at,OLD.curator_account_id)
     AND NOT (OLD.state='deleted' AND NEW.state='active') THEN CONTINUE; END IF;
   IF TG_OP='UPDATE' AND NEW.curator_account_id IS NULL AND OLD.curator_account_id IS NOT NULL
     AND (to_jsonb(NEW)-'curator_account_id')=(to_jsonb(OLD)-'curator_account_id') THEN
     SELECT f.generation INTO frozen_generation FROM library.collection_retained_output f
     WHERE f.route=item.route AND f.collection_id=item.collection_id;
     IF library.may_deidentify_frozen_output(item.route,item.collection_id,frozen_generation) THEN CONTINUE; END IF;
   END IF;
   SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold
     WHERE route=item.route AND collection_id=item.collection_id AND consumed_by IS NULL LIMIT 1) INTO retained;
  ELSE
   IF TG_TABLE_NAME='collection_source_output' AND TG_OP='UPDATE' THEN
     IF NEW.account_id IS NULL AND OLD.account_id IS NOT NULL
       AND (to_jsonb(NEW)-'account_id')=(to_jsonb(OLD)-'account_id')
       AND library.may_deidentify_frozen_output(item.route,item.collection_id,item.generation)
     THEN CONTINUE; END IF;
   ELSIF TG_TABLE_NAME='collection_source_output_publication' AND TG_OP='DELETE' THEN
     IF library.may_deidentify_frozen_output(item.route,item.collection_id,item.generation) THEN CONTINUE; END IF;
   END IF;
   SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold
     WHERE route=item.route AND collection_id=item.collection_id AND output_generation=item.generation
       AND consumed_by IS NULL LIMIT 1) INTO retained;
  END IF;
  IF retained THEN RAISE EXCEPTION 'native_public_output_retained'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
