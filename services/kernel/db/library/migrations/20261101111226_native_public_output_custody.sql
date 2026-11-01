-- migrate:up
-- These are publication custody records, not canonical Subject captures.
CREATE TABLE library.native_public_output_binding (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535), collection_id uuid NOT NULL,
 partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
 capture_id uuid NOT NULL, hold_id uuid NOT NULL,
 incarnation text NOT NULL CHECK(octet_length(incarnation) BETWEEN 1 AND 128),
 output_generation uuid NOT NULL, activation_transaction_id uuid NOT NULL,
 activation_position bigint NOT NULL CHECK(activation_position>0),
 activation_source_generation bigint NOT NULL CHECK(activation_source_generation>0),
 owner_epoch integer NOT NULL, accepted_position bigint NOT NULL CHECK(accepted_position>0),
 accepted_transaction_id uuid NOT NULL, native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 receiving_epoch bigint NOT NULL CHECK(receiving_epoch=1), effect_key text NOT NULL CHECK(length(effect_key)=64),
 definition_digest text NOT NULL CHECK(definition_digest ~ '^[0-9a-f]{64}$'),
 binding_digest text NOT NULL CHECK(binding_digest ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=4096),
 PRIMARY KEY(partition_no,capture_id), UNIQUE(partition_no,hold_id),
 UNIQUE(route,collection_id,effect_key),
 CHECK(route=get_byte(uuid_send(collection_id),10)*256+get_byte(uuid_send(collection_id),11)),
 FOREIGN KEY(partition_no,accepted_transaction_id,owner_epoch,accepted_position)
  REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position)
  DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE library.native_public_output_receiving (
 partition_no integer NOT NULL, capture_id uuid NOT NULL,
 receiving_epoch bigint NOT NULL CHECK(receiving_epoch>0),
 state text NOT NULL CHECK(state IN ('open','applied','cancelled')), transaction_id uuid,
 PRIMARY KEY(partition_no,capture_id),
 FOREIGN KEY(partition_no,capture_id) REFERENCES library.native_public_output_binding(partition_no,capture_id)
);
CREATE TABLE library.native_public_output_hold (
 partition_no integer NOT NULL, capture_id uuid NOT NULL, hold_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('predecessor','successor')),
 route integer NOT NULL, collection_id uuid NOT NULL, incarnation text NOT NULL,
 output_generation uuid NOT NULL, activation_transaction_id uuid NOT NULL,
 activation_position bigint NOT NULL, activation_source_generation bigint NOT NULL,
 transaction_id uuid NOT NULL, native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), consumed_by uuid,
 PRIMARY KEY(partition_no,hold_id), UNIQUE(partition_no,capture_id,role),
 FOREIGN KEY(partition_no,capture_id) REFERENCES library.native_public_output_binding(partition_no,capture_id)
);
-- LIMIT 1 visits a live key, rather than walking consumed history. Both predecessor and successor use it.
CREATE INDEX native_public_output_retained ON library.native_public_output_hold
 (route,collection_id,output_generation,incarnation,activation_transaction_id,activation_position,activation_source_generation)
 WHERE consumed_by IS NULL;
CREATE TABLE library.native_public_output_transition (
 partition_no integer NOT NULL, capture_id uuid NOT NULL, hold_id uuid NOT NULL,
 binding_digest text NOT NULL, kind text NOT NULL CHECK(kind IN ('applied','cancelled')),
 successor_hold_id uuid, cancellation_epoch bigint,
 epoch integer NOT NULL, position bigint NOT NULL CHECK(position>0), transaction_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('identity-public-output-applied','identity-public-output-cancelled')),
 native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=8192),
 PRIMARY KEY(partition_no,hold_id),
 FOREIGN KEY(partition_no,capture_id) REFERENCES library.native_public_output_binding(partition_no,capture_id),
 FOREIGN KEY(partition_no,hold_id) REFERENCES library.native_public_output_hold(partition_no,hold_id),
 FOREIGN KEY(partition_no,successor_hold_id) REFERENCES library.native_public_output_hold(partition_no,hold_id)
  DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(partition_no,transaction_id,epoch,position)
  REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position)
  DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='applied' AND successor_hold_id IS NOT NULL AND successor_hold_id<>hold_id
         AND cancellation_epoch IS NULL AND purpose='identity-public-output-applied')
    OR (kind='cancelled' AND successor_hold_id IS NULL AND cancellation_epoch>1
         AND purpose='identity-public-output-cancelled'))
);
CREATE UNIQUE INDEX native_public_output_successor ON library.native_public_output_transition(partition_no,successor_hold_id)
 WHERE successor_hold_id IS NOT NULL;
ALTER TABLE library.native_public_output_hold ADD CONSTRAINT native_public_output_consumption
 FOREIGN KEY(partition_no,consumed_by) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
 DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER native_public_output_binding_immutable BEFORE UPDATE OR DELETE ON library.native_public_output_binding
 FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();
CREATE TRIGGER native_public_output_transition_immutable BEFORE UPDATE OR DELETE ON library.native_public_output_transition
 FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();

CREATE FUNCTION library.check_public_output_binding_commit() RETURNS trigger LANGUAGE plpgsql AS $$
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
 ) THEN RAISE EXCEPTION 'native_public_output_binding_requires_semantic_same_command_capture'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER native_public_output_binding_commit AFTER INSERT ON library.native_public_output_binding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_binding_commit();

CREATE FUNCTION library.guard_public_output_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native_public_output_hold_immutable'; END IF;
 IF TG_OP='UPDATE' AND (
   (to_jsonb(NEW)-'consumed_by') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_by')
   OR OLD.consumed_by IS NOT NULL OR NEW.consumed_by IS NULL OR OLD.role='successor'
 ) THEN RAISE EXCEPTION 'native_public_output_hold_immutable'; END IF;
 IF TG_OP='INSERT' AND (NEW.consumed_by IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM library.native_public_output_binding b WHERE b.partition_no=NEW.partition_no AND b.capture_id=NEW.capture_id
   AND (b.route,b.collection_id,b.incarnation,b.output_generation,b.activation_transaction_id,b.activation_position,b.activation_source_generation)
     =(NEW.route,NEW.collection_id,NEW.incarnation,NEW.output_generation,NEW.activation_transaction_id,NEW.activation_position,NEW.activation_source_generation)
   AND ((NEW.role='predecessor' AND NEW.hold_id=b.hold_id AND NEW.transaction_id=b.accepted_transaction_id)
     OR (NEW.role='successor' AND NEW.hold_id<>b.hold_id))
 )) THEN RAISE EXCEPTION 'native_public_output_hold_binding'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER native_public_output_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON library.native_public_output_hold
 FOR EACH ROW EXECUTE FUNCTION library.guard_public_output_hold();

CREATE FUNCTION library.guard_public_output_receiving() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native_public_output_receiving_immutable'; END IF;
 IF TG_OP='UPDATE' AND (
  (NEW.partition_no,NEW.capture_id) IS DISTINCT FROM (OLD.partition_no,OLD.capture_id)
  OR OLD.state<>'open' OR NEW.state='open' OR NEW.receiving_epoch<>OLD.receiving_epoch+1 OR NEW.transaction_id IS NULL
 ) THEN RAISE EXCEPTION 'native_public_output_receiving_fenced'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER native_public_output_receiving_guard BEFORE UPDATE OR DELETE ON library.native_public_output_receiving
 FOR EACH ROW EXECUTE FUNCTION library.guard_public_output_receiving();

CREATE FUNCTION library.check_public_output_transition_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_partition integer; selected_capture uuid;
BEGIN
 selected_partition:=NEW.partition_no; selected_capture:=NEW.capture_id;
 IF NOT EXISTS (
  SELECT 1 FROM library.native_public_output_binding b
  JOIN library.native_public_output_transition t ON t.partition_no=b.partition_no AND t.hold_id=b.hold_id
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=t.partition_no AND n.transaction_id=t.transaction_id
   AND n.epoch=t.epoch AND n.position=t.position AND n.purpose=t.purpose
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position=n.position
  JOIN core.outbox o ON o.partition_no=n.partition_no AND o.position=n.position AND o.event_seq=0 AND o.epoch=n.epoch
  JOIN library.native_public_output_hold h ON h.partition_no=t.partition_no AND h.hold_id=t.hold_id
  JOIN library.native_public_output_receiving e ON e.partition_no=b.partition_no AND e.capture_id=b.capture_id
  LEFT JOIN library.native_public_output_hold k ON k.partition_no=t.partition_no AND k.hold_id=t.successor_hold_id
  WHERE b.partition_no=selected_partition AND b.capture_id=selected_capture AND t.binding_digest=b.binding_digest
   AND n.xmin=t.xmin AND n.xmin=o.xmin AND t.native_xid=pg_current_xact_id()
   AND p.write_state='active' AND p.moved_to IS NULL AND n.epoch=b.owner_epoch
   AND h.role='predecessor' AND h.consumed_by=t.transaction_id
   AND e.state=t.kind AND e.receiving_epoch=b.receiving_epoch+1 AND e.transaction_id=t.transaction_id
   AND ((t.kind='cancelled' AND t.cancellation_epoch=e.receiving_epoch)
     OR (t.kind='applied' AND k.role='successor' AND k.capture_id=b.capture_id AND k.consumed_by IS NULL
       AND k.transaction_id=t.transaction_id AND k.native_xid=t.native_xid AND k.xmin=t.xmin))
 ) THEN RAISE EXCEPTION 'native_public_output_transition_requires_same_command_disposition'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER native_public_output_transition_commit AFTER INSERT ON library.native_public_output_transition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_transition_commit();
CREATE CONSTRAINT TRIGGER native_public_output_hold_consumed AFTER UPDATE ON library.native_public_output_hold
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_transition_commit();
CREATE CONSTRAINT TRIGGER native_public_output_receiving_closed AFTER UPDATE ON library.native_public_output_receiving
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_transition_commit();
-- A standalone successor insert also needs the real atomic transfer, rather than a new unresolved orphan.
CREATE FUNCTION library.check_public_output_successor_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role='successor' THEN
  PERFORM library.check_public_output_successor(NEW.partition_no,NEW.hold_id);
 END IF;
 RETURN NULL;
END; $$;
CREATE FUNCTION library.check_public_output_successor(p integer,h uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM library.native_public_output_transition t
   JOIN library.native_public_output_hold k ON k.partition_no=t.partition_no AND k.hold_id=t.successor_hold_id
   WHERE k.partition_no=p AND k.hold_id=h AND t.kind='applied' AND t.native_xid=pg_current_xact_id()
    AND k.native_xid=t.native_xid AND k.xmin=t.xmin)
 THEN RAISE EXCEPTION 'native_public_output_successor_requires_transfer'; END IF;
END; $$;
CREATE CONSTRAINT TRIGGER native_public_output_successor_commit AFTER INSERT ON library.native_public_output_hold
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_successor_commit();

-- Lock the original owner BEFORE the live-prefix lookup. Native admission takes the same owner lock.
-- Ordinary eligibility changes and switching the selected head need not destroy the retained rows.
CREATE FUNCTION library.guard_retained_public_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; step integer; retained boolean;
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
  -- Every real admission advances this Core row. An older REPEATABLE READ writer therefore
  -- serializes or fails rather than overlooking a hold inserted after its snapshot began.
  PERFORM 1 FROM core.partition WHERE partition_no=item.route >> 4 FOR SHARE;
  IF TG_TABLE_NAME='collection' THEN
   IF TG_OP='UPDATE' AND (NEW.route,NEW.collection_id,NEW.created_at,NEW.curator_account_id)
     IS NOT DISTINCT FROM (OLD.route,OLD.collection_id,OLD.created_at,OLD.curator_account_id)
     AND NOT (OLD.state='deleted' AND NEW.state='active') THEN CONTINUE; END IF;
   SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold
     WHERE route=item.route AND collection_id=item.collection_id AND consumed_by IS NULL LIMIT 1) INTO retained;
  ELSE
   SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold
     WHERE route=item.route AND collection_id=item.collection_id AND output_generation=item.generation
       AND consumed_by IS NULL LIMIT 1) INTO retained;
  END IF;
  IF retained THEN RAISE EXCEPTION 'native_public_output_retained'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER native_public_output_collection_guard BEFORE INSERT OR UPDATE OR DELETE ON library.collection
 FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();
CREATE TRIGGER native_public_output_header_guard BEFORE INSERT OR UPDATE OR DELETE ON library.collection_source_output
 FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();
CREATE TRIGGER native_public_output_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON library.collection_source_output_publication
 FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();
CREATE TRIGGER native_public_output_member_guard BEFORE INSERT OR UPDATE OR DELETE ON library.collection_source_output_member
 FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();

-- migrate:down
-- Forward only: unresolved native publication and successor custody must survive rollouts.
