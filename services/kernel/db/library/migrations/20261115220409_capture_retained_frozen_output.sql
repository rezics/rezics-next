-- migrate:up
ALTER TABLE library.collection_retained_output
  ADD COLUMN activation_epoch integer,
  ADD COLUMN activation_position bigint,
  ADD CONSTRAINT collection_retained_output_activation CHECK (
    (activation_epoch IS NULL AND activation_position IS NULL)
    OR (activation_epoch IS NOT NULL AND activation_position IS NOT NULL AND activation_epoch>0 AND activation_position>0)
  );

-- Seal the actual activation coordinates before account History may minimize its original write basis.
CREATE OR REPLACE FUNCTION library.guard_retained_output_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE verified_epoch integer; verified_position bigint;
BEGIN
  PERFORM 1 FROM library.collection WHERE route=NEW.route AND collection_id=NEW.collection_id FOR UPDATE;
  SELECT b.epoch,b.position INTO verified_epoch,verified_position
  FROM library.collection_source_output_publication r
    JOIN library.collection_source_output_head h USING(route,collection_id,generation)
    JOIN library.collection_source_output g USING(route,collection_id,generation)
    JOIN library.collection s ON s.route=r.route AND s.collection_id=r.collection_id
    JOIN access.account a ON a.route=s.route AND a.account_id=s.curator_account_id
    JOIN library.native_source_fence f ON f.route=r.route AND f.kind='collection' AND f.owner_id=r.collection_id
    JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.epoch AND p.position>=b.position
    WHERE (r.route,r.collection_id,r.generation,r.transaction_id,r.native_xid,r.source_generation,r.expected_members,r.member_fence)=
      (NEW.route,NEW.collection_id,NEW.generation,NEW.transaction_id,NEW.native_xid,NEW.source_generation,NEW.members,NEW.member_fence)
      AND a.state='deleted' AND a.authn_fenced AND s.state='active' AND s.visibility='public'
      AND s.membership_kind='dynamic' AND s.source_generation=r.source_generation
      AND h.source_generation=r.source_generation AND g.source_generation+1=r.source_generation
      AND s.curator_account_id=r.account_id AND g.account_id=r.account_id
      AND r.incarnation=s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text
      AND f.generation=r.collection_fence AND g.state='complete'
      AND g.expected_members=r.expected_members AND g.written_members=r.expected_members
      AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
      AND r.xmin=b.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin
      AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
      AND b.principal_kind='account' AND b.position>0 AND p.write_state='active' AND p.moved_to IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Retained output requires terminal ownership and committed complete A' USING ERRCODE='23514';
  END IF;
  NEW.activation_epoch:=verified_epoch;
  NEW.activation_position:=verified_position;
  RETURN NEW;
END; $$;

-- Resolve the retained terminal publication to its original committed activation.
-- The retained row was validated by guard_retained_output_insert and both it and its raw generation are immutable.
CREATE FUNCTION library.frozen_public_output_origin(rte integer, cid uuid, gen uuid)
RETURNS TABLE(generation uuid, transaction_id uuid, activation_position bigint, native_xid text,
 source_generation bigint, member_fence bigint, members bigint, incarnation text, epoch integer, current_position bigint)
LANGUAGE sql STABLE STRICT AS $$
 SELECT f.generation,f.transaction_id,COALESCE(f.activation_position,w.position,held.activation_position),f.native_xid::text,
  f.source_generation,f.member_fence,f.members,
  c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text,p.epoch,p.position
 FROM library.collection_retained_output f
 JOIN library.collection c ON (c.route,c.collection_id)=(f.route,f.collection_id)
 JOIN library.collection_source_output g ON (g.route,g.collection_id,g.generation)=(f.route,f.collection_id,f.generation)
 JOIN library.collection_source_output_head h ON (h.route,h.collection_id,h.generation)=(f.route,f.collection_id,f.generation)
 LEFT JOIN editorial.write_basis w ON f.activation_position IS NULL
  AND w.partition_no=f.partition_no AND w.transaction_id=f.transaction_id
  AND w.xmin::text=f.native_xid::text AND w.principal_kind='account' AND w.position>0
 LEFT JOIN LATERAL (
   SELECT b.owner_epoch,b.activation_position,n.position AS accepted_position
   FROM library.native_public_output_binding b
   JOIN semantic.identity_public_output_accepted a ON (a.partition_no,a.capture_id)=(b.partition_no,b.capture_id)
    AND a.binding=b.payload AND a.binding_digest=b.binding_digest AND a.xmin=b.xmin
    AND (a.transaction_id,a.native_epoch,a.native_position)=(b.accepted_transaction_id,b.owner_epoch,b.accepted_position)
   JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
     (a.partition_no,a.transaction_id,a.native_epoch,a.native_position)
    AND n.purpose='identity-public-output-capture' AND n.xmin=a.xmin
   JOIN core.outbox o ON (o.partition_no,o.epoch,o.position)=(n.partition_no,n.epoch,n.position)
    AND o.event_seq=0 AND o.type='com.rezics.semantic.public-output.capture.v1' AND o.xmin=n.xmin
   WHERE f.activation_position IS NULL AND w.position IS NULL
    AND (b.partition_no,b.capture_id,b.route,b.collection_id,b.output_generation)=
        (f.partition_no,f.generation,f.route,f.collection_id,f.generation)
    AND (b.activation_transaction_id,b.activation_source_generation)=(f.transaction_id,f.source_generation)
    AND b.payload#>>'{tuple,publication,nativeXid}'=f.native_xid::text
    AND b.incarnation=c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
    AND b.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
 ) held ON true
 JOIN core.partition p ON p.partition_no=f.partition_no AND p.epoch=COALESCE(f.activation_epoch,w.epoch,held.owner_epoch)
  AND p.position>=COALESCE(held.accepted_position,f.activation_position,w.position)
  AND p.write_state='active' AND p.moved_to IS NULL
 WHERE (f.route,f.collection_id,f.generation)=(rte,cid,gen)
  AND c.state='active' AND c.visibility='public' AND c.membership_kind='dynamic'
  AND c.builtin_kind IN ('everything','state')
  AND c.source_generation=f.source_generation AND h.source_generation=f.source_generation
  AND g.source_generation+1=f.source_generation AND g.state='complete'
  AND g.member_count=f.members AND g.expected_members=f.members AND g.written_members=f.members
  AND g.member_fence=f.member_fence
  AND f.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
  AND f.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
  AND ((c.curator_account_id IS NULL AND g.account_id IS NULL)
   OR (c.curator_account_id=g.account_id AND EXISTS (
      SELECT 1 FROM access.account a WHERE (a.route,a.account_id)=(c.route,c.curator_account_id)
       AND a.state='deleted' AND a.authn_fenced
   )))
$$;

CREATE FUNCTION library.frozen_public_output_binding_committed(home integer, capture uuid)
RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
 SELECT EXISTS (
  SELECT 1 FROM library.native_public_output_binding b
  JOIN LATERAL library.frozen_public_output_origin(b.route,b.collection_id,b.output_generation) f ON true
  JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
    (b.partition_no,b.accepted_transaction_id,b.owner_epoch,b.accepted_position)
  JOIN core.partition p ON (p.partition_no,p.epoch,p.position)=(n.partition_no,n.epoch,n.position)
  JOIN core.outbox o ON (o.partition_no,o.position,o.epoch)=(n.partition_no,n.position,n.epoch) AND o.event_seq=0
  JOIN library.native_public_output_receiving e ON (e.partition_no,e.capture_id)=(b.partition_no,b.capture_id)
  JOIN library.native_public_output_hold k ON (k.partition_no,k.hold_id,k.capture_id)=(b.partition_no,b.hold_id,b.capture_id)
  WHERE b.partition_no=home AND b.capture_id=capture AND b.capture_id=b.output_generation
   AND b.native_xid=pg_current_xact_id() AND b.xmin=n.xmin AND n.xmin=o.xmin
   AND n.purpose='identity-public-output-capture' AND o.type='com.rezics.semantic.public-output.capture.v1'
   AND p.write_state='active' AND p.moved_to IS NULL
   AND f.incarnation=b.incarnation AND f.epoch=b.owner_epoch
   AND (f.transaction_id,f.activation_position,f.source_generation)=
       (b.activation_transaction_id,b.activation_position,b.activation_source_generation)
   AND k.native_xid=pg_current_xact_id() AND k.role='predecessor'
   AND k.consumed_by IS NULL AND e.state='open' AND e.receiving_epoch=b.receiving_epoch
   AND b.payload->>'captureId'=b.capture_id::text AND b.payload->>'holdId'=b.hold_id::text
   AND b.payload->>'definitionDigest'=b.definition_digest AND b.payload->>'bindingDigest'=b.binding_digest
   AND b.payload->'accepted'=jsonb_build_object('partition',b.partition_no,'epoch',b.owner_epoch,
     'position',b.accepted_position::text,'transactionId',b.accepted_transaction_id::text)
   AND b.payload->'tuple'->'identity'=jsonb_build_object('scope','public_output','route',b.route,
     'collectionId',b.collection_id::text,'incarnation',b.incarnation,'generation',f.source_generation::text,
     'ownerEpoch',b.owner_epoch,'receivingEpoch',b.receiving_epoch::text,'effectKey',b.effect_key,
     'outputGeneration',b.output_generation::text,'activation',jsonb_build_object(
       'transactionId',b.activation_transaction_id::text,'position',b.activation_position::text,
       'sourceGeneration',b.activation_source_generation::text))
   AND b.payload->'tuple'->'publication'=jsonb_build_object('generation',f.generation::text,
     'transactionId',f.transaction_id::text,'position',f.activation_position::text,'nativeXid',f.native_xid,
     'sourceGeneration',f.source_generation::text,'memberFence',f.member_fence::text,'members',f.members::text)
   AND b.payload->'tuple'->'observation'=jsonb_build_object('partition',b.partition_no,'epoch',b.owner_epoch,
     'position',(b.accepted_position-1)::text)
 )
$$;

CREATE OR REPLACE FUNCTION library.check_public_output_binding_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM library.native_public_output_binding b
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=b.partition_no
   AND n.transaction_id=b.accepted_transaction_id AND n.epoch=b.owner_epoch AND n.position=b.accepted_position
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position=n.position
  JOIN core.outbox o ON o.partition_no=n.partition_no AND o.position=n.position AND o.event_seq=0 AND o.epoch=n.epoch
  JOIN library.collection s ON s.route=b.route AND s.collection_id=b.collection_id
  JOIN library.collection_source_output_publication r ON r.route=b.route AND r.collection_id=b.collection_id
   AND r.generation=b.output_generation
  JOIN editorial.write_basis w ON w.partition_no=r.partition_no AND w.transaction_id=r.transaction_id
  JOIN library.collection_source_output g ON g.route=r.route AND g.collection_id=r.collection_id AND g.generation=r.generation
  JOIN library.collection_source_output_head h ON h.route=g.route AND h.collection_id=g.collection_id AND h.generation=g.generation
  JOIN library.native_source_fence f ON f.route=s.route AND f.kind='collection' AND f.owner_id=s.collection_id
  JOIN access.account a ON a.route=s.route AND a.account_id=s.curator_account_id
  JOIN library.native_public_output_receiving e ON e.partition_no=b.partition_no AND e.capture_id=b.capture_id
  JOIN library.native_public_output_hold k ON k.partition_no=b.partition_no AND k.hold_id=b.hold_id
  WHERE b.partition_no=NEW.partition_no AND b.capture_id=NEW.capture_id
   AND b.native_xid=pg_current_xact_id() AND b.xmin=n.xmin AND n.xmin=o.xmin
   AND n.purpose='identity-public-output-capture' AND p.write_state='active' AND p.moved_to IS NULL
   AND s.state='active' AND s.visibility<>'private' AND s.membership_kind='dynamic'
   AND a.state='active' AND NOT a.authn_fenced AND s.curator_account_id=r.account_id AND g.account_id=r.account_id
   AND b.incarnation=r.incarnation AND r.incarnation=s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text
   AND r.transaction_id=b.activation_transaction_id AND w.position=b.activation_position
   AND w.epoch=b.owner_epoch AND w.principal_kind='account' AND r.xmin=w.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin
   AND r.native_xid<>pg_current_xact_id() AND r.source_generation=b.activation_source_generation
   AND s.source_generation=r.source_generation AND h.source_generation=r.source_generation
   AND g.source_generation+1=r.source_generation AND g.state='complete' AND g.expected_members=r.expected_members
   AND g.written_members=r.expected_members AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
   AND f.generation=r.collection_fence AND k.native_xid=pg_current_xact_id() AND k.role='predecessor'
   AND k.consumed_by IS NULL AND e.state='open' AND e.receiving_epoch=b.receiving_epoch
   AND b.payload->>'captureId'=b.capture_id::text AND b.payload->>'holdId'=b.hold_id::text
   AND b.payload->>'definitionDigest'=b.definition_digest AND b.payload->>'bindingDigest'=b.binding_digest
   AND b.payload->'accepted'=jsonb_build_object('partition',b.partition_no,'epoch',b.owner_epoch,
     'position',b.accepted_position::text,'transactionId',b.accepted_transaction_id::text)
   AND b.payload->'tuple'->'identity'=jsonb_build_object('scope','public_output','route',b.route,
     'collectionId',b.collection_id::text,'incarnation',b.incarnation,'generation',r.source_generation::text,
     'ownerEpoch',b.owner_epoch,'receivingEpoch',b.receiving_epoch::text,'effectKey',b.effect_key,
     'outputGeneration',b.output_generation::text,'activation',jsonb_build_object(
       'transactionId',b.activation_transaction_id::text,'position',b.activation_position::text,
       'sourceGeneration',b.activation_source_generation::text))
   AND b.payload->'tuple'->'publication'=jsonb_build_object('generation',r.generation::text,
     'transactionId',r.transaction_id::text,'position',w.position::text,'nativeXid',r.native_xid::text,
     'sourceGeneration',r.source_generation::text,'memberFence',r.member_fence::text,'members',r.expected_members::text)
   AND b.payload->'tuple'->'observation'=jsonb_build_object('partition',b.partition_no,'epoch',b.owner_epoch,
     'position',(b.accepted_position-1)::text)
 ) AND NOT library.frozen_public_output_binding_committed(NEW.partition_no,NEW.capture_id)
 THEN RAISE EXCEPTION 'native_public_output_binding_requires_semantic_same_command_capture'; END IF;
 RETURN NULL;
END; $$;
