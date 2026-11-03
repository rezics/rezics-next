--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: library; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA library;


--
-- Name: advance_export_collection_fence(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.advance_export_collection_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item record; owner uuid; step integer;
BEGIN
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    IF TG_TABLE_NAME='collection' THEN owner := item.curator_account_id;
    ELSE
      SELECT curator_account_id INTO owner FROM library.collection
        WHERE route=item.route AND collection_id=item.collection_id;
    END IF;
    IF owner IS NOT NULL THEN
      INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
        VALUES(item.route,'account',owner,1,owner)
      ON CONFLICT (route,kind,owner_id) DO UPDATE
        SET generation=library.native_source_fence.generation+1;
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;


--
-- Name: advance_fact_source_head(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.advance_fact_source_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO library.fact_source_head AS head (route, account_id, generation)
      VALUES (OLD.route, OLD.account_id, 1)
      ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
  ELSE
    INSERT INTO library.fact_source_head AS head (route, account_id, generation)
      VALUES (NEW.route, NEW.account_id, 1)
      ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
    IF TG_OP = 'UPDATE' THEN
      IF (OLD.route, OLD.account_id) IS DISTINCT FROM (NEW.route, NEW.account_id) THEN
        INSERT INTO library.fact_source_head AS head (route, account_id, generation)
          VALUES (OLD.route, OLD.account_id, 1)
          ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
      END IF;
    END IF;
  END IF;
  -- Native bigint overflow aborts the fact mutation and its metadata atomically.
  RETURN NULL;
END;
$$;


--
-- Name: advance_live_label_assignment_delete_source_head(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.advance_live_label_assignment_delete_source_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM library.personal_label
    WHERE route = OLD.route AND account_id = OLD.account_id AND label_id = OLD.label_id
      AND deleted_at IS NULL
  ) THEN
    INSERT INTO library.fact_source_head AS head (route, account_id, generation)
      VALUES (OLD.route, OLD.account_id, 1)
      ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: advance_native_source_fence(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.advance_native_source_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item record; step integer; owner uuid; attributed uuid; r integer; k text;
BEGIN
  -- Both old and new anchors are fenced. Only native key columns enter control metadata.
  -- Conservatively fence even a no-op UPDATE, without converting business payload to JSON.
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    r := item.route;
    attributed := NULL;
    IF TG_TABLE_NAME IN ('collection','collection_member') THEN
      k := 'collection'; owner := item.collection_id;
      IF TG_TABLE_NAME='collection' THEN
        attributed := item.curator_account_id;
      END IF;
    ELSIF TG_TABLE_NAME IN ('progress_unit','progress_change') THEN
      k := 'account';
      SELECT account_id INTO owner FROM library.progress_session
        WHERE route=r AND session_id=item.session_id;
      -- Parent deletion already fences the account, including cascading child deletion.
    ELSE
      k := 'account'; owner := item.account_id;
    END IF;
    IF k='account' THEN attributed := owner; END IF;
    IF owner IS NOT NULL THEN
      INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id) VALUES(r,k,owner,1,attributed)
      ON CONFLICT (route,kind,owner_id) DO UPDATE
        SET generation=library.native_source_fence.generation+1,
            account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id);
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;


--
-- Name: check_output_publication_commit(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_output_publication_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_source_output_publication r
    JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.epoch AND p.position>=b.position
    JOIN library.collection_source_output g USING(route,collection_id,generation)
    JOIN library.collection_source_output_head h USING(route,collection_id,generation)
    JOIN library.collection s ON s.route=r.route AND s.collection_id=r.collection_id
    JOIN library.native_source_fence f ON f.route=r.route AND f.kind='collection' AND f.owner_id=r.collection_id
    WHERE r.route=NEW.route AND r.collection_id=NEW.collection_id AND r.generation=NEW.generation
      AND r.native_xid=pg_current_xact_id() AND r.xmin=b.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin
      AND b.principal_kind='account' AND b.position>0 AND p.write_state='active' AND p.moved_to IS NULL
      AND s.curator_account_id=r.account_id AND g.account_id=r.account_id AND s.state='active' AND s.visibility<>'private'
      AND r.incarnation=s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text
      AND s.source_generation=r.source_generation AND h.source_generation=r.source_generation
      AND g.source_generation+1=r.source_generation AND g.state='complete'
      AND g.expected_members=r.expected_members AND g.written_members=r.expected_members
      AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
      AND f.generation=r.collection_fence
  ) THEN RAISE EXCEPTION 'collection_output_publication_uncommitted'; END IF;
  RETURN NULL;
END; $$;


--
-- Name: check_public_output_binding_commit(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_public_output_binding_commit() RETURNS trigger
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
 ) THEN RAISE EXCEPTION 'native_public_output_binding_requires_semantic_same_command_capture'; END IF;
 RETURN NULL;
END; $$;


--
-- Name: check_public_output_semantic_binding(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_public_output_semantic_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_accepted a
  JOIN library.native_public_output_binding b USING(partition_no,capture_id)
  WHERE a.partition_no=NEW.partition_no AND a.capture_id=NEW.capture_id
   AND a.hold_id=b.hold_id AND a.binding_digest=b.binding_digest AND a.definition_digest=b.definition_digest
   AND a.binding=b.payload AND a.transaction_id=b.accepted_transaction_id
   AND a.native_epoch=b.owner_epoch AND a.native_position=b.accepted_position
   AND a.xmin=b.xmin AND b.native_xid=pg_current_xact_id())
 THEN RAISE EXCEPTION 'native_public_output_requires_same_command_semantic_acceptance'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_public_output_semantic_disposition(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_public_output_semantic_disposition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_stage s
  JOIN semantic.identity_public_output_disposition d USING(partition_no,capture_id,hold_id,binding_digest,kind,native_epoch,native_position,transaction_id)
  JOIN semantic.identity_public_output_transition t USING(partition_no,capture_id,kind,native_epoch,native_position,transaction_id)
  WHERE s.partition_no=NEW.partition_no AND s.capture_id=NEW.capture_id AND s.hold_id=NEW.hold_id
   AND s.binding_digest=NEW.binding_digest AND s.kind=NEW.kind AND s.purpose=NEW.purpose
   AND (s.native_epoch,s.native_position,s.transaction_id)=(NEW.epoch,NEW.position,NEW.transaction_id)
   AND s.native_xid=NEW.native_xid AND s.native_xid=pg_current_xact_id() AND s.xmin=d.xmin AND s.xmin=t.xmin
   AND s.successor_hold_id IS NOT DISTINCT FROM NEW.successor_hold_id
   AND s.cancellation_epoch IS NOT DISTINCT FROM NEW.cancellation_epoch
   AND t.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id)
 THEN RAISE EXCEPTION 'native_public_output_requires_same_command_semantic_disposition'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_public_output_successor(integer, uuid); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_public_output_successor(p integer, h uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM library.native_public_output_transition t
   JOIN library.native_public_output_hold k ON k.partition_no=t.partition_no AND k.hold_id=t.successor_hold_id
   WHERE k.partition_no=p AND k.hold_id=h AND t.kind='applied' AND t.native_xid=pg_current_xact_id()
    AND k.native_xid=t.native_xid AND k.xmin=t.xmin)
 THEN RAISE EXCEPTION 'native_public_output_successor_requires_transfer'; END IF;
END; $$;


--
-- Name: check_public_output_successor_commit(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_public_output_successor_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.role='successor' THEN
  PERFORM library.check_public_output_successor(NEW.partition_no,NEW.hold_id);
 END IF;
 RETURN NULL;
END; $$;


--
-- Name: check_public_output_transition_commit(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_public_output_transition_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: check_publication_episode_commit(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.check_publication_episode_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_publication_operation o
    JOIN library.collection_publication_source s
      ON (s.route,s.source_id,s.publication_id,s.transaction_id)=(o.route,o.source_id,o.publication_id,o.transaction_id)
    JOIN library.collection_publication_episode e
      ON (e.route,e.publication_id,e.source_id,e.collection_id,e.owner_account_id)=
         (o.route,o.publication_id,o.source_id,o.collection_id,o.owner_account_id)
    JOIN core.receipt r ON r.partition_no=(o.route >> 4) AND r.principal_kind='account' AND r.principal_id=o.owner_account_id
      AND r.command_kind='library.collection.publication.begin' AND r.idempotency_key=o.creation_storage_key
    JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    JOIN library.collection c ON (c.route,c.collection_id)=(o.route,o.collection_id)
    JOIN library.collection_source_output g ON g.route=o.route AND g.collection_id=o.collection_id
      AND g.generation=(s.bytes::jsonb->'output'->>'generation')::uuid
    WHERE o.route=NEW.route AND o.publication_id=NEW.publication_id
      AND o.native_xid=pg_current_xact_id() AND o.xmin=s.xmin AND o.xmin=e.xmin AND o.xmin=r.xmin AND o.xmin=b.xmin AND o.xmin=g.xmin
      AND r.transaction_id=o.transaction_id AND r.payload_state='present' AND r.position=b.position AND r.epoch=b.epoch
      AND encode(r.request_digest,'hex')=o.record->'creation'->>'requestDigest'
      AND r.response->>'durableInitiator'=o.commitment
      AND o.record->>'recordedTransactionId'=o.transaction_id::text AND o.record->>'sourceDigest'=o.source_digest
      AND o.record->'operation'=jsonb_build_object('route',o.route,'id',o.publication_id,'kind','library.collection.publication.begin','sourceId',o.source_id)
      AND o.record->>'initiatorAccountId'=o.owner_account_id::text
      AND o.record->'actor'->>'accountId'=o.owner_account_id::text
      AND o.record->'creation'->>'commandKind'='library.collection.publication.begin'
      AND o.record->'creation'->'target'=jsonb_build_object('route',o.route,'id',o.collection_id)
      AND b.principal_kind='account' AND b.principal_id=o.owner_account_id AND b.position>0
      AND b.client_id=o.record->'actor'->>'clientId' AND b.requested_by IS NOT DISTINCT FROM (o.record->'actor'->>'requestedBy')
      AND c.curator_account_id=o.owner_account_id AND c.state='active' AND c.membership_kind='dynamic'
      AND g.account_id=o.owner_account_id AND g.state='building' AND g.expected_members IS NULL
      AND g.source_generation=c.source_generation AND e.phase='staging'
      AND s.bytes::jsonb->'locator'=jsonb_build_object('route',o.route,'ownerAccountId',o.owner_account_id,'collectionId',o.collection_id,'publicationId',o.publication_id)
      AND s.bytes::jsonb->'target'=jsonb_build_object('kind','collection_output','route',o.route,'collectionId',o.collection_id,'visibility',s.bytes::jsonb->'target'->>'visibility')
      AND s.bytes::jsonb->'target'->>'visibility' IN ('public','unlisted')
      AND s.bytes::jsonb->'input'->>'kind'='private_working_source'
      AND s.bytes::jsonb->'input'->'identity'->>'scope'='private_builtin'
      AND (s.bytes::jsonb->'rule'->>'collectionRevision')::integer=c.revision
      AND (s.bytes::jsonb->'rule'->>'sourceGeneration')::bigint=c.source_generation
  ) THEN RAISE EXCEPTION 'collection_publication_uncommitted'; END IF;
  RETURN NULL;
END; $$;


--
-- Name: collection_kind_original_cancel(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.collection_kind_original_cancel() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.invalidated
     OR NEW.enrollment_generation IS DISTINCT FROM OLD.enrollment_generation
     OR NEW.restore_generation IS DISTINCT FROM OLD.restore_generation THEN
    UPDATE library.collection_kind_audience_origin SET cancelled=true
    WHERE route=OLD.route AND origin_id=OLD.origin_id
      AND owner_account_id=OLD.owner_account_id AND collection_id=OLD.collection_id
      AND preparation_id=OLD.preparation_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: collection_kind_original_immutable(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.collection_kind_original_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW)-'cancelled') IS DISTINCT FROM (to_jsonb(OLD)-'cancelled')
     OR (OLD.cancelled AND NOT NEW.cancelled) THEN
    RAISE EXCEPTION 'Collection Kind original association is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: collection_kind_raw_input_commit(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.collection_kind_raw_input_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE value jsonb := NEW.body::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_kind_audience_origin original
    JOIN library.collection_kind_observation observation
      ON (observation.route,observation.collection_id,observation.audience)=
         (original.route,original.collection_id,original.audience)
    JOIN library.collection_kind_consent_consumer consumer
      ON (consumer.route,consumer.reference_id)=(original.route,value->'enrollment'->>'reference')
    JOIN library.collection collection
      ON (collection.route,collection.collection_id,collection.curator_account_id)=
         (original.route,original.collection_id,original.owner_account_id)
    WHERE original.route=NEW.route AND original.origin_id=NEW.origin_id
      AND original.preparation_id=NEW.preparation_id AND NOT original.cancelled
      AND original.expires_at>clock_timestamp()
      AND original.deadline_at>extract(epoch FROM clock_timestamp())*1000
      AND observation.generation=NEW.preparation_id AND observation.version=NEW.observation_version
      AND observation.capture=original.source_capture AND NOT observation.complete
      AND collection.state='active' AND collection.presentation_kind IS NULL
      AND collection.source_generation=original.source_generation
      AND consumer.origin_id=NEW.origin_id AND consumer.preparation_id=NEW.preparation_id
      AND NOT consumer.invalidated AND consumer.source_generation=original.source_generation
      AND consumer.source_capture=original.source_capture
      AND consumer.enrollment_generation::text=value->'enrollment'->>'generation'
      AND consumer.restore_generation::text=value->'enrollment'->>'restore'
      AND consumer.catalogue_root=value->'enrollment'->>'catalogue'
      AND original.original_digest=value->'original'->>'digest'
      AND original.formula_digest=value->'original'->>'formula'
      AND original.audience=value->'original'->>'audience'
      AND original.origin_id=value->'original'->>'id'
      AND original.source_capture=value->'source'->>'capture'
      AND NEW.preparation_id::text=value->'preparation'->>'id'
      AND NEW.observation_version::text=value->'preparation'->>'version'
      AND NEW.predecessor IS NOT DISTINCT FROM value->'preparation'->>'predecessor'
  ) THEN RAISE EXCEPTION 'Collection Kind raw input commit is stale' USING ERRCODE='40001'; END IF;
  RETURN NULL;
END;
$$;


--
-- Name: collection_kind_raw_input_immutable(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.collection_kind_raw_input_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Collection Kind raw input is immutable';
END;
$$;


--
-- Name: collection_listing_public_history_guard(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.collection_listing_public_history_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.collection_id::text, NEW.route::bigint));
    IF EXISTS (
      SELECT 1
      FROM library.collection_listing_history
      WHERE route = NEW.route AND collection_id = NEW.collection_id
    ) THEN
      RAISE EXCEPTION 'Collection identity has public history'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'collection_listing_history_pkey';
    END IF;
    NEW.listing_ever_public := NEW.state = 'active' AND NEW.visibility = 'public';
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.route, NEW.collection_id) IS DISTINCT FROM (OLD.route, OLD.collection_id) THEN
      RAISE EXCEPTION 'Collection source identity is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'collection_source_identity_immutable';
    END IF;
    NEW.listing_ever_public := OLD.listing_ever_public
      OR (OLD.state = 'active' AND OLD.visibility = 'public')
      OR (NEW.state = 'active' AND NEW.visibility = 'public');
    RETURN NEW;
  ELSE
    IF OLD.listing_ever_public OR (OLD.state = 'active' AND OLD.visibility = 'public') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(OLD.collection_id::text, OLD.route::bigint));
      INSERT INTO library.collection_listing_history (route, collection_id, ever_public)
      VALUES (OLD.route, OLD.collection_id, true)
      ON CONFLICT (route, collection_id) DO NOTHING;
    END IF;
    RETURN OLD;
  END IF;
END;
$$;


--
-- Name: consumption_statistics_apply(integer, uuid, uuid, integer, integer, integer); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.consumption_statistics_apply(r integer, a uuid, s uuid, retained_delta integer, completed_delta integer, unknown_delta integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE before_completed bigint; after_completed bigint; remaining bigint;
BEGIN
  INSERT INTO library.consumption_statistics_owner
    VALUES (r, a, 0, 0, 0, 0, gen_random_uuid())
    ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;

  SELECT completed_occurrences INTO before_completed
    FROM library.consumption_statistics_subject
    WHERE route=r AND account_id=a AND subject_id=s FOR UPDATE;
  IF NOT FOUND THEN
    before_completed := 0;
    INSERT INTO library.consumption_statistics_subject
      VALUES (r, a, s, retained_delta, completed_delta)
      RETURNING completed_occurrences, retained_sessions INTO after_completed, remaining;
  ELSE
    UPDATE library.consumption_statistics_subject
      SET retained_sessions=retained_sessions+retained_delta,
          completed_occurrences=completed_occurrences+completed_delta
      WHERE route=r AND account_id=a AND subject_id=s
      RETURNING completed_occurrences, retained_sessions INTO after_completed, remaining;
  END IF;

  UPDATE library.consumption_statistics_owner
    SET retained_sessions=retained_sessions+retained_delta,
        completed_occurrences=completed_occurrences+completed_delta,
        completed_subjects=completed_subjects+(after_completed>0)::integer-(before_completed>0)::integer,
        unknown_profile_completed=unknown_profile_completed+unknown_delta
    WHERE route=r AND account_id=a;
  IF remaining=0 THEN
    DELETE FROM library.consumption_statistics_subject WHERE route=r AND account_id=a AND subject_id=s;
  END IF;
  -- The existing session erasure participant removes the last header too. No second
  -- account-deletion participant, job or retained owner tombstone is introduced.
  DELETE FROM library.consumption_statistics_owner
    WHERE route=r AND account_id=a AND retained_sessions=0;
END $$;


--
-- Name: consumption_statistics_receive(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.consumption_statistics_receive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- One source row remains one occurrence regardless of retries, scalar corrections,
  -- sparse units, clear, publication or a change in the accepted profile vocabulary.
  IF TG_OP <> 'INSERT' THEN
    PERFORM library.consumption_statistics_apply(OLD.route, OLD.account_id, OLD.subject_id,
      -1, -(OLD.state='completed')::integer,
      -((OLD.state='completed') AND OLD.library_profile_pin IS NULL)::integer);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM library.consumption_statistics_apply(NEW.route, NEW.account_id, NEW.subject_id,
      1, (NEW.state='completed')::integer,
      ((NEW.state='completed') AND NEW.library_profile_pin IS NULL)::integer);
  END IF;
  RETURN NULL;
END $$;


--
-- Name: consumption_statistics_truncate(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.consumption_statistics_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  TRUNCATE library.consumption_statistics_subject, library.consumption_statistics_owner;
  RETURN NULL;
END $$;


--
-- Name: fence_profile_migration_writer(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.fence_profile_migration_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  phase text;
BEGIN
  -- Retained copies are outside the live pin migration. Their exact Undo must
  -- pass the live writer fence when it clears deletion_id.
  IF TG_TABLE_NAME = 'copy' THEN
    IF NEW.deletion_id IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO library.fact_source_head (route, account_id, generation)
    VALUES (NEW.route, NEW.account_id, 1)
    ON CONFLICT (route, account_id) DO NOTHING;
  SELECT profile_migration_phase INTO phase FROM library.fact_source_head
    WHERE route = NEW.route AND account_id = NEW.account_id FOR UPDATE;
  IF phase = 'legacy' AND NEW.library_profile_pin IS NOT NULL AND NOT (
    EXISTS (SELECT 1 FROM library.entry
      WHERE route = NEW.route AND account_id = NEW.account_id AND library_profile_pin IS NULL LIMIT 1) OR
    EXISTS (SELECT 1 FROM library.progress_session
      WHERE route = NEW.route AND account_id = NEW.account_id AND library_profile_pin IS NULL LIMIT 1) OR
    EXISTS (SELECT 1 FROM library.copy
      WHERE route = NEW.route AND account_id = NEW.account_id
        AND library_profile_pin IS NULL LIMIT 1) OR
    EXISTS (SELECT 1 FROM library.entry_deleted
      WHERE route = NEW.route AND account_id = NEW.account_id AND library_profile_pin IS NULL LIMIT 1)
  ) THEN
    UPDATE library.fact_source_head SET profile_migration_phase = 'ready'
      WHERE route = NEW.route AND account_id = NEW.account_id;
    phase := 'ready';
  END IF;
  IF NEW.library_profile_pin IS NULL AND phase <> 'legacy' THEN
    IF phase = 'ready' OR TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Library owner no longer admits unpinned facts' USING ERRCODE = '23514';
    END IF;
    IF OLD.library_profile_pin IS NOT NULL OR (OLD.route, OLD.account_id) IS DISTINCT FROM (NEW.route, NEW.account_id) THEN
      RAISE EXCEPTION 'Library migration cannot admit a new unpinned fact' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'entry' THEN
      IF OLD.subject_id IS DISTINCT FROM NEW.subject_id THEN
        RAISE EXCEPTION 'Library migration requires a stable unpinned entry key' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'progress_session' THEN
      IF OLD.session_id IS DISTINCT FROM NEW.session_id THEN
        RAISE EXCEPTION 'Library migration requires a stable unpinned session key' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'copy' THEN
      IF OLD.deletion_id IS NOT NULL OR OLD.copy_id IS DISTINCT FROM NEW.copy_id THEN
        RAISE EXCEPTION 'Library migration cannot admit a new unpinned fact' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fence_selected_output(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.fence_selected_output() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item record; step integer; attributed uuid;
BEGIN
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    IF TG_TABLE_NAME='collection_source_output' AND NOT EXISTS (
      SELECT 1 FROM library.collection_source_output_head h
      WHERE h.route=item.route AND h.collection_id=item.collection_id AND h.generation=item.generation
    ) THEN CONTINUE; END IF;
    SELECT curator_account_id INTO attributed FROM library.collection
      WHERE route=item.route AND collection_id=item.collection_id;
    INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
    VALUES(item.route,'collection',item.collection_id,1,attributed)
    ON CONFLICT(route,kind,owner_id) DO UPDATE
      SET generation=library.native_source_fence.generation+1,
          account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id);
  END LOOP;
  RETURN NULL;
END; $$;


--
-- Name: guard_collection_membership_kind(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_collection_membership_kind() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.membership_kind IS DISTINCT FROM OLD.membership_kind THEN
    RAISE EXCEPTION 'Collection membership kind cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_collection_order_capture(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_collection_order_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.route,NEW.collection_id,NEW.repair_id,NEW.admitted_count,NEW.original_minimum,NEW.lower_key,NEW.upper_key,
      NEW.admitted_revision,NEW.admitted_source_generation,NEW.admitted_order_epoch)
     IS DISTINCT FROM
     (OLD.route,OLD.collection_id,OLD.repair_id,OLD.admitted_count,OLD.original_minimum,OLD.lower_key,OLD.upper_key,
      OLD.admitted_revision,OLD.admitted_source_generation,OLD.admitted_order_epoch)
     OR NEW.processed < OLD.processed OR NEW.step < OLD.step
     OR (OLD.state <> 'active' AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'Collection order capture is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_collection_order_member(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_collection_order_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  owner_route integer;
  owner_id uuid;
  curator uuid;
  parent_state text;
  repair library.collection_order_repair%ROWTYPE;
  terminal boolean;
BEGIN
  IF TG_OP='INSERT' THEN owner_route:=NEW.route; owner_id:=NEW.collection_id;
  ELSE owner_route:=OLD.route; owner_id:=OLD.collection_id; END IF;
  SELECT curator_account_id,state INTO curator,parent_state FROM library.collection
    WHERE route=owner_route AND collection_id=owner_id FOR UPDATE;
  SELECT * INTO repair FROM library.collection_order_repair
    WHERE route=owner_route AND collection_id=owner_id AND state='active';
  IF FOUND THEN
    SELECT state <> 'active' OR authn_fenced INTO terminal FROM access.account
      WHERE route=get_byte(uuid_send(curator),10)*256+get_byte(uuid_send(curator),11) AND account_id=curator;
    IF parent_state <> 'active' OR curator IS NULL OR COALESCE(terminal,true) THEN
      UPDATE library.collection_order_repair SET state='cancelled' WHERE route=owner_route AND collection_id=owner_id;
    ELSIF repair.writer_xid IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Collection order repair in progress' USING ERRCODE='40001';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


--
-- Name: guard_collection_order_parent(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_collection_order_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  repair library.collection_order_repair%ROWTYPE;
  terminal boolean;
BEGIN
  SELECT * INTO repair FROM library.collection_order_repair
    WHERE route=OLD.route AND collection_id=OLD.collection_id AND state='active';
  IF FOUND THEN
    SELECT state <> 'active' OR authn_fenced INTO terminal FROM access.account
      WHERE route=get_byte(uuid_send(OLD.curator_account_id),10)*256+get_byte(uuid_send(OLD.curator_account_id),11)
        AND account_id=OLD.curator_account_id;
    IF TG_OP='DELETE' THEN
      UPDATE library.collection_order_repair SET state='cancelled' WHERE route=OLD.route AND collection_id=OLD.collection_id;
    ELSIF NEW.state <> 'active' OR NEW.curator_account_id IS DISTINCT FROM OLD.curator_account_id OR COALESCE(terminal,true) THEN
      UPDATE library.collection_order_repair SET state='cancelled' WHERE route=OLD.route AND collection_id=OLD.collection_id;
    ELSIF (NEW.member_count,NEW.revision,NEW.source_generation,NEW.order_epoch)
       IS DISTINCT FROM (OLD.member_count,OLD.revision,OLD.source_generation,OLD.order_epoch)
       AND (repair.writer_xid IS DISTINCT FROM pg_current_xact_id()
         OR NEW.member_count <> repair.admitted_count
         OR (NEW.revision,NEW.source_generation,NEW.order_epoch) IS DISTINCT FROM
            (repair.expected_revision,repair.expected_source_generation,repair.expected_order_epoch)) THEN
      RAISE EXCEPTION 'Collection order repair in progress' USING ERRCODE='40001';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


--
-- Name: guard_follow_target_type(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_follow_target_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type THEN
    RAISE EXCEPTION 'Follow target type cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_frozen_output(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_frozen_output() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item record;
BEGIN
  IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD; END IF;
  PERFORM 1 FROM library.collection WHERE route=item.route AND collection_id=item.collection_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM library.collection_retained_output r
    WHERE r.route=item.route AND r.collection_id=item.collection_id AND (TG_TABLE_NAME='collection_source_output_head' OR r.generation=item.generation)) THEN
    -- Only the terminal disposer may remove the private account attribution on the frozen header.
    IF TG_TABLE_NAME='collection_source_output' AND TG_OP='UPDATE' THEN
      IF NEW.account_id IS NULL AND OLD.account_id IS NOT NULL
        AND (to_jsonb(NEW)-'account_id')=(to_jsonb(OLD)-'account_id')
        AND EXISTS(SELECT 1 FROM access.account a WHERE a.route=OLD.route
          AND a.account_id=OLD.account_id AND a.state='deleted' AND a.authn_fenced)
      THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Frozen Collection output is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;


--
-- Name: guard_identity_scope_evidence(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_identity_scope_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Native identity Source evidence remains retained until real control handoff';
END; $$;


--
-- Name: guard_listing_order(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_listing_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.collection_route IS DISTINCT FROM OLD.collection_route
    OR NEW.source_partition IS DISTINCT FROM OLD.source_partition THEN
    RAISE EXCEPTION 'Listing source binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.source_epoch, NEW.source_position) < (OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Listing source stamp regressed' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'subject_collection_version' THEN
    IF NEW.route IS DISTINCT FROM OLD.route OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR ((NEW.source_epoch, NEW.source_position) = (OLD.source_epoch, OLD.source_position)
        AND NEW.multiplicity IS DISTINCT FROM OLD.multiplicity) THEN
      RAISE EXCEPTION 'Listing identity or equal-stamp payload changed' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.partition_no IS DISTINCT FROM OLD.partition_no OR (OLD.terminal AND NOT NEW.terminal) THEN
      RAISE EXCEPTION 'Listing fence identity or terminal state changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_live_copy_listing(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_live_copy_listing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.route,NEW.subject_id,NEW.collection_id,NEW.collection_route)
    IS DISTINCT FROM (OLD.route,OLD.subject_id,OLD.collection_id,OLD.collection_route) THEN
  RAISE EXCEPTION 'Live listing identity is immutable' USING ERRCODE='23514';
 END IF;
 -- Negative cleanup may advance an EXISTING exclusion cut, but cannot insert a
 -- new personal identity or make a relationship positive. Delayed apply still
 -- goes through the immutable gate and monotone version CAS.
 IF TG_TABLE_NAME='subject_collection_version' AND TG_OP='UPDATE' AND NEW.multiplicity=0
   AND NEW.source_partition=OLD.source_partition
   AND (NEW.source_epoch,NEW.source_position)>=(OLD.source_epoch,OLD.source_position) THEN
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM access.live_copy_gate g
   WHERE g.route=NEW.route AND g.applying_transaction=pg_current_xact_id() AND g.outcome='applying'
     AND g.module='library.subject-listing' AND NOT g.retired
     AND g.payload->>'subjectId'=NEW.subject_id::text AND g.payload->>'collectionId'=NEW.collection_id::text
     AND (g.payload->>'collectionRoute')::integer=NEW.collection_route
     AND (g.payload->>'multiplicity')::integer=NEW.multiplicity
     AND (g.payload->'stamp'->>'partition')::integer=NEW.source_partition
     AND (g.payload->'stamp'->>'epoch')::integer=NEW.source_epoch
     AND (g.payload->'stamp'->>'position')::bigint=NEW.source_position) THEN
  RAISE EXCEPTION 'Listing write requires native live receiving gate' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_native_source_receipt(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_native_source_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'native_source_receipt_immutable';
END; $$;


--
-- Name: guard_public_output_hold(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_public_output_hold() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_public_output_receiving(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_public_output_receiving() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native_public_output_receiving_immutable'; END IF;
 IF TG_OP='UPDATE' AND (
  (NEW.partition_no,NEW.capture_id) IS DISTINCT FROM (OLD.partition_no,OLD.capture_id)
  OR OLD.state<>'open' OR NEW.state='open' OR NEW.receiving_epoch<>OLD.receiving_epoch+1 OR NEW.transaction_id IS NULL
 ) THEN RAISE EXCEPTION 'native_public_output_receiving_fenced'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_retained_collection(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_retained_collection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.curator_account_id IS NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Deidentified public contribution is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_retained_collection_member(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_retained_collection_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_route integer;
  parent_id uuid;
  curator uuid;
BEGIN
  IF TG_OP='DELETE' THEN parent_route:=OLD.route; parent_id:=OLD.collection_id;
  ELSE parent_route:=NEW.route; parent_id:=NEW.collection_id; END IF;
  SELECT curator_account_id INTO curator FROM library.collection
    WHERE route=parent_route AND collection_id=parent_id FOR SHARE;
  IF FOUND AND curator IS NULL THEN
    RAISE EXCEPTION 'Deidentified public contribution is immutable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


--
-- Name: guard_retained_output_insert(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_retained_output_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM 1 FROM library.collection WHERE route=NEW.route AND collection_id=NEW.collection_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_source_output_publication r
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
      AND b.principal_kind='account' AND b.position>0 AND p.write_state='active' AND p.moved_to IS NULL
  ) THEN RAISE EXCEPTION 'Retained output requires terminal ownership and committed complete A' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;


--
-- Name: guard_retained_public_output(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_retained_public_output() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_shelf_type_reservation_input(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_shelf_type_reservation_input() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.input_bytes IS NOT NULL AND NEW.input_bytes IS DISTINCT FROM convert_to(NEW.full_type, 'UTF8') THEN
      RAISE EXCEPTION 'Shelf reservation bytes must equal the accepted input';
    END IF;
  ELSIF (NEW.full_type, NEW.input_bytes, NEW.digest, NEW.fence_id, NEW.generation_id)
      IS DISTINCT FROM (OLD.full_type, OLD.input_bytes, OLD.digest, OLD.fence_id, OLD.generation_id) THEN
    RAISE EXCEPTION 'Shelf reservation input is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_type_preparation_header(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_type_preparation_header() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Type preparation headers are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: initialize_follow_count_owner(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.initialize_follow_count_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO library.follow_count_owner(route,account_id,bootstrap_complete,bootstrap_started)
    VALUES(NEW.route,NEW.account_id,true,true) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;


--
-- Name: initialize_follow_count_total(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.initialize_follow_count_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE kind text; identity uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'semantic' THEN kind := 'subject'; identity := NEW.subject_id;
  ELSIF TG_TABLE_SCHEMA = 'community' THEN kind := 'space'; identity := NEW.space_id;
  ELSE kind := 'collection'; identity := NEW.collection_id;
  END IF;
  INSERT INTO library.follow_count_total(route,target_type,target_id) VALUES(NEW.route,kind,identity)
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;


--
-- Name: initialize_owner_activity(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.initialize_owner_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT a.activity_at,a.activity_unknown INTO NEW.activity_at,NEW.activity_unknown
    FROM library.owner_original_activity(NEW.route,NEW.account_id,NEW.subject_id) a;
  RETURN NEW;
END;
$$;


--
-- Name: install_follow_count_partition(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.install_follow_count_partition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE current_node integer; added integer;
BEGIN
  INSERT INTO library.follow_count_partition(partition_no) VALUES(NEW.partition_no)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added > 0 THEN
    current_node := 273 + NEW.partition_no;
    LOOP
      UPDATE library.follow_count_health SET members=members+1,ready=false,sampled_at=NULL WHERE node=current_node;
      EXIT WHEN current_node=0;
      current_node := (current_node-1)/16;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: library_profile_pin_valid(jsonb); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.library_profile_pin_valid(pin jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
  SELECT CASE
    WHEN jsonb_typeof(pin) IS DISTINCT FROM 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(pin)) <> 4 THEN false
    WHEN NOT (pin ?& ARRAY['provenance', 'releaseDigest', 'acceptingType', 'profileId']) THEN false
    WHEN jsonb_typeof(pin -> 'provenance') IS DISTINCT FROM 'string' THEN false
    WHEN jsonb_typeof(pin -> 'releaseDigest') IS DISTINCT FROM 'string' THEN false
    WHEN pin ->> 'releaseDigest' !~ '^sha256:[0-9a-f]{64}$' THEN false
    WHEN pin ->> 'provenance' = 'profile' THEN
      jsonb_typeof(pin -> 'acceptingType') = 'string' AND pin ->> 'acceptingType' <> '' AND
      jsonb_typeof(pin -> 'profileId') = 'string' AND pin ->> 'profileId' <> ''
    WHEN pin ->> 'provenance' = 'legacy' THEN
      jsonb_typeof(pin -> 'profileId') = 'string' AND pin ->> 'profileId' = 'legacy-fixed-v1' AND
      (jsonb_typeof(pin -> 'acceptingType') = 'null' OR
        (jsonb_typeof(pin -> 'acceptingType') = 'string' AND pin ->> 'acceptingType' <> ''))
    ELSE false
  END
$_$;


--
-- Name: maintain_owner_activity(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.maintain_owner_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    PERFORM library.refresh_owner_activity(OLD.route,OLD.account_id,OLD.subject_id);
  END IF;
  IF TG_OP<>'DELETE' THEN
    PERFORM library.refresh_owner_activity(NEW.route,NEW.account_id,NEW.subject_id);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: maintain_owner_member_scope(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.maintain_owner_member_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE f text; p jsonb;
BEGIN
  f := CASE TG_TABLE_NAME WHEN 'entry' THEN 'entry' WHEN 'entry_personal_fact' THEN 'entry'
    WHEN 'entry_source_observation' THEN 'entry' WHEN 'progress_session' THEN 'session'
    WHEN 'copy' THEN 'copy' WHEN 'label_assignment' THEN 'label' END;
  IF TG_OP <> 'INSERT' THEN
    p := CASE WHEN f='label' THEN '{}'::jsonb ELSE COALESCE(to_jsonb(OLD)->'library_profile_pin','{}'::jsonb) END;
    IF p='null'::jsonb THEN p:='{}'::jsonb; END IF;
    PERFORM library.refresh_owner_member_scope(OLD.route,OLD.account_id,OLD.subject_id,f,p);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    p := CASE WHEN f='label' THEN '{}'::jsonb ELSE COALESCE(to_jsonb(NEW)->'library_profile_pin','{}'::jsonb) END;
    IF p='null'::jsonb THEN p:='{}'::jsonb; END IF;
    PERFORM library.refresh_owner_member_scope(NEW.route,NEW.account_id,NEW.subject_id,f,p);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: minimize_collection_rule(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.minimize_collection_rule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.curator_account_id IS NULL THEN
    NEW.rule_filter := NULL;
    NEW.rule_sort := NULL;
    NEW.rule_release_digest := NULL;
    NEW.rule_revision := 0;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: owner_original_activity(integer, uuid, uuid); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.owner_original_activity(r integer, a uuid, s uuid) RETURNS TABLE(activity_at timestamp with time zone, activity_unknown boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT GREATEST(
    (SELECT e.activity_at FROM library.entry e WHERE e.route=r AND e.account_id=a AND e.subject_id=s),
    (SELECT h.last_changed_at FROM library.progress_head h WHERE h.route=r AND h.account_id=a AND h.subject_id=s)
  ), EXISTS(SELECT 1 FROM library.entry e WHERE e.route=r AND e.account_id=a AND e.subject_id=s
      AND e.activity_at IS NULL)
    OR (EXISTS(SELECT 1 FROM library.progress_session p WHERE p.route=r AND p.account_id=a AND p.subject_id=s)
      AND NOT EXISTS(SELECT 1 FROM library.progress_head h WHERE h.route=r AND h.account_id=a AND h.subject_id=s
        AND h.last_changed_at IS NOT NULL));
$$;


--
-- Name: publication_immutable(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.publication_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'collection_publication_immutable'; END; $$;


--
-- Name: queue_owner_label_repair(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.queue_owner_label_repair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.deleted_at IS NULL) = (NEW.deleted_at IS NULL) THEN RETURN NULL; END IF;
  INSERT INTO library.owner_index_label_repair(route,account_id,label_id)
    VALUES(OLD.route,OLD.account_id,OLD.label_id)
    ON CONFLICT(route,account_id,label_id) DO UPDATE SET after_subject=NULL;
  RETURN NULL;
END;
$$;


--
-- Name: record_follow_count_source(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.record_follow_count_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  edge library.follow;
  live boolean;
  previous_live boolean;
  eligible boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.route, OLD.account_id, OLD.target_type, OLD.target_id)
       IS DISTINCT FROM (NEW.route, NEW.account_id, NEW.target_type, NEW.target_id) THEN
      RAISE EXCEPTION 'Follow original identity and owner route cannot change' USING ERRCODE = '23514';
    END IF;
    IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN edge := OLD; ELSE edge := NEW; END IF;
  live := TG_OP <> 'DELETE' AND edge.state = 'following';

  -- The native command already holds shareAccount. This is only a keyed data read,
  -- never Access authorization or a write in an account transition transaction.
  SELECT live AND a.state = 'active' AND NOT a.authn_fenced INTO eligible
    FROM access.account a WHERE a.route = edge.route AND a.account_id = edge.account_id;

  -- Owner-local mutex also arbitrates future bounded bootstrap. Absence is incomplete,
  -- so a first touch of a legacy live row adds its CURRENT state, not an unknown delta.
  INSERT INTO library.follow_count_owner AS owner (route, account_id)
    VALUES (edge.route, edge.account_id)
    ON CONFLICT (route, account_id) DO UPDATE
      SET observed_live_count = owner.observed_live_count;
  SELECT s.source_following INTO previous_live FROM library.follow_count_source s
    WHERE s.route = edge.route AND s.account_id = edge.account_id
      AND s.target_type = edge.target_type AND s.target_id = edge.target_id
    FOR UPDATE;

  INSERT INTO library.follow_count_source AS source
    (route, account_id, target_type, target_id, revision, source_following, desired_eligible, pending_since)
    VALUES (edge.route, edge.account_id, edge.target_type, edge.target_id, 1,
            live, COALESCE(eligible, false), statement_timestamp())
    ON CONFLICT (route, account_id, target_type, target_id) DO UPDATE
      SET revision = source.revision + 1,
          source_following = EXCLUDED.source_following,
          desired_eligible = EXCLUDED.desired_eligible,
          pending_since = LEAST(source.pending_since, EXCLUDED.pending_since);

  IF live IS DISTINCT FROM COALESCE(previous_live, false) THEN
    UPDATE library.follow_count_owner
      SET observed_live_count = observed_live_count + CASE WHEN live THEN 1 ELSE -1 END
      WHERE route = edge.route AND account_id = edge.account_id;
  END IF;
  -- Native bigint overflow aborts the entire source statement and command transaction.
  RETURN NULL;
END;
$$;


--
-- Name: refresh_owner_activity(integer, uuid, uuid); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.refresh_owner_activity(r integer, a uuid, s uuid) RETURNS void
    LANGUAGE sql
    AS $$
  UPDATE library.owner_member_index i SET activity_at=v.activity_at,activity_unknown=v.activity_unknown
    FROM library.owner_original_activity(r,a,s) v
    WHERE i.route=r AND i.account_id=a AND i.subject_id=s
      AND (i.activity_at,i.activity_unknown) IS DISTINCT FROM (v.activity_at,v.activity_unknown);
$$;


--
-- Name: refresh_owner_member_scope(integer, uuid, uuid, text, jsonb); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.refresh_owner_member_scope(r integer, a uuid, s uuid, f text, p jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE live boolean;
BEGIN
  PERFORM 1 FROM library.fact_source_head WHERE route=r AND account_id=a FOR UPDATE;
  IF f='entry' THEN
    SELECT EXISTS (SELECT 1 FROM library.entry WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) OR
      (p='{}'::jsonb AND EXISTS (SELECT 1 FROM library.entry_personal_fact x WHERE x.route=r AND x.account_id=a
        AND x.subject_id=s AND (x.note IS NOT NULL OR x.priority IS NOT NULL OR EXISTS (
          SELECT 1 FROM library.entry_source_observation o WHERE o.route=x.route AND o.account_id=x.account_id
            AND o.subject_id=x.subject_id)))) INTO live;
  ELSIF f='session' THEN
    SELECT EXISTS (SELECT 1 FROM library.progress_session WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='copy' THEN
    SELECT EXISTS (SELECT 1 FROM library.copy WHERE route=r AND account_id=a AND subject_id=s
      AND deletion_id IS NULL AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='label' THEN
    SELECT EXISTS (SELECT 1 FROM library.label_assignment x WHERE x.route=r AND x.account_id=a AND x.subject_id=s
      AND x.deleted_at IS NULL AND (x.slot_no IS NULL OR x.assignment_id IS NULL)) OR
    EXISTS (SELECT 1 FROM library.label_assignment x WHERE x.route=r AND x.account_id=a AND x.subject_id=s
      AND x.deleted_at IS NULL AND x.slot_no IS NOT NULL AND x.assignment_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM library.personal_label l WHERE l.route=r AND l.account_id=a AND l.label_id=x.label_id
          AND l.deleted_at IS NULL)) INTO live;
  ELSE RAISE EXCEPTION 'Unknown owner member family'; END IF;
  IF live THEN
    INSERT INTO library.owner_member_support VALUES(r,a,s,f,p) ON CONFLICT DO NOTHING;
    INSERT INTO library.owner_member_index VALUES(r,a,s) ON CONFLICT DO NOTHING;
    INSERT INTO library.owner_index_pin(route,account_id,pin) VALUES(r,a,p) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s AND family=f AND pin=p;
    DELETE FROM library.owner_index_pin WHERE route=r AND account_id=a AND pin=p AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND pin=p);
    DELETE FROM library.owner_member_index WHERE route=r AND account_id=a AND subject_id=s AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s);
  END IF;
END;
$$;


--
-- Name: reported_finish_valid(integer, integer, integer); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.reported_finish_valid(y integer, m integer, d integer) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT COALESCE(y BETWEEN 1 AND 9999
    AND (m IS NULL OR m BETWEEN 1 AND 12)
    AND (d IS NULL OR (m IS NOT NULL AND d BETWEEN 1 AND CASE
      WHEN m=2 THEN CASE WHEN y%400=0 OR (y%4=0 AND y%100<>0) THEN 29 ELSE 28 END
      WHEN m IN (4,6,9,11) THEN 30 ELSE 31 END)), false)
$$;


--
-- Name: reported_year_apply(integer, uuid, uuid, integer, smallint, integer, integer, integer, integer); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.reported_year_apply(r integer, a uuid, s uuid, y integer, b smallint, delta integer, unknown_delta integer, month_delta integer, day_delta integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE previous bigint; following bigint; subject_delta integer;
BEGIN
  SELECT completed INTO previous FROM library.reported_year_subject
    WHERE route=r AND account_id=a AND year=y AND bucket=b AND subject_id=s;
  previous := COALESCE(previous,0);
  following := previous+delta;
  subject_delta := (following>0)::integer-(previous>0)::integer;
  IF following=0 THEN
    DELETE FROM library.reported_year_subject
      WHERE route=r AND account_id=a AND year=y AND bucket=b AND subject_id=s;
  ELSE
    INSERT INTO library.reported_year_subject VALUES(r,a,y,b,s,following)
      ON CONFLICT(route,account_id,year,bucket,subject_id) DO UPDATE SET completed=EXCLUDED.completed;
  END IF;
  IF delta=-1 AND EXISTS(SELECT 1 FROM library.reported_year_bucket
      WHERE route=r AND account_id=a AND year=y AND bucket=b AND completed=1) THEN
    DELETE FROM library.reported_year_bucket WHERE route=r AND account_id=a AND year=y AND bucket=b;
  ELSE
    UPDATE library.reported_year_bucket SET
      completed=completed+delta, subjects=subjects+subject_delta,
      unknown_profile=unknown_profile+unknown_delta,
      month_precision=month_precision+month_delta, day_precision=day_precision+day_delta
      WHERE route=r AND account_id=a AND year=y AND bucket=b;
    IF NOT FOUND THEN
      INSERT INTO library.reported_year_bucket VALUES(r,a,y,b,delta,subject_delta,unknown_delta,month_delta,day_delta);
    END IF;
  END IF;
END $$;


--
-- Name: reported_year_receive(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.reported_year_receive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item library.progress_session; delta integer; valid boolean; b smallint;
BEGIN
  IF TG_OP='UPDATE' AND OLD.reported_year_initialized AND
    (OLD.route,OLD.account_id,OLD.subject_id,OLD.state,OLD.library_profile_pin,
      OLD.journal_finish_year,OLD.journal_finish_month,OLD.journal_finish_day)
    IS NOT DISTINCT FROM
    (NEW.route,NEW.account_id,NEW.subject_id,NEW.state,NEW.library_profile_pin,
      NEW.journal_finish_year,NEW.journal_finish_month,NEW.journal_finish_day) THEN
    NEW.reported_year_initialized := true;
    RETURN NEW;
  END IF;
  -- Lock both potential owners in stable order (ordinary commands never move owners).
  IF TG_OP='UPDATE' THEN
    PERFORM 1 FROM library.reported_year_owner
      WHERE (route,account_id) IN ((OLD.route,OLD.account_id),(NEW.route,NEW.account_id))
      ORDER BY route,account_id FOR UPDATE;
  END IF;
  FOR delta IN -1..1 BY 2 LOOP
    IF delta=-1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
      IF NOT item.reported_year_initialized THEN CONTINUE; END IF;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    INSERT INTO library.reported_year_owner VALUES(item.route,item.account_id,0,0,0,gen_random_uuid())
      ON CONFLICT(route,account_id) DO UPDATE SET revision=EXCLUDED.revision;
    valid := library.reported_finish_valid(item.journal_finish_year,item.journal_finish_month,item.journal_finish_day);
    UPDATE library.reported_year_owner SET
      initialized_sessions=initialized_sessions+delta,
      missing_finish=missing_finish+delta*(item.state='completed' AND item.journal_finish_year IS NULL
        AND item.journal_finish_month IS NULL AND item.journal_finish_day IS NULL)::integer,
      unsupported_finish=unsupported_finish+delta*(item.state='completed' AND NOT valid AND NOT
        (item.journal_finish_year IS NULL AND item.journal_finish_month IS NULL AND item.journal_finish_day IS NULL))::integer
      WHERE route=item.route AND account_id=item.account_id;
    IF item.state='completed' AND valid THEN
      FOREACH b IN ARRAY ARRAY[0,COALESCE(item.journal_finish_month,13)]::smallint[] LOOP
        PERFORM library.reported_year_apply(item.route,item.account_id,item.subject_id,item.journal_finish_year,b,delta,
          delta*(item.library_profile_pin IS NULL)::integer,
          delta*(item.journal_finish_month IS NOT NULL AND item.journal_finish_day IS NULL)::integer,
          delta*(item.journal_finish_day IS NOT NULL)::integer);
      END LOOP;
    END IF;
  END LOOP;
  -- No owner tombstone or new deletion participant; native source deletion pays cleanup.
  IF TG_OP<>'INSERT' THEN
    DELETE FROM library.reported_year_owner WHERE route=OLD.route AND account_id=OLD.account_id AND initialized_sessions=0;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  NEW.reported_year_initialized := true;
  RETURN NEW;
END $$;


--
-- Name: reported_year_truncate(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.reported_year_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  TRUNCATE library.reported_year_subject,library.reported_year_bucket,library.reported_year_owner;
  RETURN NULL;
END $$;


--
-- Name: track_output_members(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.track_output_members() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE library.collection_source_output SET member_count=member_count-1,member_fence=member_fence+1
    WHERE route=OLD.route AND collection_id=OLD.collection_id AND generation=OLD.generation;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE library.collection_source_output SET member_count=member_count+1,member_fence=member_fence+1
    WHERE route=NEW.route AND collection_id=NEW.collection_id AND generation=NEW.generation;
  END IF;
  RETURN NULL;
END; $$;


--
-- Name: track_publication_staging_evidence(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.track_publication_staging_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE library.collection_publication_staging SET evidence_count=evidence_count-1,evidence_fence=evidence_fence+1
    WHERE route=OLD.route AND collection_id=OLD.collection_id AND generation=OLD.generation;
  END IF;
  IF TG_OP<>'DELETE' THEN
    UPDATE library.collection_publication_staging SET evidence_count=evidence_count+1,evidence_fence=evidence_fence+1
    WHERE route=NEW.route AND collection_id=NEW.collection_id AND generation=NEW.generation;
  END IF;
  RETURN NULL;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bangumi_upload; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bangumi_upload (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    cancelled boolean DEFAULT false NOT NULL,
    CONSTRAINT bangumi_upload_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: bangumi_upload_row; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bangumi_upload_row (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    ordinal integer NOT NULL,
    evidence jsonb NOT NULL,
    review jsonb,
    choice jsonb,
    outcome jsonb,
    CONSTRAINT bangumi_upload_row_evidence_check CHECK ((octet_length((evidence)::text) <= 32768)),
    CONSTRAINT bangumi_upload_row_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 99)))
);


--
-- Name: builtin_collection_reference; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.builtin_collection_reference (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    profile_id text NOT NULL,
    state_set_id text NOT NULL,
    state_id text NOT NULL,
    CONSTRAINT builtin_collection_reference_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT builtin_collection_reference_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT builtin_collection_reference_profile_id_check CHECK ((((octet_length(profile_id) >= 1) AND (octet_length(profile_id) <= 64)) AND ((profile_id COLLATE "C") ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'::text))),
    CONSTRAINT builtin_collection_reference_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT builtin_collection_reference_state_id_check CHECK ((((octet_length(state_id) >= 1) AND (octet_length(state_id) <= 64)) AND ((state_id COLLATE "C") ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'::text))),
    CONSTRAINT builtin_collection_reference_state_set_id_check CHECK ((((octet_length(state_set_id) >= 1) AND (octet_length(state_set_id) <= 64)) AND ((state_set_id COLLATE "C") ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'::text)))
);


--
-- Name: builtin_state_reference_source; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.builtin_state_reference_source (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    source_revision integer NOT NULL,
    source_transaction_id uuid NOT NULL,
    release_digest text NOT NULL,
    CONSTRAINT builtin_state_reference_source_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT builtin_state_reference_source_release_digest_check CHECK (((octet_length(release_digest) = 71) AND ((release_digest COLLATE "C") ~ '\Asha256:[0-9a-f]{64}\Z'::text))),
    CONSTRAINT builtin_state_reference_source_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT builtin_state_reference_source_source_revision_check CHECK ((source_revision >= 1))
);


--
-- Name: bulk_effect; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bulk_effect (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    target_anchor_id uuid NOT NULL,
    account_id uuid NOT NULL,
    source_route integer NOT NULL,
    source_id uuid NOT NULL,
    source_digest text NOT NULL,
    target jsonb NOT NULL,
    receipt jsonb NOT NULL,
    command_kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    transaction_id uuid NOT NULL,
    outcome text NOT NULL,
    reason text,
    resulting_member_id uuid,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT bulk_effect_check CHECK ((route = ((get_byte(uuid_send(target_anchor_id), 10) * 256) + get_byte(uuid_send(target_anchor_id), 11)))),
    CONSTRAINT bulk_effect_check1 CHECK ((source_route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT bulk_effect_command_kind_check CHECK (((char_length(command_kind) >= 1) AND (char_length(command_kind) <= 255))),
    CONSTRAINT bulk_effect_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255))),
    CONSTRAINT bulk_effect_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT bulk_effect_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'no_effect'::text, 'conflict'::text, 'denied'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT bulk_effect_reason_check CHECK ((reason = ANY (ARRAY['revision_mismatch'::text, 'incarnation_mismatch'::text, 'missing_target'::text, 'authority_lost'::text, 'target_denied'::text, 'collection_full'::text, 'invalid_subject'::text, 'dependency_unavailable'::text, 'deadline'::text, 'cancel_requested'::text, 'evidence_missing'::text, 'execution_expired'::text]))),
    CONSTRAINT bulk_effect_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text)),
    CONSTRAINT bulk_effect_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_effect_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT bulk_effect_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_effect_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535))),
    CONSTRAINT bulk_effect_target_check CHECK ((jsonb_typeof(target) = 'object'::text))
);


--
-- Name: bulk_operation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bulk_operation (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    request jsonb NOT NULL,
    initiator jsonb NOT NULL,
    creation_receipt jsonb NOT NULL,
    source_digest text NOT NULL,
    target_count integer NOT NULL,
    phase text NOT NULL,
    admitted_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    results_expire_at timestamp with time zone NOT NULL,
    CONSTRAINT bulk_operation_check CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT bulk_operation_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT bulk_operation_check2 CHECK (((admitted_at < expires_at) AND (expires_at < results_expire_at))),
    CONSTRAINT bulk_operation_creation_receipt_check CHECK ((jsonb_typeof(creation_receipt) = 'object'::text)),
    CONSTRAINT bulk_operation_initiator_check CHECK (((jsonb_typeof(initiator) = 'object'::text) AND (octet_length((initiator)::text) <= 262144))),
    CONSTRAINT bulk_operation_phase_check CHECK ((phase = ANY (ARRAY['preview'::text, 'applying'::text, 'completed'::text]))),
    CONSTRAINT bulk_operation_request_check CHECK (((jsonb_typeof(request) = 'object'::text) AND (octet_length((request)::text) <= 262144))),
    CONSTRAINT bulk_operation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT bulk_operation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_operation_target_count_check CHECK (((target_count >= 0) AND (target_count <= 1000)))
);


--
-- Name: bulk_target; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bulk_target (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    target_kind text NOT NULL,
    collection_id uuid,
    member_id uuid,
    target jsonb NOT NULL,
    source_digest text NOT NULL,
    receipt jsonb NOT NULL,
    created_transaction_id uuid NOT NULL,
    state text NOT NULL,
    reason text,
    resulting_member_id uuid,
    evidence jsonb,
    chunk_index integer NOT NULL,
    CONSTRAINT bulk_target_check CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT bulk_target_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT bulk_target_check2 CHECK ((((target_kind = 'subject'::text) AND (collection_id IS NULL) AND (member_id IS NULL)) OR ((target_kind = 'occurrence'::text) AND (collection_id IS NOT NULL) AND (member_id IS NOT NULL)))),
    CONSTRAINT bulk_target_check3 CHECK ((((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)) = ((get_byte(uuid_send(member_id), 10) * 256) + get_byte(uuid_send(member_id), 11)))),
    CONSTRAINT bulk_target_chunk_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT bulk_target_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT bulk_target_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT bulk_target_reason_check CHECK ((reason = ANY (ARRAY['revision_mismatch'::text, 'incarnation_mismatch'::text, 'missing_target'::text, 'authority_lost'::text, 'target_denied'::text, 'collection_full'::text, 'invalid_subject'::text, 'dependency_unavailable'::text, 'deadline'::text, 'cancel_requested'::text, 'evidence_missing'::text, 'execution_expired'::text]))),
    CONSTRAINT bulk_target_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text)),
    CONSTRAINT bulk_target_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT bulk_target_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_target_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'reconciling'::text, 'applied'::text, 'no_effect'::text, 'conflict'::text, 'denied'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT bulk_target_target_check CHECK ((jsonb_typeof(target) = 'object'::text)),
    CONSTRAINT bulk_target_target_kind_check CHECK ((target_kind = ANY (ARRAY['subject'::text, 'occurrence'::text])))
);


--
-- Name: canonical_source_fact; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.canonical_source_fact (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    basis_digest text NOT NULL,
    canonical_subject_id uuid NOT NULL,
    stored_subject_id uuid NOT NULL,
    driver text NOT NULL COLLATE pg_catalog."C",
    fact_id uuid NOT NULL,
    CONSTRAINT canonical_source_fact_basis_digest_check CHECK (((octet_length(convert_to(basis_digest, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(basis_digest, 'UTF8'::name)) <= 256))),
    CONSTRAINT canonical_source_fact_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT canonical_source_fact_driver_check CHECK ((driver = ANY (ARRAY['member'::text, 'entry'::text, 'label'::text, 'session'::text, 'copy'::text, 'output'::text]))),
    CONSTRAINT canonical_source_fact_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: canonical_source_generation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.canonical_source_generation (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    basis jsonb NOT NULL,
    driver text NOT NULL,
    after_subject uuid,
    after_fact uuid,
    source_exhausted boolean DEFAULT false NOT NULL,
    state text DEFAULT 'working'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT canonical_source_generation_basis_check CHECK ((octet_length((basis)::text) <= 4096)),
    CONSTRAINT canonical_source_generation_driver_check CHECK ((driver = ANY (ARRAY['member'::text, 'entry'::text, 'label'::text, 'session'::text, 'copy'::text, 'output'::text, 'done'::text]))),
    CONSTRAINT canonical_source_generation_state_check CHECK ((state = ANY (ARRAY['working'::text, 'complete'::text, 'abandoned'::text])))
);


--
-- Name: canonical_source_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.canonical_source_head (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL
);


--
-- Name: canonical_source_reference; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.canonical_source_reference (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    canonical_subject_id uuid NOT NULL,
    stored_subject_id uuid NOT NULL,
    driver smallint NOT NULL,
    fact_id uuid NOT NULL,
    CONSTRAINT canonical_source_reference_driver_check CHECK (((driver >= 0) AND (driver <= 5)))
);


--
-- Name: canonical_source_scope; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.canonical_source_scope (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    source_fence text NOT NULL,
    identity jsonb NOT NULL,
    frontier jsonb,
    capture_id uuid,
    committed_revision bigint,
    CONSTRAINT canonical_source_scope_frontier_check CHECK ((octet_length((frontier)::text) <= 4096)),
    CONSTRAINT canonical_source_scope_identity_check CHECK ((octet_length((identity)::text) <= 4096))
);


--
-- Name: canonical_source_state; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.canonical_source_state (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    ready_generation uuid,
    ready_basis text,
    working_generation uuid,
    working_basis text,
    after_subject_id uuid,
    after_driver text COLLATE pg_catalog."C",
    after_fact_id uuid,
    source_exhausted boolean DEFAULT false NOT NULL,
    pending_mapping boolean DEFAULT false NOT NULL,
    CONSTRAINT canonical_source_state_after_driver_check CHECK ((after_driver = ANY (ARRAY['member'::text, 'entry'::text, 'label'::text, 'session'::text, 'copy'::text, 'output'::text]))),
    CONSTRAINT canonical_source_state_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT canonical_source_state_check1 CHECK (((ready_generation IS NULL) = (ready_basis IS NULL))),
    CONSTRAINT canonical_source_state_check2 CHECK (((working_generation IS NULL) = (working_basis IS NULL))),
    CONSTRAINT canonical_source_state_check3 CHECK (((after_subject_id IS NULL) = (after_driver IS NULL))),
    CONSTRAINT canonical_source_state_check4 CHECK (((after_subject_id IS NULL) = (after_fact_id IS NULL))),
    CONSTRAINT canonical_source_state_ready_basis_check CHECK (((octet_length(convert_to(ready_basis, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(ready_basis, 'UTF8'::name)) <= 256))),
    CONSTRAINT canonical_source_state_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT canonical_source_state_working_basis_check CHECK (((octet_length(convert_to(working_basis, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(working_basis, 'UTF8'::name)) <= 256)))
);


--
-- Name: collection; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    curator_account_id uuid,
    title text NOT NULL,
    description text,
    visibility text NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    order_epoch integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    listing_ever_public boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    membership_kind text DEFAULT 'curated'::text NOT NULL,
    builtin_kind text,
    builtin_release_digest text,
    builtin_profile_id text,
    builtin_state_set_id text,
    builtin_state_id text,
    source_generation bigint DEFAULT 0 NOT NULL,
    presentation_kind text,
    cover_media_id uuid,
    deletion_id uuid,
    rule_filter jsonb,
    rule_sort text,
    rule_release_digest text,
    rule_revision bigint DEFAULT 0 NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    CONSTRAINT collection_active_deletion CHECK (((state <> 'active'::text) OR (deleted_at IS NULL))),
    CONSTRAINT collection_builtin_identity_check CHECK (
CASE membership_kind
    WHEN 'curated'::text THEN ((builtin_kind IS NULL) AND (builtin_release_digest IS NULL) AND (builtin_profile_id IS NULL) AND (builtin_state_set_id IS NULL) AND (builtin_state_id IS NULL))
    WHEN 'dynamic'::text THEN
    CASE builtin_kind
        WHEN 'everything'::text THEN (((builtin_release_digest IS NULL) OR ((octet_length(builtin_release_digest) = 71) AND ((builtin_release_digest COLLATE "C") ~ '\Asha256:[0-9a-f]{64}\Z'::text))) AND (builtin_profile_id IS NULL) AND (builtin_state_set_id IS NULL) AND (builtin_state_id IS NULL))
        WHEN 'state'::text THEN ((builtin_release_digest IS NOT NULL) AND (builtin_profile_id IS NOT NULL) AND (builtin_state_set_id IS NOT NULL) AND (builtin_state_id IS NOT NULL) AND (octet_length(builtin_release_digest) = 71) AND ((builtin_release_digest COLLATE "C") ~ '\Asha256:[0-9a-f]{64}\Z'::text) AND ((octet_length(builtin_profile_id) >= 1) AND (octet_length(builtin_profile_id) <= 64)) AND ((builtin_profile_id COLLATE "C") ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'::text) AND ((octet_length(builtin_state_set_id) >= 1) AND (octet_length(builtin_state_set_id) <= 64)) AND ((builtin_state_set_id COLLATE "C") ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'::text) AND ((octet_length(builtin_state_id) >= 1) AND (octet_length(builtin_state_id) <= 64)) AND ((builtin_state_id COLLATE "C") ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'::text))
        ELSE ((builtin_kind IS NULL) AND (builtin_release_digest IS NULL) AND (builtin_profile_id IS NULL) AND (builtin_state_set_id IS NULL) AND (builtin_state_id IS NULL))
    END
    ELSE false
END),
    CONSTRAINT collection_builtin_kind_check CHECK ((builtin_kind = ANY (ARRAY['everything'::text, 'state'::text]))),
    CONSTRAINT collection_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_check1 CHECK ((route = ((get_byte(uuid_send(curator_account_id), 10) * 256) + get_byte(uuid_send(curator_account_id), 11)))),
    CONSTRAINT collection_deidentified_public CHECK (((curator_account_id IS NOT NULL) OR ((state = 'active'::text) AND (visibility = 'public'::text)))),
    CONSTRAINT collection_deletion_id_state_check CHECK (((state = 'deleted'::text) = (deletion_id IS NOT NULL))),
    CONSTRAINT collection_deletion_pair CHECK (((deleted_at IS NULL) = (purge_after IS NULL))),
    CONSTRAINT collection_deletion_window CHECK ((purge_after = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT collection_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT collection_member_count_check CHECK ((member_count >= 0)),
    CONSTRAINT collection_membership_kind_check CHECK ((membership_kind = ANY (ARRAY['curated'::text, 'dynamic'::text]))),
    CONSTRAINT collection_order_epoch_check CHECK ((order_epoch >= 0)),
    CONSTRAINT collection_revision_check CHECK ((revision >= 1)),
    CONSTRAINT collection_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_saved_rule CHECK ((((rule_filter IS NULL) AND (rule_sort IS NULL) AND (rule_release_digest IS NULL) AND (rule_revision = 0)) OR ((membership_kind = 'dynamic'::text) AND (builtin_kind IS NULL) AND (curator_account_id IS NOT NULL) AND (jsonb_typeof(rule_filter) = 'object'::text) AND (rule_sort = 'id'::text) AND ((rule_release_digest COLLATE "C") ~ '\Asha256:[0-9a-f]{64}\Z'::text) AND (octet_length(rule_release_digest) = 71) AND (rule_revision > 0) AND (rule_filter IS NOT NULL) AND (rule_sort IS NOT NULL) AND (rule_release_digest IS NOT NULL)))),
    CONSTRAINT collection_source_generation_check CHECK ((source_generation >= 0)),
    CONSTRAINT collection_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text]))),
    CONSTRAINT collection_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT collection_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'unlisted'::text, 'public'::text])))
);


--
-- Name: collection_kind_audience_origin; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_audience_origin (
    route integer NOT NULL,
    origin_id text NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    audience text NOT NULL,
    original_digest text NOT NULL,
    formula_digest text NOT NULL,
    source_generation bigint NOT NULL,
    source_capture text NOT NULL,
    origin_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    deadline_at bigint NOT NULL,
    cancelled boolean DEFAULT false NOT NULL,
    CONSTRAINT collection_kind_audience_origin_audience_check CHECK (((octet_length(audience) >= 1) AND (octet_length(audience) <= 256))),
    CONSTRAINT collection_kind_audience_origin_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_kind_audience_origin_check1 CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT collection_kind_audience_origin_deadline_at_check CHECK ((deadline_at > 0)),
    CONSTRAINT collection_kind_audience_origin_formula_digest_check CHECK ((formula_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT collection_kind_audience_origin_origin_id_check CHECK (((octet_length(origin_id) >= 1) AND (octet_length(origin_id) <= 255))),
    CONSTRAINT collection_kind_audience_origin_original_digest_check CHECK ((original_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT collection_kind_audience_origin_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_kind_audience_origin_source_capture_check CHECK (((octet_length(source_capture) >= 1) AND (octet_length(source_capture) <= 4096))),
    CONSTRAINT collection_kind_audience_origin_source_generation_check CHECK ((source_generation >= 0))
);


--
-- Name: collection_kind_consent_consumer; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_consent_consumer (
    route integer NOT NULL,
    reference_id text NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    origin_id text NOT NULL,
    source_generation bigint NOT NULL,
    capture_generation uuid NOT NULL,
    source_capture text NOT NULL,
    enrollment_generation uuid NOT NULL,
    catalogue_root text NOT NULL,
    restore_generation bigint DEFAULT 0 NOT NULL,
    invalidated boolean DEFAULT false NOT NULL,
    last_transition_id text,
    CONSTRAINT collection_kind_consent_consumer_catalogue_root_check CHECK (((octet_length(catalogue_root) >= 1) AND (octet_length(catalogue_root) <= 128))),
    CONSTRAINT collection_kind_consent_consumer_check CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT collection_kind_consent_consumer_check1 CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_kind_consent_consumer_last_transition_id_check CHECK (((last_transition_id IS NULL) OR ((octet_length(last_transition_id) >= 1) AND (octet_length(last_transition_id) <= 255)))),
    CONSTRAINT collection_kind_consent_consumer_origin_id_check CHECK (((octet_length(origin_id) >= 1) AND (octet_length(origin_id) <= 255))),
    CONSTRAINT collection_kind_consent_consumer_reference_id_check CHECK (((octet_length(reference_id) >= 1) AND (octet_length(reference_id) <= 255))),
    CONSTRAINT collection_kind_consent_consumer_restore_generation_check CHECK ((restore_generation >= 0)),
    CONSTRAINT collection_kind_consent_consumer_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_kind_consent_consumer_source_capture_check CHECK (((octet_length(source_capture) >= 1) AND (octet_length(source_capture) <= 4096))),
    CONSTRAINT collection_kind_consent_consumer_source_generation_check CHECK ((source_generation >= 0))
);


--
-- Name: collection_kind_consent_transition; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_consent_transition (
    route integer NOT NULL,
    reference_id text NOT NULL,
    transition_id text NOT NULL,
    enrollment_generation uuid CONSTRAINT collection_kind_consent_transiti_enrollment_generation_not_null NOT NULL,
    restore_generation bigint NOT NULL,
    receipt_reference text NOT NULL,
    status text NOT NULL,
    CONSTRAINT collection_kind_consent_transition_receipt_reference_check CHECK (((octet_length(receipt_reference) >= 1) AND (octet_length(receipt_reference) <= 255))),
    CONSTRAINT collection_kind_consent_transition_restore_generation_check CHECK ((restore_generation >= 0)),
    CONSTRAINT collection_kind_consent_transition_status_check CHECK ((status = 'committed'::text)),
    CONSTRAINT collection_kind_consent_transition_transition_id_check CHECK (((octet_length(transition_id) >= 1) AND (octet_length(transition_id) <= 255)))
);


--
-- Name: collection_kind_count; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_count (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    audience text NOT NULL,
    generation uuid NOT NULL,
    type_id text NOT NULL COLLATE pg_catalog."C",
    votes bigint NOT NULL,
    CONSTRAINT collection_kind_count_votes_check CHECK ((votes > 0))
);


--
-- Name: collection_kind_observation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_observation (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    audience text NOT NULL,
    generation uuid NOT NULL,
    source_generation bigint NOT NULL,
    capture text NOT NULL,
    after_subject uuid,
    frontier text,
    version bigint DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    winner text,
    CONSTRAINT collection_kind_observation_audience_check CHECK (((octet_length(audience) >= 1) AND (octet_length(audience) <= 256))),
    CONSTRAINT collection_kind_observation_capture_check CHECK (((octet_length(capture) >= 1) AND (octet_length(capture) <= 4096))),
    CONSTRAINT collection_kind_observation_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_kind_observation_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT collection_kind_observation_check2 CHECK ((complete OR (winner IS NULL))),
    CONSTRAINT collection_kind_observation_frontier_check CHECK (((octet_length(frontier) >= 1) AND (octet_length(frontier) <= 4096))),
    CONSTRAINT collection_kind_observation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_kind_observation_version_check CHECK ((version >= 0))
);


--
-- Name: collection_kind_raw_input; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_raw_input (
    route integer NOT NULL,
    origin_id text NOT NULL,
    preparation_id uuid NOT NULL,
    observation_version bigint NOT NULL,
    input_id text NOT NULL,
    predecessor text,
    body text NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT collection_kind_raw_input_body_check CHECK (((octet_length(body) >= 1) AND (octet_length(body) <= 4096))),
    CONSTRAINT collection_kind_raw_input_input_id_check CHECK ((input_id ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT collection_kind_raw_input_observation_version_check CHECK ((observation_version >= 0)),
    CONSTRAINT collection_kind_raw_input_predecessor_check CHECK ((predecessor ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: collection_kind_retired; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_retired (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    audience text NOT NULL,
    generation uuid NOT NULL,
    capture text NOT NULL
);


--
-- Name: collection_kind_subject; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_kind_subject (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    audience text NOT NULL,
    generation uuid NOT NULL,
    subject_id uuid NOT NULL,
    type_id text NOT NULL
);


--
-- Name: collection_listing_history; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_listing_history (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    ever_public boolean NOT NULL,
    CONSTRAINT collection_listing_history_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_listing_history_ever_public_check CHECK (ever_public),
    CONSTRAINT collection_listing_history_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: collection_member; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_member (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    member_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    note text,
    ordinal_key text NOT NULL COLLATE pg_catalog."C",
    added_at timestamp with time zone,
    transaction_id uuid NOT NULL,
    member_revision bigint DEFAULT 1 NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    deletion_id uuid,
    deletion_revision bigint,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    deleted_ordinal_key text COLLATE pg_catalog."C",
    CONSTRAINT collection_member_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_member_check1 CHECK ((route = ((get_byte(uuid_send(member_id), 10) * 256) + get_byte(uuid_send(member_id), 11)))),
    CONSTRAINT collection_member_note_check CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT collection_member_ordinal_key_check CHECK (((char_length(ordinal_key) >= 1) AND (char_length(ordinal_key) <= 48))),
    CONSTRAINT collection_member_retention_check CHECK ((((deletion_id IS NULL) AND (deletion_revision IS NULL) AND (deleted_at IS NULL) AND (purge_after IS NULL) AND (added_at IS NOT NULL)) OR ((deletion_id IS NOT NULL) AND (deletion_revision IS NOT NULL) AND (deleted_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (added_at IS NOT NULL)) OR ((deletion_id IS NOT NULL) AND (deletion_revision IS NULL) AND (deleted_at IS NULL) AND (purge_after IS NULL) AND (added_at IS NULL) AND (note IS NULL)))),
    CONSTRAINT collection_member_revision_check CHECK ((member_revision >= 1)),
    CONSTRAINT collection_member_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: collection_order_repair; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_order_repair (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    repair_id uuid NOT NULL,
    admitted_count integer NOT NULL,
    original_minimum text NOT NULL COLLATE pg_catalog."C",
    lower_key text NOT NULL COLLATE pg_catalog."C",
    upper_key text NOT NULL COLLATE pg_catalog."C",
    admitted_revision integer NOT NULL,
    admitted_source_generation bigint NOT NULL,
    admitted_order_epoch integer NOT NULL,
    expected_revision integer NOT NULL,
    expected_source_generation bigint NOT NULL,
    expected_order_epoch integer NOT NULL,
    processed integer DEFAULT 0 NOT NULL,
    step integer DEFAULT 0 NOT NULL,
    after_key text COLLATE pg_catalog."C",
    after_member_id uuid,
    state text DEFAULT 'active'::text NOT NULL,
    writer_xid xid8,
    CONSTRAINT collection_order_repair_admitted_count_check CHECK ((admitted_count > 0)),
    CONSTRAINT collection_order_repair_check CHECK (((processed >= 0) AND (processed <= admitted_count))),
    CONSTRAINT collection_order_repair_check1 CHECK (((lower_key < upper_key) AND (upper_key < original_minimum))),
    CONSTRAINT collection_order_repair_check2 CHECK (((after_key IS NULL) = (after_member_id IS NULL))),
    CONSTRAINT collection_order_repair_check3 CHECK ((route = ((get_byte(uuid_send(repair_id), 10) * 256) + get_byte(uuid_send(repair_id), 11)))),
    CONSTRAINT collection_order_repair_lower_key_check CHECK (((octet_length(lower_key) >= 1) AND (octet_length(lower_key) <= 48))),
    CONSTRAINT collection_order_repair_original_minimum_check CHECK (((octet_length(original_minimum) >= 1) AND (octet_length(original_minimum) <= 48))),
    CONSTRAINT collection_order_repair_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_order_repair_state_check CHECK ((state = ANY (ARRAY['active'::text, 'complete'::text, 'cancelled'::text]))),
    CONSTRAINT collection_order_repair_step_check CHECK ((step >= 0)),
    CONSTRAINT collection_order_repair_upper_key_check CHECK (((octet_length(upper_key) >= 1) AND (octet_length(upper_key) <= 48)))
);


--
-- Name: collection_pins; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_pins (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    collection_ids uuid[] NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT collection_pins_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT collection_pins_collection_ids_check CHECK ((cardinality(collection_ids) <= 100)),
    CONSTRAINT collection_pins_collection_ids_check1 CHECK (((cardinality(collection_ids) = 0) OR ((array_ndims(collection_ids) = 1) AND (array_lower(collection_ids, 1) = 1)))),
    CONSTRAINT collection_pins_collection_ids_check2 CHECK ((array_position(collection_ids, NULL::uuid) IS NULL)),
    CONSTRAINT collection_pins_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT collection_pins_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: collection_publication_episode; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_publication_episode (
    route integer NOT NULL,
    publication_id uuid NOT NULL,
    source_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    owner_account_id uuid NOT NULL,
    phase text DEFAULT 'staging'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT collection_publication_episode_phase_check CHECK ((phase = ANY (ARRAY['staging'::text, 'awaiting_activation'::text, 'refused'::text, 'complete'::text]))),
    CONSTRAINT collection_publication_episode_version_check CHECK ((version >= 0))
);


--
-- Name: collection_publication_operation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_publication_operation (
    route integer NOT NULL,
    publication_id uuid NOT NULL,
    source_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    owner_account_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    record jsonb NOT NULL,
    source_digest text NOT NULL,
    commitment text NOT NULL,
    creation_storage_key text NOT NULL,
    creation_key text GENERATED ALWAYS AS (((record -> 'creation'::text) ->> 'idempotencyKey'::text)) STORED NOT NULL,
    CONSTRAINT collection_publication_operation_check CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT collection_publication_operation_check1 CHECK ((route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT collection_publication_operation_check2 CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_publication_operation_check3 CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT collection_publication_operation_commitment_check CHECK ((commitment ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT collection_publication_operation_creation_storage_key_check CHECK ((octet_length(creation_storage_key) <= 255)),
    CONSTRAINT collection_publication_operation_record_check CHECK ((octet_length((record)::text) <= 65536)),
    CONSTRAINT collection_publication_operation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_publication_operation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: collection_publication_source; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_publication_source (
    route integer NOT NULL,
    source_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    bytes text NOT NULL,
    CONSTRAINT collection_publication_source_bytes_check CHECK ((octet_length(bytes) <= 16384))
);


--
-- Name: collection_publication_staging; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_publication_staging (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    publication_id uuid NOT NULL,
    account_id uuid NOT NULL,
    definition_digest text NOT NULL,
    binding jsonb NOT NULL,
    scope_basis jsonb NOT NULL,
    canonical_generation uuid NOT NULL,
    canonical_basis_digest text NOT NULL,
    fact_fence bigint NOT NULL,
    public_inputs boolean NOT NULL,
    frontier jsonb NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    evidence_count bigint DEFAULT 0 NOT NULL,
    evidence_fence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT collection_publication_staging_binding_check CHECK ((octet_length((binding)::text) <= 16384)),
    CONSTRAINT collection_publication_staging_canonical_basis_digest_check CHECK ((canonical_basis_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT collection_publication_staging_definition_digest_check CHECK ((definition_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT collection_publication_staging_evidence_count_check CHECK ((evidence_count >= 0)),
    CONSTRAINT collection_publication_staging_evidence_fence_check CHECK ((evidence_fence >= 0)),
    CONSTRAINT collection_publication_staging_fact_fence_check CHECK ((fact_fence >= 0)),
    CONSTRAINT collection_publication_staging_frontier_check CHECK ((octet_length((frontier)::text) <= 4096)),
    CONSTRAINT collection_publication_staging_scope_basis_check CHECK ((octet_length((scope_basis)::text) <= 8192)),
    CONSTRAINT collection_publication_staging_version_check CHECK ((version >= 0))
);


--
-- Name: collection_publication_staging_evidence; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_publication_staging_evidence (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    subject_id uuid NOT NULL,
    included boolean NOT NULL,
    evidence jsonb NOT NULL,
    CONSTRAINT collection_publication_staging_evidence_evidence_check CHECK ((octet_length((evidence)::text) <= 16384))
);


--
-- Name: collection_publication_staging_seal; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_publication_staging_seal (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    version bigint NOT NULL,
    member_fence bigint NOT NULL,
    members bigint NOT NULL,
    evidence_count bigint NOT NULL,
    evidence_fence bigint NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT collection_publication_staging_seal_position_check CHECK (("position" > 0))
);


--
-- Name: collection_retained_output; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_retained_output (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    source_generation bigint NOT NULL,
    members bigint NOT NULL,
    member_fence bigint NOT NULL,
    transaction_id uuid NOT NULL,
    native_xid xid8 NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    CONSTRAINT collection_retained_output_members_check CHECK ((members >= 0))
);


--
-- Name: collection_source_output; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_source_output (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    source_generation bigint NOT NULL,
    expected_members bigint,
    written_members bigint DEFAULT 0 NOT NULL,
    after_subject_id uuid,
    state text DEFAULT 'building'::text NOT NULL,
    account_id uuid,
    member_count bigint DEFAULT 0 NOT NULL,
    member_fence bigint DEFAULT 0 NOT NULL,
    output_mode text DEFAULT 'selected'::text NOT NULL,
    CONSTRAINT collection_output_cardinality CHECK ((((expected_members IS NOT NULL) AND (expected_members >= 0) AND (written_members <= expected_members)) OR ((output_mode = 'whole_query'::text) AND (expected_members IS NULL) AND (state <> 'complete'::text)))),
    CONSTRAINT collection_output_complete_cardinality CHECK (((state <> 'complete'::text) OR ((expected_members IS NOT NULL) AND (written_members = expected_members)))),
    CONSTRAINT collection_source_output_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_source_output_check2 CHECK (((written_members = 0) = (after_subject_id IS NULL))),
    CONSTRAINT collection_source_output_member_count_check CHECK ((member_count >= 0)),
    CONSTRAINT collection_source_output_member_fence_check CHECK ((member_fence >= 0)),
    CONSTRAINT collection_source_output_output_mode_check CHECK ((output_mode = ANY (ARRAY['selected'::text, 'whole_query'::text]))),
    CONSTRAINT collection_source_output_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_source_output_source_generation_check CHECK ((source_generation >= 0)),
    CONSTRAINT collection_source_output_state_check CHECK ((state = ANY (ARRAY['building'::text, 'complete'::text, 'cancelled'::text]))),
    CONSTRAINT collection_source_output_written_members_check CHECK ((written_members >= 0))
);


--
-- Name: collection_source_output_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_source_output_head (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    source_generation bigint NOT NULL,
    CONSTRAINT collection_source_output_head_source_generation_check CHECK ((source_generation >= 0))
);


--
-- Name: collection_source_output_member; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_source_output_member (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    subject_id uuid NOT NULL
);


--
-- Name: collection_source_output_publication; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_source_output_publication (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    generation uuid NOT NULL,
    account_id uuid NOT NULL,
    incarnation text NOT NULL,
    source_generation bigint NOT NULL,
    expected_members bigint NOT NULL,
    member_fence bigint NOT NULL,
    collection_fence bigint NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    transaction_id uuid NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT collection_source_output_publication_collection_fence_check CHECK ((collection_fence >= 0)),
    CONSTRAINT collection_source_output_publication_expected_members_check CHECK ((expected_members >= 0)),
    CONSTRAINT collection_source_output_publication_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT collection_source_output_publication_member_fence_check CHECK ((member_fence >= 0)),
    CONSTRAINT collection_source_output_publication_source_generation_check CHECK ((source_generation > 0))
);


--
-- Name: consumption_statistics_installation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.consumption_statistics_installation (
    singleton boolean DEFAULT true NOT NULL,
    version integer NOT NULL,
    complete boolean NOT NULL,
    CONSTRAINT consumption_statistics_installation_singleton_check CHECK (singleton),
    CONSTRAINT consumption_statistics_installation_version_check CHECK ((version = 1))
);


--
-- Name: consumption_statistics_owner; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.consumption_statistics_owner (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    retained_sessions bigint NOT NULL,
    completed_occurrences bigint NOT NULL,
    completed_subjects bigint NOT NULL,
    unknown_profile_completed bigint NOT NULL,
    revision uuid NOT NULL,
    CONSTRAINT consumption_statistics_owner_check CHECK ((completed_subjects <= completed_occurrences)),
    CONSTRAINT consumption_statistics_owner_check1 CHECK ((unknown_profile_completed <= completed_occurrences)),
    CONSTRAINT consumption_statistics_owner_check2 CHECK ((completed_occurrences <= retained_sessions)),
    CONSTRAINT consumption_statistics_owner_completed_occurrences_check CHECK ((completed_occurrences >= 0)),
    CONSTRAINT consumption_statistics_owner_completed_subjects_check CHECK ((completed_subjects >= 0)),
    CONSTRAINT consumption_statistics_owner_retained_sessions_check CHECK ((retained_sessions >= 0)),
    CONSTRAINT consumption_statistics_owner_unknown_profile_completed_check CHECK ((unknown_profile_completed >= 0))
);


--
-- Name: consumption_statistics_subject; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.consumption_statistics_subject (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    retained_sessions bigint NOT NULL,
    completed_occurrences bigint NOT NULL,
    CONSTRAINT consumption_statistics_subject_check CHECK ((completed_occurrences <= retained_sessions)),
    CONSTRAINT consumption_statistics_subject_completed_occurrences_check CHECK ((completed_occurrences >= 0)),
    CONSTRAINT consumption_statistics_subject_retained_sessions_check CHECK ((retained_sessions >= 0))
);


--
-- Name: copy; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.copy (
    route integer NOT NULL,
    copy_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    status text NOT NULL,
    location text,
    source text,
    acquired_on date,
    disposed_on date,
    note text,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    library_profile_pin jsonb,
    kind text,
    deletion_id uuid,
    deleted_at timestamp with time zone,
    restore_until timestamp with time zone,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    kind_profile_pin jsonb,
    status_profile_pin jsonb,
    CONSTRAINT copy_check CHECK ((route = ((get_byte(uuid_send(copy_id), 10) * 256) + get_byte(uuid_send(copy_id), 11)))),
    CONSTRAINT copy_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT copy_kind_profile_pin_check CHECK (((kind_profile_pin IS NULL) OR library.library_profile_pin_valid(kind_profile_pin))),
    CONSTRAINT copy_library_profile_kind_check CHECK (((library_profile_pin IS NULL) OR ((kind IS NOT NULL) AND (char_length(kind) > 0)))),
    CONSTRAINT copy_library_profile_pin_check CHECK (((library_profile_pin IS NULL) OR library.library_profile_pin_valid(library_profile_pin))),
    CONSTRAINT copy_location_check CHECK (((location IS NULL) OR (char_length(location) <= 200))),
    CONSTRAINT copy_note_check CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT copy_retention_episode CHECK ((((deletion_id IS NULL) AND (deleted_at IS NULL) AND (restore_until IS NULL)) OR ((deletion_id IS NOT NULL) AND (deleted_at IS NOT NULL) AND (restore_until IS NOT NULL) AND (restore_until = (deleted_at + '720:00:00'::interval))))),
    CONSTRAINT copy_revision_check CHECK ((revision >= 1)),
    CONSTRAINT copy_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT copy_source_check CHECK (((source IS NULL) OR (char_length(source) <= 200))),
    CONSTRAINT copy_status_profile_pin_check CHECK (((status_profile_pin IS NULL) OR library.library_profile_pin_valid(status_profile_pin)))
);


--
-- Name: copy_archive_row; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.copy_archive_row (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    ordinal integer NOT NULL,
    evidence jsonb NOT NULL,
    CONSTRAINT copy_archive_row_evidence_check CHECK ((octet_length((evidence)::text) <= 131072)),
    CONSTRAINT copy_archive_row_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 99999)))
);


--
-- Name: copy_archive_upload; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.copy_archive_upload (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    manifest jsonb NOT NULL,
    coverage jsonb NOT NULL,
    holding_count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    cancelled boolean DEFAULT false NOT NULL,
    removing boolean DEFAULT false NOT NULL,
    CONSTRAINT copy_archive_upload_coverage_check CHECK ((octet_length((coverage)::text) <= 8192)),
    CONSTRAINT copy_archive_upload_holding_count_check CHECK (((holding_count >= 0) AND (holding_count <= 4096))),
    CONSTRAINT copy_archive_upload_manifest_check CHECK ((octet_length((manifest)::text) <= 131072)),
    CONSTRAINT copy_archive_upload_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: diary_navigation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.diary_navigation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    slot smallint NOT NULL,
    navigation_id uuid NOT NULL,
    caller text NOT NULL,
    epoch integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT diary_navigation_caller_check CHECK ((length(caller) = 64)),
    CONSTRAINT diary_navigation_check CHECK ((expires_at > created_at)),
    CONSTRAINT diary_navigation_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT diary_navigation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT diary_navigation_slot_check CHECK (((slot >= 0) AND (slot <= 7)))
);


--
-- Name: entry; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    requested_subject_id uuid,
    state text NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    activity_at timestamp with time zone,
    finished_at timestamp with time zone,
    type_id uuid,
    type_source_id uuid,
    type_source_partition integer,
    type_source_epoch integer,
    type_source_position bigint,
    incarnation_id uuid,
    library_profile_pin jsonb,
    owner_write_seq bigint,
    CONSTRAINT entry_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_library_profile_pin_check CHECK (((library_profile_pin IS NULL) OR library.library_profile_pin_valid(library_profile_pin))),
    CONSTRAINT entry_owner_write_seq_check CHECK ((owner_write_seq > 0)),
    CONSTRAINT entry_revision_check CHECK ((revision >= 1)),
    CONSTRAINT entry_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT entry_type_observation_check CHECK ((((type_id IS NULL) AND (type_source_id IS NULL) AND (type_source_partition IS NULL) AND (type_source_epoch IS NULL) AND (type_source_position IS NULL)) OR ((type_id IS NOT NULL) AND (type_source_id IS NOT NULL) AND (type_source_partition IS NOT NULL) AND (type_source_epoch IS NOT NULL) AND (type_source_position IS NOT NULL) AND ((type_source_partition >= 0) AND (type_source_partition <= 4095)) AND (type_source_epoch >= 1) AND (type_source_position >= 0) AND (type_source_partition = (((get_byte(uuid_send(type_source_id), 10) * 256) + get_byte(uuid_send(type_source_id), 11)) >> 4)))))
);


--
-- Name: entry_deleted; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry_deleted (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    requested_subject_id uuid,
    state text NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    activity_at timestamp with time zone,
    finished_at timestamp with time zone,
    type_id uuid,
    type_source_id uuid,
    type_source_partition integer,
    type_source_epoch integer,
    type_source_position bigint,
    incarnation_id uuid NOT NULL,
    library_profile_pin jsonb,
    deletion_id uuid NOT NULL,
    deleted_revision integer NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    restore_until timestamp with time zone NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    owner_write_seq bigint,
    CONSTRAINT entry_deleted_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_deleted_legacy_state_check CHECK (((library_profile_pin IS NOT NULL) OR (state = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text])))),
    CONSTRAINT entry_deleted_library_profile_pin_check CHECK (((library_profile_pin IS NULL) OR library.library_profile_pin_valid(library_profile_pin))),
    CONSTRAINT entry_deleted_owner_write_seq_check CHECK ((owner_write_seq > 0)),
    CONSTRAINT entry_deleted_restore_window CHECK ((restore_until = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT entry_deleted_revision_check CHECK (((revision >= 1) AND (revision <= 2147483644))),
    CONSTRAINT entry_deleted_revision_step CHECK ((deleted_revision = (revision + 1))),
    CONSTRAINT entry_deleted_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT entry_deleted_type_observation_check CHECK ((((type_id IS NULL) AND (type_source_id IS NULL) AND (type_source_partition IS NULL) AND (type_source_epoch IS NULL) AND (type_source_position IS NULL)) OR ((type_id IS NOT NULL) AND (type_source_id IS NOT NULL) AND (type_source_partition IS NOT NULL) AND (type_source_epoch IS NOT NULL) AND (type_source_position IS NOT NULL) AND ((type_source_partition >= 0) AND (type_source_partition <= 4095)) AND (type_source_epoch >= 1) AND (type_source_position >= 0) AND (type_source_partition = (((get_byte(uuid_send(type_source_id), 10) * 256) + get_byte(uuid_send(type_source_id), 11)) >> 4)))))
);


--
-- Name: entry_personal_fact; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry_personal_fact (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    fact_id uuid NOT NULL,
    annotation_revision integer DEFAULT 0 NOT NULL,
    note text,
    priority smallint,
    annotation_updated_at timestamp with time zone,
    annotation_transaction_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT entry_personal_fact_annotation_audit_check CHECK ((((annotation_revision = 0) AND (note IS NULL) AND (priority IS NULL) AND (annotation_updated_at IS NULL) AND (annotation_transaction_id IS NULL)) OR ((annotation_revision > 0) AND (annotation_updated_at IS NOT NULL) AND (annotation_transaction_id IS NOT NULL)))),
    CONSTRAINT entry_personal_fact_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_personal_fact_fact_route_check CHECK ((route = ((get_byte(uuid_send(fact_id), 10) * 256) + get_byte(uuid_send(fact_id), 11)))),
    CONSTRAINT entry_personal_fact_note_check CHECK (((note IS NULL) OR ((octet_length(note) >= 1) AND (octet_length(note) <= 4096)))),
    CONSTRAINT entry_personal_fact_priority_check CHECK (((priority IS NULL) OR ((priority >= 1) AND (priority <= 100)))),
    CONSTRAINT entry_personal_fact_revision_check CHECK (((annotation_revision >= 0) AND (annotation_revision <= 2147483646))),
    CONSTRAINT entry_personal_fact_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: entry_source_observation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry_source_observation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    provider text NOT NULL COLLATE pg_catalog."C",
    record_id text NOT NULL COLLATE pg_catalog."C",
    revision integer NOT NULL,
    privacy_status text NOT NULL,
    privacy_meaning text,
    privacy_source_value text,
    source_created_status text NOT NULL,
    source_created_value text,
    source_created_precision text,
    source_created_zone text,
    source_updated_status text NOT NULL,
    source_updated_value text,
    source_updated_precision text,
    source_updated_zone text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT entry_source_observation_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_source_observation_created_check CHECK ((((source_created_status = 'known'::text) AND (source_created_value IS NOT NULL) AND ((octet_length(source_created_value) >= 4) AND (octet_length(source_created_value) <= 64)) AND (source_created_precision IS NOT NULL) AND (source_created_precision = ANY (ARRAY['year'::text, 'month'::text, 'day'::text, 'minute'::text, 'second'::text, 'fraction'::text])) AND (source_created_zone IS NOT NULL) AND (source_created_zone = ANY (ARRAY['utc'::text, 'offset'::text, 'unknown'::text]))) OR ((source_created_status = 'unknown'::text) AND ((source_created_value IS NULL) OR ((octet_length(source_created_value) >= 1) AND (octet_length(source_created_value) <= 64))) AND (source_created_precision IS NULL) AND (source_created_zone IS NULL)) OR ((source_created_status = ANY (ARRAY['absent'::text, 'cleared'::text])) AND (source_created_value IS NULL) AND (source_created_precision IS NULL) AND (source_created_zone IS NULL)))),
    CONSTRAINT entry_source_observation_privacy_check CHECK ((((privacy_status = 'known'::text) AND (privacy_meaning IS NOT NULL) AND (privacy_meaning = ANY (ARRAY['private'::text, 'source_visible'::text])) AND (privacy_source_value IS NULL)) OR ((privacy_status = 'unknown'::text) AND (privacy_meaning IS NULL) AND ((privacy_source_value IS NULL) OR ((octet_length(privacy_source_value) >= 1) AND (octet_length(privacy_source_value) <= 192)))) OR ((privacy_status = ANY (ARRAY['absent'::text, 'cleared'::text])) AND (privacy_meaning IS NULL) AND (privacy_source_value IS NULL)))),
    CONSTRAINT entry_source_observation_provider_check CHECK (((octet_length(provider) >= 1) AND (octet_length(provider) <= 64))),
    CONSTRAINT entry_source_observation_record_id_check CHECK (((octet_length(record_id) >= 1) AND (octet_length(record_id) <= 192))),
    CONSTRAINT entry_source_observation_revision_check CHECK (((revision >= 1) AND (revision <= 2147483646))),
    CONSTRAINT entry_source_observation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT entry_source_observation_updated_check CHECK ((((source_updated_status = 'known'::text) AND (source_updated_value IS NOT NULL) AND ((octet_length(source_updated_value) >= 4) AND (octet_length(source_updated_value) <= 64)) AND (source_updated_precision IS NOT NULL) AND (source_updated_precision = ANY (ARRAY['year'::text, 'month'::text, 'day'::text, 'minute'::text, 'second'::text, 'fraction'::text])) AND (source_updated_zone IS NOT NULL) AND (source_updated_zone = ANY (ARRAY['utc'::text, 'offset'::text, 'unknown'::text]))) OR ((source_updated_status = 'unknown'::text) AND ((source_updated_value IS NULL) OR ((octet_length(source_updated_value) >= 1) AND (octet_length(source_updated_value) <= 64))) AND (source_updated_precision IS NULL) AND (source_updated_zone IS NULL)) OR ((source_updated_status = ANY (ARRAY['absent'::text, 'cleared'::text])) AND (source_updated_value IS NULL) AND (source_updated_precision IS NULL) AND (source_updated_zone IS NULL))))
);


--
-- Name: entry_state_change; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry_state_change (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    incarnation_id uuid NOT NULL,
    prior_revision integer,
    revision integer NOT NULL,
    before_state text,
    before_profile_pin jsonb,
    after_state text NOT NULL,
    after_profile_pin jsonb,
    command_id uuid NOT NULL,
    command_kind text NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    coverage_complete boolean NOT NULL,
    CONSTRAINT entry_state_change_after_profile_pin_check CHECK (((after_profile_pin IS NULL) OR library.library_profile_pin_valid(after_profile_pin))),
    CONSTRAINT entry_state_change_before_profile_pin_check CHECK (((before_profile_pin IS NULL) OR library.library_profile_pin_valid(before_profile_pin))),
    CONSTRAINT entry_state_change_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_state_change_check1 CHECK ((((prior_revision IS NULL) AND (revision = 1) AND (before_state IS NULL) AND (before_profile_pin IS NULL)) OR ((prior_revision IS NOT NULL) AND (prior_revision >= 1) AND (revision = (prior_revision + 1)) AND (before_state IS NOT NULL)))),
    CONSTRAINT entry_state_change_command_kind_check CHECK ((command_kind = ANY (ARRAY['library.entry.put'::text, 'library.entry.state.restore'::text]))),
    CONSTRAINT entry_state_change_revision_check CHECK (((revision >= 1) AND (revision <= 2147483644))),
    CONSTRAINT entry_state_change_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: fact_source_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.fact_source_head (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    generation bigint NOT NULL,
    profile_migration_phase text DEFAULT 'legacy'::text NOT NULL,
    profile_migration_digest text,
    profile_migration_after uuid,
    CONSTRAINT fact_source_head_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT fact_source_head_generation_check CHECK ((generation > 0)),
    CONSTRAINT fact_source_head_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT profile_migration_control CHECK (((profile_migration_phase = ANY (ARRAY['legacy'::text, 'entry'::text, 'session'::text, 'copy'::text, 'ready'::text])) AND ((profile_migration_digest IS NULL) OR (profile_migration_digest ~ '^sha256:[0-9a-f]{64}$'::text)) AND ((profile_migration_phase = ANY (ARRAY['legacy'::text, 'ready'::text])) OR (profile_migration_digest IS NOT NULL)) AND ((profile_migration_phase <> ALL (ARRAY['legacy'::text, 'ready'::text])) OR (profile_migration_after IS NULL))))
);


--
-- Name: follow; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    target_id uuid NOT NULL,
    target_type text NOT NULL,
    state text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT follow_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT follow_check1 CHECK (((reason = 'explicit'::text) OR (state = 'following'::text))),
    CONSTRAINT follow_reason_check CHECK ((reason = ANY (ARRAY['explicit'::text, 'library'::text, 'membership'::text]))),
    CONSTRAINT follow_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT follow_state_check CHECK ((state = ANY (ARRAY['following'::text, 'unfollowed'::text]))),
    CONSTRAINT follow_target_type_check CHECK ((target_type = ANY (ARRAY['subject'::text, 'collection'::text, 'space'::text])))
);


--
-- Name: follow_count_account_signal; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_account_signal (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    event_id text NOT NULL
);


--
-- Name: follow_count_account_work; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_account_work (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    after_id uuid,
    scan_complete boolean DEFAULT false NOT NULL,
    oldest_pending_at timestamp with time zone NOT NULL,
    CONSTRAINT follow_count_account_work_revision_check CHECK ((revision > 0))
);


--
-- Name: follow_count_destination; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_destination (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    target_type text NOT NULL,
    original_id uuid NOT NULL,
    destination_route integer NOT NULL,
    destination_id uuid NOT NULL
);


--
-- Name: follow_count_health; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_health (
    node integer NOT NULL,
    sampled_at timestamp with time zone,
    oldest_pending_at timestamp with time zone,
    members integer DEFAULT 0 NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    CONSTRAINT follow_count_health_members_check CHECK ((members >= 0)),
    CONSTRAINT follow_count_health_node_check CHECK (((node >= 0) AND (node <= 4368)))
);


--
-- Name: follow_count_owner; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_owner (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    observed_live_count bigint DEFAULT 0 NOT NULL,
    bootstrap_complete boolean DEFAULT false NOT NULL,
    bootstrap_after uuid,
    bootstrap_upper uuid,
    bootstrap_started boolean DEFAULT false NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    CONSTRAINT follow_count_owner_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT follow_count_owner_observed_live_count_check CHECK ((observed_live_count >= 0)),
    CONSTRAINT follow_count_owner_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE follow_count_owner; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.follow_count_owner IS 'Private source coverage, not a disclosed total. Missing or bootstrap_complete=false is unready. observed_live_count counts following pairs represented in follow_count_source only. No writer or reader here completes bootstrap.';


--
-- Name: follow_count_pair; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_pair (
    route integer NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    account_id uuid NOT NULL,
    original_id uuid NOT NULL,
    revision bigint NOT NULL,
    eligible boolean NOT NULL,
    CONSTRAINT follow_count_pair_revision_check CHECK ((revision > 0))
);


--
-- Name: follow_count_partition; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_partition (
    partition_no integer NOT NULL,
    owner_route integer,
    owner_id uuid,
    discovery_started boolean DEFAULT false NOT NULL,
    upper_route integer,
    upper_owner uuid,
    opened boolean DEFAULT false NOT NULL,
    source_complete boolean DEFAULT false NOT NULL,
    target_kind integer DEFAULT 0 NOT NULL,
    target_after uuid,
    target_route integer,
    target_upper_route integer,
    target_upper uuid,
    target_started boolean DEFAULT false NOT NULL,
    sampled_at timestamp with time zone,
    oldest_pending_at timestamp with time zone,
    CONSTRAINT follow_count_partition_target_kind_check CHECK (((target_kind >= 0) AND (target_kind <= 3)))
);


--
-- Name: follow_count_source; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_source (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    revision bigint NOT NULL,
    source_following boolean NOT NULL,
    desired_eligible boolean NOT NULL,
    pending_since timestamp with time zone,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    CONSTRAINT follow_count_source_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT follow_count_source_check1 CHECK (((NOT desired_eligible) OR source_following)),
    CONSTRAINT follow_count_source_revision_check CHECK ((revision > 0)),
    CONSTRAINT follow_count_source_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT follow_count_source_target_type_check CHECK ((target_type = ANY (ARRAY['subject'::text, 'collection'::text, 'space'::text])))
);


--
-- Name: TABLE follow_count_source; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.follow_count_source IS 'Current replacement per original, never a second graph or permission. Revision 1 is first observation, not legacy version zero. Retain negative rows and revisions until fenced terminal withdrawal and erasure. Delivery must reread current native account/follow under the account writer barrier.';


--
-- Name: follow_count_support; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_support (
    route integer NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    account_id uuid NOT NULL,
    support bigint NOT NULL,
    CONSTRAINT follow_count_support_support_check CHECK ((support >= 0))
);


--
-- Name: follow_count_terminal_follower; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_terminal_follower (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    CONSTRAINT follow_count_terminal_follower_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: follow_count_terminal_source; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_terminal_source (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    local_complete boolean DEFAULT false NOT NULL,
    oldest_pending_at timestamp with time zone,
    CONSTRAINT follow_count_terminal_source_check CHECK ((local_complete OR (oldest_pending_at IS NOT NULL)))
);


--
-- Name: follow_count_total; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow_count_total (
    route integer NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    total bigint DEFAULT 0 NOT NULL,
    CONSTRAINT follow_count_total_target_type_check CHECK ((target_type = ANY (ARRAY['subject'::text, 'collection'::text, 'space'::text]))),
    CONSTRAINT follow_count_total_total_check CHECK ((total >= 0))
);


--
-- Name: identity_epoch_participant_work; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.identity_epoch_participant_work (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    effect_key text NOT NULL,
    original uuid NOT NULL,
    owner_id uuid NOT NULL,
    role text NOT NULL,
    receiving_partition integer NOT NULL,
    receiving_epoch integer NOT NULL,
    receiving_position bigint NOT NULL,
    receiving_transaction_id uuid CONSTRAINT identity_epoch_participant_wo_receiving_transaction_id_not_null NOT NULL,
    custodied boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_participant_work_check CHECK ((partition_no = (((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)) >> 4))),
    CONSTRAINT identity_epoch_participant_work_check1 CHECK ((receiving_partition = partition_no)),
    CONSTRAINT identity_epoch_participant_work_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT identity_epoch_participant_work_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_epoch_participant_work_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_participant_work_receiving_epoch_check CHECK ((receiving_epoch > 0)),
    CONSTRAINT identity_epoch_participant_work_receiving_partition_check CHECK (((receiving_partition >= 0) AND (receiving_partition <= 4095))),
    CONSTRAINT identity_epoch_participant_work_receiving_position_check CHECK ((receiving_position > 0)),
    CONSTRAINT identity_epoch_participant_work_role_check CHECK ((role = ANY (ARRAY['member'::text, 'entry'::text, 'label'::text, 'session'::text, 'copy'::text, 'output'::text])))
);


--
-- Name: identity_epoch_source_basis; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.identity_epoch_source_basis (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    effect_key text NOT NULL,
    source_route integer NOT NULL,
    source_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    ready_generation uuid,
    ready_basis text,
    working_generation uuid,
    working_basis text,
    CONSTRAINT identity_epoch_source_basis_check CHECK (((ready_generation IS NULL) = (ready_basis IS NULL))),
    CONSTRAINT identity_epoch_source_basis_check1 CHECK (((working_generation IS NULL) = (working_basis IS NULL))),
    CONSTRAINT identity_epoch_source_basis_check2 CHECK ((source_route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT identity_epoch_source_basis_check3 CHECK ((partition_no = (source_route >> 4))),
    CONSTRAINT identity_epoch_source_basis_check4 CHECK ((partition_no = (((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)) >> 4))),
    CONSTRAINT identity_epoch_source_basis_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT identity_epoch_source_basis_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_epoch_source_basis_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_source_basis_ready_basis_check CHECK (((octet_length(ready_basis) >= 1) AND (octet_length(ready_basis) <= 256))),
    CONSTRAINT identity_epoch_source_basis_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535))),
    CONSTRAINT identity_epoch_source_basis_working_basis_check CHECK (((octet_length(working_basis) >= 1) AND (octet_length(working_basis) <= 256)))
);


--
-- Name: identity_scope_effect; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.identity_scope_effect (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    plan_key text NOT NULL,
    effect_key text NOT NULL COLLATE pg_catalog."C",
    disposition text NOT NULL COLLATE pg_catalog."C",
    original uuid NOT NULL,
    operation jsonb NOT NULL,
    CONSTRAINT identity_scope_effect_disposition_check CHECK ((disposition = ANY (ARRAY['OLD'::text, 'NEW'::text, 'first-apply'::text, 'handoff'::text]))),
    CONSTRAINT identity_scope_effect_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT identity_scope_effect_operation_check CHECK ((octet_length((operation)::text) <= 4096))
);


--
-- Name: identity_scope_plan; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.identity_scope_plan (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    plan_key text NOT NULL,
    account_id uuid NOT NULL,
    source_identity jsonb NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope text NOT NULL COLLATE pg_catalog."C",
    generation uuid NOT NULL,
    capture_id uuid NOT NULL,
    capture_frontier jsonb NOT NULL,
    collection_fence bigint NOT NULL,
    account_fence bigint NOT NULL,
    job_transaction_id uuid NOT NULL,
    scope_digest text NOT NULL,
    job_writer_fence jsonb NOT NULL,
    phase text NOT NULL,
    driver text NOT NULL,
    after_subject uuid,
    after_fact uuid,
    version bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'building'::text NOT NULL,
    old_head uuid,
    old_state jsonb,
    frontier jsonb NOT NULL,
    seal_transaction_id uuid,
    CONSTRAINT identity_scope_plan_capture_frontier_check CHECK ((octet_length((capture_frontier)::text) <= 2048)),
    CONSTRAINT identity_scope_plan_check CHECK (((after_subject IS NULL) = (after_fact IS NULL))),
    CONSTRAINT identity_scope_plan_check1 CHECK (((state <> 'sealed'::text) OR (seal_transaction_id IS NOT NULL))),
    CONSTRAINT identity_scope_plan_check2 CHECK (((state <> 'sealed'::text) OR ((driver = 'done'::text) AND (phase = 'raw'::text)))),
    CONSTRAINT identity_scope_plan_driver_check CHECK ((driver = ANY (ARRAY['member'::text, 'entry'::text, 'label'::text, 'session'::text, 'copy'::text, 'output'::text, 'done'::text]))),
    CONSTRAINT identity_scope_plan_frontier_check CHECK ((octet_length((frontier)::text) <= 2048)),
    CONSTRAINT identity_scope_plan_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_scope_plan_job_writer_fence_check CHECK ((octet_length((job_writer_fence)::text) <= 2048)),
    CONSTRAINT identity_scope_plan_phase_check CHECK ((phase = ANY (ARRAY['old-references'::text, 'old-ready'::text, 'old-working'::text, 'raw'::text]))),
    CONSTRAINT identity_scope_plan_plan_key_check CHECK ((octet_length(plan_key) = 64)),
    CONSTRAINT identity_scope_plan_scope_check CHECK (((octet_length(scope) >= 1) AND (octet_length(scope) <= 256))),
    CONSTRAINT identity_scope_plan_source_identity_check CHECK ((octet_length((source_identity)::text) <= 2048)),
    CONSTRAINT identity_scope_plan_state_check CHECK ((state = ANY (ARRAY['building'::text, 'sealed'::text, 'invalidated'::text]))),
    CONSTRAINT identity_scope_plan_version_check CHECK ((version >= 0))
);


--
-- Name: identity_scope_seal; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.identity_scope_seal (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    plan_key text NOT NULL,
    generation uuid NOT NULL,
    version bigint NOT NULL,
    frontier jsonb NOT NULL,
    capture_frontier jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_scope_seal_capture_frontier_check CHECK ((octet_length((capture_frontier)::text) <= 2048)),
    CONSTRAINT identity_scope_seal_frontier_check CHECK ((octet_length((frontier)::text) <= 2048))
);


--
-- Name: label_assignment; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.label_assignment (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    label_id uuid NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    assignment_id uuid DEFAULT gen_random_uuid(),
    slot_no smallint,
    CONSTRAINT label_assignment_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT label_assignment_check1 CHECK (((deleted_at IS NULL) = (purge_after IS NULL))),
    CONSTRAINT label_assignment_check2 CHECK ((purge_after = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT label_assignment_deleted_slot CHECK (((deleted_at IS NULL) OR (slot_no IS NULL))),
    CONSTRAINT label_assignment_reserved_identity CHECK (((slot_no IS NULL) OR (assignment_id IS NOT NULL))),
    CONSTRAINT label_assignment_revision_check CHECK ((revision >= 1)),
    CONSTRAINT label_assignment_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT label_assignment_slot_range CHECK (((slot_no IS NULL) OR ((slot_no >= 0) AND (slot_no <= 31))))
);


--
-- Name: library_export; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.library_export (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    export_id uuid NOT NULL,
    generation bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text NOT NULL,
    CONSTRAINT library_export_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT library_export_check1 CHECK ((expires_at = (created_at + '00:15:00'::interval))),
    CONSTRAINT library_export_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT library_export_state_check CHECK ((state = ANY (ARRAY['collecting'::text, 'ready'::text, 'stale'::text, 'cancelled'::text, 'expired'::text, 'limit'::text])))
);


--
-- Name: list_import_anilist; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.list_import_anilist (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    import_id uuid NOT NULL,
    ordinal integer NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT list_import_anilist_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT list_import_anilist_check1 CHECK ((route = ((get_byte(uuid_send(import_id), 10) * 256) + get_byte(uuid_send(import_id), 11)))),
    CONSTRAINT list_import_anilist_ordinal_check CHECK (((ordinal >= '-1'::integer) AND (ordinal <= 199))),
    CONSTRAINT list_import_anilist_payload_check CHECK ((octet_length((payload)::text) <= 4194304)),
    CONSTRAINT list_import_anilist_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: list_import_mal; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.list_import_mal (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    id uuid NOT NULL,
    document jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT list_import_mal_document_check CHECK ((octet_length((document)::text) <= 12582912)),
    CONSTRAINT list_import_mal_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: members_preparation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.members_preparation (
    route integer NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    canonical_basis text NOT NULL,
    basis_digest bytea NOT NULL,
    state text NOT NULL,
    last_read_at timestamp with time zone NOT NULL,
    workflow_id text NOT NULL,
    progress_version bigint DEFAULT 0 NOT NULL,
    checkpoint text,
    observation text,
    source_incarnation text,
    source_generation text,
    reserved_incarnation text NOT NULL,
    reserved_generation text NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    result_count integer DEFAULT 0 NOT NULL,
    failure_code text,
    next_position bigint DEFAULT 0 NOT NULL,
    source_exhausted boolean DEFAULT false NOT NULL,
    original_custody_id uuid,
    original_transaction_id uuid,
    original_epoch integer,
    original_generation bigint,
    original_position bigint,
    selected_workflow_id text,
    selected_function_id integer,
    CONSTRAINT members_preparation_basis_digest_check CHECK ((octet_length(basis_digest) = 32)),
    CONSTRAINT members_preparation_canonical_basis_check CHECK ((octet_length(canonical_basis) <= 196608)),
    CONSTRAINT members_preparation_check CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT members_preparation_check1 CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT members_preparation_check2 CHECK ((route = ((get_byte(uuid_send(episode_id), 10) * 256) + get_byte(uuid_send(episode_id), 11)))),
    CONSTRAINT members_preparation_check3 CHECK (((complete = false) OR (failure_code IS NULL))),
    CONSTRAINT members_preparation_progress_version_check CHECK ((progress_version >= 0)),
    CONSTRAINT members_preparation_reserved_generation_check CHECK ((octet_length(reserved_generation) <= 256)),
    CONSTRAINT members_preparation_reserved_generation_check1 CHECK ((octet_length(reserved_generation) <= 256)),
    CONSTRAINT members_preparation_reserved_incarnation_check CHECK ((octet_length(reserved_incarnation) <= 256)),
    CONSTRAINT members_preparation_reserved_incarnation_check1 CHECK ((octet_length(reserved_incarnation) <= 256)),
    CONSTRAINT members_preparation_result_count_check CHECK ((result_count >= 0)),
    CONSTRAINT members_preparation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT members_preparation_runtime_checkpoint_check CHECK ((octet_length(checkpoint) <= 4096)),
    CONSTRAINT members_preparation_runtime_failure_check CHECK ((failure_code = ANY (ARRAY['dependency_unavailable'::text, 'failed'::text]))),
    CONSTRAINT members_preparation_runtime_function_check CHECK (((selected_function_id >= 0) AND (selected_function_id <= 63))),
    CONSTRAINT members_preparation_runtime_observation_check CHECK ((octet_length(observation) <= 4096)),
    CONSTRAINT members_preparation_runtime_original_check CHECK ((((original_custody_id IS NULL) AND (original_transaction_id IS NULL) AND (original_epoch IS NULL) AND (original_generation IS NULL) AND (original_position IS NULL)) OR ((original_custody_id IS NOT NULL) AND (original_transaction_id IS NOT NULL) AND (original_epoch IS NOT NULL) AND (original_generation IS NOT NULL) AND (original_position IS NOT NULL) AND (original_generation > 0) AND (original_position > 0)))),
    CONSTRAINT members_preparation_runtime_position_check CHECK ((next_position >= 0)),
    CONSTRAINT members_preparation_runtime_selected_check CHECK (((selected_workflow_id IS NULL) = (selected_function_id IS NULL))),
    CONSTRAINT members_preparation_runtime_source_check CHECK (((source_incarnation IS NULL) = (source_generation IS NULL))),
    CONSTRAINT members_preparation_runtime_workflow_check CHECK ((octet_length(selected_workflow_id) <= 256)),
    CONSTRAINT members_preparation_source_incarnation_check CHECK (((source_incarnation IS NULL) OR (octet_length(source_incarnation) <= 256))),
    CONSTRAINT members_preparation_state_check CHECK ((state = ANY (ARRAY['live'::text, 'retired'::text])))
);


--
-- Name: TABLE members_preparation; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.members_preparation IS 'Private disposable filter preparation. canonical_basis is retained exactly beside its lookup digest. A header, workflow status, or selected History result is not Source, authorization, or disclosure authority.';


--
-- Name: members_preparation_owner; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.members_preparation_owner (
    route integer NOT NULL,
    owner_account_id uuid NOT NULL,
    live_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT members_preparation_owner_check CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT members_preparation_owner_live_count_check CHECK (((live_count >= 0) AND (live_count <= 32))),
    CONSTRAINT members_preparation_owner_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE members_preparation_owner; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.members_preparation_owner IS 'Maintained per-owner live episode quota and LRU serialization point. live_count is changed only with episode admission or retirement; it is never reconstructed from result/history rows.';


--
-- Name: members_preparation_result; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.members_preparation_result (
    route integer NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    sort_key text NOT NULL,
    "position" bigint,
    CONSTRAINT members_preparation_result_check CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT members_preparation_result_check1 CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT members_preparation_result_check2 CHECK ((route = ((get_byte(uuid_send(episode_id), 10) * 256) + get_byte(uuid_send(episode_id), 11)))),
    CONSTRAINT members_preparation_result_check3 CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT members_preparation_result_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT members_preparation_result_runtime_position_check CHECK (("position" > 0))
);


--
-- Name: TABLE members_preparation_result; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.members_preparation_result IS 'Private derived output candidates. Rows remain subordinate to the current header and actual Source; ordinary disclosure is revalidated before use.';


--
-- Name: native_public_output_binding; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_public_output_binding (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    incarnation text NOT NULL,
    output_generation uuid NOT NULL,
    activation_transaction_id uuid NOT NULL,
    activation_position bigint NOT NULL,
    activation_source_generation bigint CONSTRAINT native_public_output_bindin_activation_source_generati_not_null NOT NULL,
    owner_epoch integer NOT NULL,
    accepted_position bigint NOT NULL,
    accepted_transaction_id uuid NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    receiving_epoch bigint NOT NULL,
    effect_key text NOT NULL,
    definition_digest text NOT NULL,
    binding_digest text NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT native_public_output_binding_accepted_position_check CHECK ((accepted_position > 0)),
    CONSTRAINT native_public_output_binding_activation_position_check CHECK ((activation_position > 0)),
    CONSTRAINT native_public_output_binding_activation_source_generation_check CHECK ((activation_source_generation > 0)),
    CONSTRAINT native_public_output_binding_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT native_public_output_binding_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT native_public_output_binding_definition_digest_check CHECK ((definition_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT native_public_output_binding_effect_key_check CHECK ((length(effect_key) = 64)),
    CONSTRAINT native_public_output_binding_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT native_public_output_binding_payload_check CHECK ((octet_length((payload)::text) <= 4096)),
    CONSTRAINT native_public_output_binding_receiving_epoch_check CHECK ((receiving_epoch = 1)),
    CONSTRAINT native_public_output_binding_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: native_public_output_hold; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_public_output_hold (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    role text NOT NULL,
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    incarnation text NOT NULL,
    output_generation uuid NOT NULL,
    activation_transaction_id uuid NOT NULL,
    activation_position bigint NOT NULL,
    activation_source_generation bigint NOT NULL,
    transaction_id uuid NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    consumed_by uuid,
    CONSTRAINT native_public_output_hold_role_check CHECK ((role = ANY (ARRAY['predecessor'::text, 'successor'::text])))
);


--
-- Name: native_public_output_receiving; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_public_output_receiving (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    receiving_epoch bigint NOT NULL,
    state text NOT NULL,
    transaction_id uuid,
    CONSTRAINT native_public_output_receiving_receiving_epoch_check CHECK ((receiving_epoch > 0)),
    CONSTRAINT native_public_output_receiving_state_check CHECK ((state = ANY (ARRAY['open'::text, 'applied'::text, 'cancelled'::text])))
);


--
-- Name: native_public_output_transition; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_public_output_transition (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    binding_digest text NOT NULL,
    kind text NOT NULL,
    successor_hold_id uuid,
    cancellation_epoch bigint,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid NOT NULL,
    purpose text NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT native_public_output_transition_check CHECK ((((kind = 'applied'::text) AND (successor_hold_id IS NOT NULL) AND (successor_hold_id <> hold_id) AND (cancellation_epoch IS NULL) AND (purpose = 'identity-public-output-applied'::text)) OR ((kind = 'cancelled'::text) AND (successor_hold_id IS NULL) AND (cancellation_epoch > 1) AND (purpose = 'identity-public-output-cancelled'::text)))),
    CONSTRAINT native_public_output_transition_kind_check CHECK ((kind = ANY (ARRAY['applied'::text, 'cancelled'::text]))),
    CONSTRAINT native_public_output_transition_payload_check CHECK ((octet_length((payload)::text) <= 8192)),
    CONSTRAINT native_public_output_transition_position_check CHECK (("position" > 0)),
    CONSTRAINT native_public_output_transition_purpose_check CHECK ((purpose = ANY (ARRAY['identity-public-output-applied'::text, 'identity-public-output-cancelled'::text])))
);


--
-- Name: native_source_capture; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_source_capture (
    route integer NOT NULL,
    capture_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    incarnation text NOT NULL,
    generation bigint NOT NULL,
    scope text NOT NULL,
    owner_epoch integer NOT NULL,
    receiving_epoch bigint NOT NULL,
    effect_key text NOT NULL,
    collection_fence bigint NOT NULL,
    account_fence bigint NOT NULL,
    driver text NOT NULL,
    after_key text DEFAULT ''::text NOT NULL,
    tie text DEFAULT ''::text NOT NULL,
    session_id uuid,
    scanned bigint DEFAULT 0 NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    output_generation uuid,
    publication_transaction_id uuid,
    publication_position bigint,
    CONSTRAINT native_source_capture_after_key_check CHECK ((octet_length(after_key) <= 512)),
    CONSTRAINT native_source_capture_driver_check CHECK ((driver = ANY (ARRAY['member'::text, 'entry'::text, 'entry_deleted'::text, 'label'::text, 'assignment'::text, 'session'::text, 'unit'::text, 'change'::text, 'copy'::text, 'output'::text, 'done'::text]))),
    CONSTRAINT native_source_capture_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT native_source_capture_generation_check CHECK ((generation >= 0)),
    CONSTRAINT native_source_capture_incarnation_check CHECK ((octet_length(incarnation) <= 128)),
    CONSTRAINT native_source_capture_output_binding CHECK ((((scope = 'active_explicit_output'::text) AND (output_generation IS NOT NULL) AND (publication_transaction_id IS NOT NULL) AND (publication_position IS NOT NULL) AND (publication_position > 0)) OR ((scope <> 'active_explicit_output'::text) AND (output_generation IS NULL) AND (publication_transaction_id IS NULL) AND (publication_position IS NULL)))),
    CONSTRAINT native_source_capture_receiving_epoch_check CHECK ((receiving_epoch > 0)),
    CONSTRAINT native_source_capture_scanned_check CHECK ((scanned >= 0)),
    CONSTRAINT native_source_capture_scope_check CHECK ((scope = ANY (ARRAY['curated'::text, 'private_builtin'::text, 'active_explicit_output'::text]))),
    CONSTRAINT native_source_capture_tie_check CHECK ((octet_length(tie) <= 64)),
    CONSTRAINT native_source_capture_version_check CHECK ((version >= 0))
);


--
-- Name: native_source_fence; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_source_fence (
    route integer NOT NULL,
    kind text NOT NULL,
    owner_id uuid NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    account_id uuid,
    CONSTRAINT native_source_fence_generation_check CHECK ((generation >= 0)),
    CONSTRAINT native_source_fence_kind_check CHECK ((kind = ANY (ARRAY['collection'::text, 'account'::text]))),
    CONSTRAINT native_source_fence_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: native_source_hold; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_source_hold (
    route integer NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    released boolean DEFAULT false NOT NULL
);


--
-- Name: native_source_receipt; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.native_source_receipt (
    route integer NOT NULL,
    capture_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT native_source_receipt_position_check CHECK (("position" > 0))
);


--
-- Name: owner_identity_scope; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_identity_scope (
    partition_no integer NOT NULL,
    original uuid NOT NULL,
    source_id uuid NOT NULL,
    incarnation text NOT NULL,
    role text NOT NULL,
    owner_id uuid NOT NULL,
    source_route integer NOT NULL,
    CONSTRAINT owner_identity_scope_check CHECK ((source_route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT owner_identity_scope_check1 CHECK ((partition_no = (source_route >> 4))),
    CONSTRAINT owner_identity_scope_check2 CHECK ((partition_no = (((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)) >> 4))),
    CONSTRAINT owner_identity_scope_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT owner_identity_scope_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT owner_identity_scope_role_check CHECK ((role = ANY (ARRAY['member'::text, 'entry'::text, 'label'::text, 'session'::text, 'copy'::text, 'output'::text]))),
    CONSTRAINT owner_identity_scope_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535)))
);


--
-- Name: owner_index_control; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_index_control (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    phase text DEFAULT 'entry'::text NOT NULL,
    after_subject uuid,
    after_fact uuid,
    chronology_ready boolean DEFAULT false NOT NULL,
    activity_after_subject uuid,
    CONSTRAINT owner_index_control_check CHECK (((after_subject IS NULL) = (after_fact IS NULL))),
    CONSTRAINT owner_index_control_check1 CHECK (((phase <> 'ready'::text) OR (after_subject IS NULL))),
    CONSTRAINT owner_index_control_check2 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT owner_index_control_phase_check CHECK ((phase = ANY (ARRAY['entry'::text, 'session'::text, 'copy'::text, 'label'::text, 'ready'::text]))),
    CONSTRAINT owner_index_control_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: owner_index_label_repair; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_index_label_repair (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    label_id uuid NOT NULL,
    after_subject uuid
);


--
-- Name: owner_index_pin; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_index_pin (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    pin jsonb NOT NULL,
    meaning_ready boolean DEFAULT false NOT NULL
);


--
-- Name: owner_index_state; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_index_state (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    pin jsonb NOT NULL,
    collection_id uuid NOT NULL,
    labels jsonb NOT NULL
);


--
-- Name: owner_member_index; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_member_index (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    activity_at timestamp with time zone,
    activity_unknown boolean DEFAULT true NOT NULL,
    CONSTRAINT owner_member_index_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT owner_member_index_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: owner_member_support; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_member_support (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    family text NOT NULL,
    pin jsonb NOT NULL,
    CONSTRAINT owner_member_support_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT owner_member_support_family_check CHECK ((family = ANY (ARRAY['entry'::text, 'label'::text, 'session'::text, 'copy'::text]))),
    CONSTRAINT owner_member_support_pin_check CHECK (((pin = '{}'::jsonb) OR library.library_profile_pin_valid(pin))),
    CONSTRAINT owner_member_support_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: owner_write_counter; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.owner_write_counter (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    seq bigint NOT NULL,
    CONSTRAINT owner_write_counter_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT owner_write_counter_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT owner_write_counter_seq_check CHECK ((seq >= 0))
);


--
-- Name: personal_label; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.personal_label (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    label_id uuid NOT NULL,
    normalized_name text NOT NULL COLLATE pg_catalog."C",
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    CONSTRAINT personal_label_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT personal_label_check1 CHECK (((deleted_at IS NULL) = (purge_after IS NULL))),
    CONSTRAINT personal_label_check2 CHECK ((purge_after = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT personal_label_normalized_name_check CHECK (((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 100))),
    CONSTRAINT personal_label_revision_check CHECK ((revision >= 1)),
    CONSTRAINT personal_label_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_change; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_change (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    change_no integer NOT NULL,
    intent jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT progress_change_change_no_check CHECK ((change_no >= 1)),
    CONSTRAINT progress_change_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_change_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_head (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    CONSTRAINT progress_head_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT progress_head_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_session; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_session (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    version_subject_id uuid,
    mode text NOT NULL,
    unit text NOT NULL,
    total numeric,
    amount numeric,
    locator text,
    "position" numeric,
    completed_unit_count integer NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    transaction_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    library_profile_pin jsonb,
    additional_measures jsonb DEFAULT '[]'::jsonb NOT NULL,
    journal_revision integer DEFAULT 0 NOT NULL,
    journal_start_year integer,
    journal_start_month smallint,
    journal_start_day smallint,
    journal_finish_year integer,
    journal_finish_month smallint,
    journal_finish_day smallint,
    journal_reflection text,
    reported_year_initialized boolean DEFAULT false NOT NULL,
    CONSTRAINT progress_session_additional_measures_check CHECK (
CASE
    WHEN (jsonb_typeof(additional_measures) = 'array'::text) THEN ((jsonb_array_length(additional_measures) <= 7) AND (octet_length((additional_measures)::text) <= 4096) AND ((mode = 'scalar_amount'::text) OR (additional_measures = '[]'::jsonb)))
    ELSE false
END),
    CONSTRAINT progress_session_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT progress_session_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_session_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT progress_session_check3 CHECK (((state = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT progress_session_check4 CHECK ((((mode = 'scalar_amount'::text) AND (locator IS NULL) AND ("position" IS NULL) AND (completed_unit_count = 0)) OR ((mode = 'cursor_position'::text) AND (amount IS NULL) AND (total IS NULL) AND (completed_unit_count = 0) AND (((locator IS NULL) AND ("position" IS NULL)) OR ((locator IS NOT NULL) AND ("position" IS NOT NULL)))) OR ((mode = 'completed_units'::text) AND (amount IS NULL) AND (total IS NULL) AND (locator IS NULL) AND ("position" IS NULL)))),
    CONSTRAINT progress_session_completed_unit_count_check CHECK (((completed_unit_count >= 0) AND (completed_unit_count <= 20000))),
    CONSTRAINT progress_session_journal_finish_date_check CHECK ((((journal_finish_year IS NULL) AND (journal_finish_month IS NULL) AND (journal_finish_day IS NULL)) OR ((journal_finish_year IS NOT NULL) AND ((journal_finish_year >= 1) AND (journal_finish_year <= 9999)) AND ((journal_finish_month IS NULL) OR ((journal_finish_month >= 1) AND (journal_finish_month <= 12))) AND ((journal_finish_day IS NULL) OR ((journal_finish_month IS NOT NULL) AND ((journal_finish_day >= 1) AND (journal_finish_day <=
CASE
    WHEN (journal_finish_month = 2) THEN
    CASE
        WHEN (((journal_finish_year % 400) = 0) OR (((journal_finish_year % 4) = 0) AND ((journal_finish_year % 100) <> 0))) THEN 29
        ELSE 28
    END
    WHEN (journal_finish_month = ANY (ARRAY[4, 6, 9, 11])) THEN 30
    ELSE 31
END))))))),
    CONSTRAINT progress_session_journal_reflection_check CHECK (((journal_reflection IS NULL) OR ((char_length(journal_reflection) <= 2000) AND (octet_length(journal_reflection) <= 4096)))),
    CONSTRAINT progress_session_journal_revision_check CHECK (((journal_revision >= 0) AND (journal_revision <= 2147483646))),
    CONSTRAINT progress_session_journal_start_date_check CHECK ((((journal_start_year IS NULL) AND (journal_start_month IS NULL) AND (journal_start_day IS NULL)) OR ((journal_start_year IS NOT NULL) AND ((journal_start_year >= 1) AND (journal_start_year <= 9999)) AND ((journal_start_month IS NULL) OR ((journal_start_month >= 1) AND (journal_start_month <= 12))) AND ((journal_start_day IS NULL) OR ((journal_start_month IS NOT NULL) AND ((journal_start_day >= 1) AND (journal_start_day <=
CASE
    WHEN (journal_start_month = 2) THEN
    CASE
        WHEN (((journal_start_year % 400) = 0) OR (((journal_start_year % 4) = 0) AND ((journal_start_year % 100) <> 0))) THEN 29
        ELSE 28
    END
    WHEN (journal_start_month = ANY (ARRAY[4, 6, 9, 11])) THEN 30
    ELSE 31
END))))))),
    CONSTRAINT progress_session_library_profile_pin_check CHECK (((library_profile_pin IS NULL) OR library.library_profile_pin_valid(library_profile_pin))),
    CONSTRAINT progress_session_locator_check CHECK (((locator IS NULL) OR ((char_length(locator) >= 1) AND (char_length(locator) <= 256)))),
    CONSTRAINT progress_session_mode_check CHECK ((mode = ANY (ARRAY['scalar_amount'::text, 'cursor_position'::text, 'completed_units'::text]))),
    CONSTRAINT progress_session_position_check CHECK ((("position" IS NULL) OR ("position" >= (0)::numeric))),
    CONSTRAINT progress_session_revision_check CHECK ((revision >= 1)),
    CONSTRAINT progress_session_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT progress_session_state_check CHECK ((state = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text]))),
    CONSTRAINT progress_session_total_check CHECK (((total IS NULL) OR (total >= (0)::numeric)))
);


--
-- Name: progress_unit; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_unit (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    unit_id text NOT NULL,
    added_at timestamp with time zone NOT NULL,
    CONSTRAINT progress_unit_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_unit_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT progress_unit_unit_id_check CHECK (((char_length(unit_id) >= 1) AND (char_length(unit_id) <= 128)))
);


--
-- Name: published_log; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.published_log (
    route integer NOT NULL,
    log_id uuid NOT NULL,
    account_id uuid,
    session_id uuid,
    subject_id uuid,
    session_state text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    note text,
    published_at timestamp with time zone,
    transaction_id uuid,
    revision integer DEFAULT 1 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    deletion_id uuid,
    deleted_at timestamp with time zone,
    restore_until timestamp with time zone,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    CONSTRAINT published_log_check CHECK ((route = ((get_byte(uuid_send(log_id), 10) * 256) + get_byte(uuid_send(log_id), 11)))),
    CONSTRAINT published_log_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT published_log_check2 CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT published_log_check3 CHECK (((session_state = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT published_log_episode CHECK ((((NOT deleted) AND (deletion_id IS NULL) AND (deleted_at IS NULL) AND (restore_until IS NULL)) OR (deleted AND (deletion_id IS NOT NULL) AND (deleted_at IS NOT NULL) AND (restore_until = (deleted_at + '720:00:00'::interval))) OR (deleted AND (account_id IS NULL) AND (deletion_id IS NULL) AND (deleted_at IS NULL) AND (restore_until IS NULL)))),
    CONSTRAINT published_log_note_check CHECK (((note IS NULL) OR ((char_length(note) >= 0) AND (char_length(note) <= 1000)))),
    CONSTRAINT published_log_payload CHECK ((((account_id IS NOT NULL) AND (subject_id IS NOT NULL) AND (session_state IS NOT NULL) AND (started_at IS NOT NULL) AND (published_at IS NOT NULL) AND (transaction_id IS NOT NULL)) OR (deleted AND (account_id IS NULL) AND (session_id IS NULL) AND (subject_id IS NULL) AND (session_state IS NULL) AND (started_at IS NULL) AND (completed_at IS NULL) AND (note IS NULL) AND (published_at IS NULL) AND (transaction_id IS NULL)))),
    CONSTRAINT published_log_revision_check CHECK (((revision >= 1) AND (revision <= 2147483646))),
    CONSTRAINT published_log_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT published_log_session_state_check CHECK ((session_state = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: reported_year_bucket; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.reported_year_bucket (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    year integer NOT NULL,
    bucket smallint NOT NULL,
    completed bigint NOT NULL,
    subjects bigint NOT NULL,
    unknown_profile bigint NOT NULL,
    month_precision bigint NOT NULL,
    day_precision bigint NOT NULL,
    CONSTRAINT reported_year_bucket_bucket_check CHECK (((bucket >= 0) AND (bucket <= 13))),
    CONSTRAINT reported_year_bucket_check CHECK (((subjects >= 1) AND (subjects <= completed))),
    CONSTRAINT reported_year_bucket_check1 CHECK (((unknown_profile >= 0) AND (unknown_profile <= completed))),
    CONSTRAINT reported_year_bucket_check2 CHECK (((month_precision >= 0) AND (month_precision <= completed))),
    CONSTRAINT reported_year_bucket_check3 CHECK (((day_precision >= 0) AND (day_precision <= completed))),
    CONSTRAINT reported_year_bucket_completed_check CHECK ((completed > 0)),
    CONSTRAINT reported_year_bucket_year_check CHECK (((year >= 1) AND (year <= 9999)))
);


--
-- Name: reported_year_owner; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.reported_year_owner (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    initialized_sessions bigint NOT NULL,
    missing_finish bigint NOT NULL,
    unsupported_finish bigint NOT NULL,
    revision uuid NOT NULL,
    CONSTRAINT reported_year_owner_initialized_sessions_check CHECK ((initialized_sessions >= 0)),
    CONSTRAINT reported_year_owner_missing_finish_check CHECK ((missing_finish >= 0)),
    CONSTRAINT reported_year_owner_unsupported_finish_check CHECK ((unsupported_finish >= 0))
);


--
-- Name: reported_year_subject; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.reported_year_subject (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    year integer NOT NULL,
    bucket smallint NOT NULL,
    subject_id uuid NOT NULL,
    completed bigint NOT NULL,
    CONSTRAINT reported_year_subject_bucket_check CHECK (((bucket >= 0) AND (bucket <= 13))),
    CONSTRAINT reported_year_subject_completed_check CHECK ((completed > 0)),
    CONSTRAINT reported_year_subject_year_check CHECK (((year >= 1) AND (year <= 9999)))
);


--
-- Name: shelf_count; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_count (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    bucket text NOT NULL,
    type_id uuid NOT NULL,
    n bigint NOT NULL,
    generation_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    CONSTRAINT shelf_count_bucket_check CHECK ((bucket = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text, 'all'::text, 'collections'::text]))),
    CONSTRAINT shelf_count_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_count_check1 CHECK (((bucket <> 'collections'::text) OR (type_id = '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT shelf_count_n_check CHECK ((n >= 0)),
    CONSTRAINT shelf_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT shelf_count_safe_integer CHECK ((n <= '9007199254740991'::bigint))
);


--
-- Name: shelf_maintenance; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_maintenance (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    mode text DEFAULT 'open'::text NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL,
    active_generation uuid,
    run_id uuid,
    CONSTRAINT shelf_maintenance_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_maintenance_check1 CHECK (((NOT ready) OR (active_generation IS NOT NULL))),
    CONSTRAINT shelf_maintenance_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT shelf_maintenance_mode_check CHECK ((mode = ANY (ARRAY['open'::text, 'rebuilding'::text, 'purging'::text, 'purged'::text]))),
    CONSTRAINT shelf_maintenance_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: shelf_maintenance_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_maintenance_head (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    run_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    last_completed_at timestamp with time zone
);


--
-- Name: shelf_maintenance_run; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_maintenance_run (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    run_id uuid NOT NULL,
    epoch bigint NOT NULL,
    sequence bigint DEFAULT 0 NOT NULL,
    segment integer DEFAULT 0 NOT NULL,
    kind text NOT NULL,
    phase text NOT NULL,
    cursor jsonb DEFAULT '[]'::jsonb NOT NULL,
    build_generation uuid,
    enqueue_pending boolean DEFAULT true NOT NULL,
    enqueue_attempt bigint DEFAULT 0 NOT NULL,
    cancelled boolean DEFAULT false NOT NULL,
    CONSTRAINT shelf_maintenance_run_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_maintenance_run_cursor_check CHECK (((jsonb_typeof(cursor) = 'array'::text) AND (jsonb_array_length(cursor) <= 8) AND (octet_length((cursor)::text) <= 2048))),
    CONSTRAINT shelf_maintenance_run_enqueue_attempt_check CHECK ((enqueue_attempt >= 0)),
    CONSTRAINT shelf_maintenance_run_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT shelf_maintenance_run_kind_check CHECK ((kind = ANY (ARRAY['backfill'::text, 'counters'::text, 'purge'::text]))),
    CONSTRAINT shelf_maintenance_run_segment_check CHECK ((segment >= 0)),
    CONSTRAINT shelf_maintenance_run_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: shelf_maintenance_session; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_maintenance_session (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    run_id uuid NOT NULL,
    session_id uuid NOT NULL,
    last_changed_at timestamp with time zone
);


--
-- Name: shelf_maintenance_source; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_maintenance_source (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    run_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    incarnation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    source_id uuid NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    identity jsonb NOT NULL,
    origin_identity jsonb NOT NULL,
    reservation_id uuid,
    type_id uuid
);


--
-- Name: shelf_maintenance_step; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_maintenance_step (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    run_id uuid NOT NULL,
    epoch bigint NOT NULL,
    sequence bigint NOT NULL,
    segment integer NOT NULL,
    phase text NOT NULL,
    cursor jsonb NOT NULL,
    build_generation uuid,
    input_identity jsonb,
    CONSTRAINT shelf_maintenance_step_cursor_check CHECK (((jsonb_typeof(cursor) = 'array'::text) AND (jsonb_array_length(cursor) <= 8) AND (octet_length((cursor)::text) <= 2048))),
    CONSTRAINT shelf_maintenance_step_input_identity_check CHECK ((octet_length((input_identity)::text) <= 2048))
);


--
-- Name: shelf_type_node; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_node (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    node_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    chunk bytea NOT NULL,
    terminal_type_id uuid,
    CONSTRAINT shelf_type_node_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_node_chunk_length_check CHECK (((octet_length(chunk) >= 1) AND (octet_length(chunk) <= 256))),
    CONSTRAINT shelf_type_node_node_id_non_nil_check CHECK ((node_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_node_node_id_route_check CHECK ((route = ((get_byte(uuid_send(node_id), 10) * 256) + get_byte(uuid_send(node_id), 11)))),
    CONSTRAINT shelf_type_node_not_self_parent_check CHECK ((node_id <> parent_id)),
    CONSTRAINT shelf_type_node_parent_id_non_nil_check CHECK ((parent_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_node_parent_id_route_check CHECK ((route = ((get_byte(uuid_send(parent_id), 10) * 256) + get_byte(uuid_send(parent_id), 11)))),
    CONSTRAINT shelf_type_node_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT shelf_type_node_terminal_type_id_non_nil_check CHECK (((terminal_type_id IS NULL) OR (terminal_type_id <> '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT shelf_type_node_terminal_type_id_route_check CHECK (((terminal_type_id IS NULL) OR (route = ((get_byte(uuid_send(terminal_type_id), 10) * 256) + get_byte(uuid_send(terminal_type_id), 11)))))
);


--
-- Name: TABLE shelf_type_node; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_node IS 'Radix nodes and terminals are scoped by route and account_id and retained until explicit account erasure.';


--
-- Name: shelf_type_reservation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_reservation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    full_type text NOT NULL,
    digest bytea NOT NULL,
    candidate_type_id uuid NOT NULL,
    node_id uuid NOT NULL,
    byte_offset bigint NOT NULL,
    fence_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    input_bytes bytea,
    maintenance_run_id uuid,
    CONSTRAINT shelf_type_reservation_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_reservation_byte_offset_check CHECK (((byte_offset >= 0) AND (byte_offset <= octet_length(full_type)))),
    CONSTRAINT shelf_type_reservation_candidate_type_id_non_nil_check CHECK ((candidate_type_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_candidate_type_id_route_check CHECK ((route = ((get_byte(uuid_send(candidate_type_id), 10) * 256) + get_byte(uuid_send(candidate_type_id), 11)))),
    CONSTRAINT shelf_type_reservation_digest_length_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT shelf_type_reservation_fence_id_non_nil_check CHECK ((fence_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_fence_id_route_check CHECK ((route = ((get_byte(uuid_send(fence_id), 10) * 256) + get_byte(uuid_send(fence_id), 11)))),
    CONSTRAINT shelf_type_reservation_generation_id_non_nil_check CHECK ((generation_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_generation_id_route_check CHECK ((route = ((get_byte(uuid_send(generation_id), 10) * 256) + get_byte(uuid_send(generation_id), 11)))),
    CONSTRAINT shelf_type_reservation_id_non_nil_check CHECK ((reservation_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_id_route_check CHECK ((route = ((get_byte(uuid_send(reservation_id), 10) * 256) + get_byte(uuid_send(reservation_id), 11)))),
    CONSTRAINT shelf_type_reservation_node_id_non_nil_check CHECK ((node_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_node_id_route_check CHECK ((route = ((get_byte(uuid_send(node_id), 10) * 256) + get_byte(uuid_send(node_id), 11)))),
    CONSTRAINT shelf_type_reservation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);
ALTER TABLE ONLY library.shelf_type_reservation ALTER COLUMN input_bytes SET STORAGE EXTERNAL;


--
-- Name: TABLE shelf_type_reservation; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_reservation IS 'Staging reservations are scoped by route and account_id.';


--
-- Name: COLUMN shelf_type_reservation.input_bytes; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.shelf_type_reservation.input_bytes IS 'Immutable UTF8 bytes made from the same accepted ASCII input once. Historical NULL reservations cannot continue. Direct substring of this EXTERNAL datum bounds staging transfer without detoasting full text.';


--
-- Name: shelf_type_root; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_root (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    digest bytea NOT NULL,
    primary_type_id uuid NOT NULL,
    root_node_id uuid NOT NULL,
    CONSTRAINT shelf_type_root_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_root_digest_length_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT shelf_type_root_node_id_non_nil_check CHECK ((root_node_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_root_node_id_route_check CHECK ((route = ((get_byte(uuid_send(root_node_id), 10) * 256) + get_byte(uuid_send(root_node_id), 11)))),
    CONSTRAINT shelf_type_root_primary_type_id_non_nil_check CHECK ((primary_type_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_root_primary_type_id_route_check CHECK ((route = ((get_byte(uuid_send(primary_type_id), 10) * 256) + get_byte(uuid_send(primary_type_id), 11)))),
    CONSTRAINT shelf_type_root_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE shelf_type_root; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_root IS 'Digest roots are scoped by route and account_id and retained until explicit account erasure.';


--
-- Name: shelf_type_value; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_value (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    type_id uuid NOT NULL,
    full_type text NOT NULL,
    byte_length bigint NOT NULL,
    json_byte_length bigint NOT NULL,
    CONSTRAINT shelf_type_value_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_value_byte_length_check CHECK (((byte_length >= 0) AND (byte_length = octet_length(full_type)))),
    CONSTRAINT shelf_type_value_json_byte_length_check CHECK (((json_byte_length >= 0) AND (json_byte_length = octet_length((to_json(full_type))::text)))),
    CONSTRAINT shelf_type_value_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT shelf_type_value_type_id_non_nil_check CHECK ((type_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_value_type_id_route_check CHECK ((route = ((get_byte(uuid_send(type_id), 10) * 256) + get_byte(uuid_send(type_id), 11))))
);


--
-- Name: TABLE shelf_type_value; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_value IS 'Exact type identities are scoped by route and account_id and retained at zero use until explicit account erasure.';


--
-- Name: shelf_writer_owner; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_writer_owner (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    fence_id uuid NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL,
    state text NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    active_generation uuid,
    build_generation uuid,
    requested_run uuid,
    enqueue_pending boolean DEFAULT false NOT NULL,
    CONSTRAINT shelf_writer_owner_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_writer_owner_check1 CHECK ((route = ((get_byte(uuid_send(fence_id), 10) * 256) + get_byte(uuid_send(fence_id), 11)))),
    CONSTRAINT shelf_writer_owner_check2 CHECK (((NOT ready) OR (active_generation IS NOT NULL))),
    CONSTRAINT shelf_writer_owner_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT shelf_writer_owner_fence_id_check CHECK ((fence_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_writer_owner_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT shelf_writer_owner_state_check CHECK ((state = ANY (ARRAY['initializing'::text, 'open'::text, 'rebuilding'::text, 'purging'::text, 'purged'::text])))
);


--
-- Name: TABLE shelf_writer_owner; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_writer_owner IS 'Native counter serialization point and private reservation fence, subordinate to shelf_maintenance. The shared maintenance gate owns current epoch, readiness, durable backfill intent and active generation. Its lock precedes this row and all placement counters. Legacy intent columns confer no authority; terminal state is never inferred from a timer.';


--
-- Name: subject_collection; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_collection (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    collection_route integer NOT NULL,
    multiplicity integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    source_partition integer,
    source_epoch integer,
    source_position bigint,
    CONSTRAINT subject_collection_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_collection_check1 CHECK ((collection_route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT subject_collection_collection_route_check CHECK (((collection_route >= 0) AND (collection_route <= 65535))),
    CONSTRAINT subject_collection_multiplicity_check CHECK ((multiplicity >= 1)),
    CONSTRAINT subject_collection_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_collection_source_check CHECK ((((source_partition IS NULL) AND (source_epoch IS NULL) AND (source_position IS NULL)) OR ((source_partition IS NOT NULL) AND (source_epoch IS NOT NULL) AND (source_position IS NOT NULL) AND (source_partition = (collection_route >> 4)) AND (source_epoch >= 1) AND (source_position >= 0))))
);


--
-- Name: subject_collection_source_fence; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_collection_source_fence (
    partition_no integer NOT NULL,
    collection_id uuid NOT NULL,
    collection_route integer NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    terminal boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_collection_source_fence_check CHECK ((collection_route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT subject_collection_source_fence_check1 CHECK ((source_partition = (collection_route >> 4))),
    CONSTRAINT subject_collection_source_fence_collection_route_check CHECK (((collection_route >= 0) AND (collection_route <= 65535))),
    CONSTRAINT subject_collection_source_fence_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT subject_collection_source_fence_source_epoch_check CHECK ((source_epoch >= 1)),
    CONSTRAINT subject_collection_source_fence_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: subject_collection_version; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_collection_version (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    collection_route integer NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    multiplicity integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_collection_version_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_collection_version_check1 CHECK ((collection_route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT subject_collection_version_check2 CHECK ((source_partition = (collection_route >> 4))),
    CONSTRAINT subject_collection_version_collection_route_check CHECK (((collection_route >= 0) AND (collection_route <= 65535))),
    CONSTRAINT subject_collection_version_multiplicity_check CHECK ((multiplicity >= 0)),
    CONSTRAINT subject_collection_version_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_collection_version_source_epoch_check CHECK ((source_epoch >= 1)),
    CONSTRAINT subject_collection_version_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: subject_listing; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_listing (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    public_collection_count integer NOT NULL,
    revision integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_listing_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_listing_public_collection_count_check CHECK ((public_collection_count >= 0)),
    CONSTRAINT subject_listing_revision_check CHECK ((revision >= 1)),
    CONSTRAINT subject_listing_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: type_preparation_header; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.type_preparation_header (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    binding_digest text NOT NULL,
    binding jsonb NOT NULL,
    origin jsonb NOT NULL,
    principal_namespace jsonb NOT NULL,
    reservation_id uuid,
    input_byte_length bigint NOT NULL,
    input_digest bytea NOT NULL,
    creation_transaction_id uuid NOT NULL,
    creation_receipt jsonb NOT NULL,
    creation_commitment text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    source_identity jsonb,
    origin_identity jsonb,
    CONSTRAINT type_preparation_header_binding_check CHECK ((jsonb_typeof(binding) = 'object'::text)),
    CONSTRAINT type_preparation_header_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT type_preparation_header_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT type_preparation_header_check1 CHECK ((route = ((get_byte(uuid_send(preparation_id), 10) * 256) + get_byte(uuid_send(preparation_id), 11)))),
    CONSTRAINT type_preparation_header_creation_commitment_check CHECK ((creation_commitment ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT type_preparation_header_creation_receipt_check CHECK ((jsonb_typeof(creation_receipt) = 'object'::text)),
    CONSTRAINT type_preparation_header_input_byte_length_check CHECK ((input_byte_length >= 0)),
    CONSTRAINT type_preparation_header_input_digest_check CHECK ((octet_length(input_digest) = 32)),
    CONSTRAINT type_preparation_header_origin_check CHECK ((jsonb_typeof(origin) = 'object'::text)),
    CONSTRAINT type_preparation_header_principal_namespace_check CHECK ((jsonb_typeof(principal_namespace) = 'object'::text)),
    CONSTRAINT type_preparation_header_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE type_preparation_header; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.type_preparation_header IS 'Immutable provenance storage, not authority or proof of completed effects. The authorized native creator validates exact TypePreparationBinding/Origin, the exact native creator receipt locator in creation_receipt and principal/basis namespace (no bearer or actor permission result), and commits this header with the core receipt response metadataCommitment in one owner command. Before continuation, independently verify the actual receipt digest, transaction and full allowlisted header commitment; copied or late receipt JSON is never authority. Source and subject may be remote.';


--
-- Name: COLUMN type_preparation_header.reservation_id; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.reservation_id IS 'No FK: the native reservation retains exact accepted text and matching immutable EXTERNAL bytes until atomic final dictionary publication/removal. Header and DBOS contain no input copy. Ready progress refers to the immutable published value; exact reservation/value text comparison is required, never only a hash.';


--
-- Name: COLUMN type_preparation_header.input_digest; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.input_digest IS 'Lookup acceleration only, never exact input equality evidence or authority; no new per-type cap.';


--
-- Name: COLUMN type_preparation_header.creation_commitment; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.creation_commitment IS 'Commits preparation, owner, full binding, origin, source_identity, origin_identity, principal/input association and creator receipt locator, excluding this commitment field itself and mutable progress including last_receipt. Publication and key payload remain exact native evidence.';


--
-- Name: COLUMN type_preparation_header.source_identity; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.source_identity IS 'Private exact initial same-RR resolved-source latest create/identity metadata: sourceId, partition, epoch, revision, transactionId, redirect. Origin/survivor are independently anchored. Immutable header commitment includes both identities; DDL checks storage only, never authenticity. Bounded purge inventory must remove this metadata.';


--
-- Name: COLUMN type_preparation_header.origin_identity; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.origin_identity IS 'Private exact initial same-RR requested-origin identity, independently anchored with the same fields as source_identity. Historical NULL headers remain immutable and prove no authority: reader returns null; an admitted producer under current owner/gate locks may replace an invalid slot with a fresh UUID. Bounded purge inventory must remove this metadata.';


--
-- Name: type_preparation_progress; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.type_preparation_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    chunk bigint DEFAULT 0 NOT NULL,
    byte_offset bigint DEFAULT 0 NOT NULL,
    node_id uuid,
    state text NOT NULL,
    type_id uuid,
    enqueue_pending boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    last_receipt jsonb,
    last_transaction_id uuid,
    CONSTRAINT type_preparation_progress_byte_offset_check CHECK ((byte_offset >= 0)),
    CONSTRAINT type_preparation_progress_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT type_preparation_progress_check1 CHECK ((route = ((get_byte(uuid_send(preparation_id), 10) * 256) + get_byte(uuid_send(preparation_id), 11)))),
    CONSTRAINT type_preparation_progress_check2 CHECK (((state <> 'ready'::text) OR ((type_id IS NOT NULL) AND (NOT enqueue_pending)))),
    CONSTRAINT type_preparation_progress_chunk_check CHECK ((chunk >= 0)),
    CONSTRAINT type_preparation_progress_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT type_preparation_progress_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'cancelled'::text])))
);


--
-- Name: TABLE type_preparation_progress; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.type_preparation_progress IS 'Mutable native checkpoint/final mapping, separate from immutable evidence. Runner verifies offset <= header length, reservation/source association, current owner epoch, command and readiness. Edges/reservation progress, checkpoint and successor outbox commit together; final key, ready progress and reservation removal commit atomically. No cross-table CHECK or callback confers authority.';


--
-- Name: COLUMN type_preparation_progress.last_receipt; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_progress.last_receipt IS 'Private mutable native core receipt locator, excluded from immutable header commitment. Creator/page stores locator and actual transaction with corresponding core receipt response in the SAME command. JSON alone is not authority: reader/consumer independently verifies real core row partition/account/kind/key/digest/transaction, full header commitment, root/final state/checkpoint/typeId response. No receipt FK: shared retention is bounded; collection fails closed. Bounded purge inventory must remove locators.';


--
-- Name: COLUMN type_preparation_progress.last_transaction_id; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_progress.last_transaction_id IS 'Actual core receipt transaction paired with last_receipt, not hash-only proof. Historical ready rows lacking proof are never served as ready; replace/reobserve through an admitted producer. Pending historical metadata gains no authority. DDL authenticates nothing.';


--
-- Name: type_preparation_slot; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.type_preparation_slot (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    binding_digest text NOT NULL,
    preparation_id uuid NOT NULL,
    CONSTRAINT type_preparation_slot_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT type_preparation_slot_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT type_preparation_slot_check1 CHECK ((route = ((get_byte(uuid_send(preparation_id), 10) * 256) + get_byte(uuid_send(preparation_id), 11)))),
    CONSTRAINT type_preparation_slot_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE type_preparation_slot; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.type_preparation_slot IS 'Active owner binding slot. Digest hits require exact full binding, principal and native input comparison; collisions never alias. Equal live work converges. Only an admitted producer under current account/gate locks may replace cancelled/missing generations with a fresh UUID; source/owner epoch changes binding. Old receipts cannot trap replacement; purged owners cannot recreate slots. PKs support bounded owner enumeration: retirement/purge removes slots, progress, then headers/reservations and retains a minimal terminal fence. No automatic TTL or cascade.';


--
-- Name: bangumi_upload bangumi_upload_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bangumi_upload
    ADD CONSTRAINT bangumi_upload_pkey PRIMARY KEY (route, account_id, upload_id);


--
-- Name: bangumi_upload_row bangumi_upload_row_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bangumi_upload_row
    ADD CONSTRAINT bangumi_upload_row_pkey PRIMARY KEY (route, account_id, upload_id, ordinal);


--
-- Name: builtin_collection_reference builtin_collection_reference_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.builtin_collection_reference
    ADD CONSTRAINT builtin_collection_reference_pkey PRIMARY KEY (route, collection_id);


--
-- Name: builtin_collection_reference builtin_collection_reference_route_account_id_profile_id_st_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.builtin_collection_reference
    ADD CONSTRAINT builtin_collection_reference_route_account_id_profile_id_st_key UNIQUE (route, account_id, profile_id, state_set_id, state_id);


--
-- Name: builtin_state_reference_source builtin_state_reference_source_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.builtin_state_reference_source
    ADD CONSTRAINT builtin_state_reference_source_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: bulk_effect bulk_effect_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bulk_effect
    ADD CONSTRAINT bulk_effect_pkey PRIMARY KEY (route, operation_id, ordinal);


--
-- Name: bulk_operation bulk_operation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bulk_operation
    ADD CONSTRAINT bulk_operation_pkey PRIMARY KEY (route, operation_id);


--
-- Name: bulk_target bulk_target_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bulk_target
    ADD CONSTRAINT bulk_target_pkey PRIMARY KEY (route, operation_id, ordinal);


--
-- Name: canonical_source_fact canonical_source_fact_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_fact
    ADD CONSTRAINT canonical_source_fact_pkey PRIMARY KEY (route, collection_id, generation, basis_digest, canonical_subject_id, stored_subject_id, driver, fact_id);


--
-- Name: canonical_source_fact canonical_source_fact_route_collection_id_generation_basis__key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_fact
    ADD CONSTRAINT canonical_source_fact_route_collection_id_generation_basis__key UNIQUE (route, collection_id, generation, basis_digest, stored_subject_id, driver, fact_id);


--
-- Name: canonical_source_generation canonical_source_generation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_generation
    ADD CONSTRAINT canonical_source_generation_pkey PRIMARY KEY (route, collection_id, generation);


--
-- Name: canonical_source_head canonical_source_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_head
    ADD CONSTRAINT canonical_source_head_pkey PRIMARY KEY (route, collection_id);


--
-- Name: canonical_source_reference canonical_source_reference_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_reference
    ADD CONSTRAINT canonical_source_reference_pkey PRIMARY KEY (route, collection_id, generation, canonical_subject_id, stored_subject_id, driver, fact_id);


--
-- Name: canonical_source_scope canonical_source_scope_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_scope
    ADD CONSTRAINT canonical_source_scope_pkey PRIMARY KEY (route, collection_id, source_fence);


--
-- Name: canonical_source_state canonical_source_state_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_state
    ADD CONSTRAINT canonical_source_state_pkey PRIMARY KEY (route, collection_id);


--
-- Name: collection_kind_audience_origin collection_kind_audience_origi_route_collection_id_audience_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_audience_origin
    ADD CONSTRAINT collection_kind_audience_origi_route_collection_id_audience_key UNIQUE (route, collection_id, audience);


--
-- Name: collection_kind_audience_origin collection_kind_audience_origin_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_audience_origin
    ADD CONSTRAINT collection_kind_audience_origin_pkey PRIMARY KEY (route, origin_id);


--
-- Name: collection_kind_consent_consumer collection_kind_consent_consu_route_owner_account_id_collec_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_consent_consumer
    ADD CONSTRAINT collection_kind_consent_consu_route_owner_account_id_collec_key UNIQUE (route, owner_account_id, collection_id, preparation_id, origin_id);


--
-- Name: collection_kind_consent_consumer collection_kind_consent_consumer_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_consent_consumer
    ADD CONSTRAINT collection_kind_consent_consumer_pkey PRIMARY KEY (route, reference_id);


--
-- Name: collection_kind_consent_transition collection_kind_consent_transition_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_consent_transition
    ADD CONSTRAINT collection_kind_consent_transition_pkey PRIMARY KEY (route, reference_id, transition_id);


--
-- Name: collection_kind_count collection_kind_count_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_count
    ADD CONSTRAINT collection_kind_count_pkey PRIMARY KEY (route, collection_id, audience, generation, type_id);


--
-- Name: collection_kind_observation collection_kind_observation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_observation
    ADD CONSTRAINT collection_kind_observation_pkey PRIMARY KEY (route, collection_id, audience);


--
-- Name: collection_kind_raw_input collection_kind_raw_input_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_raw_input
    ADD CONSTRAINT collection_kind_raw_input_pkey PRIMARY KEY (route, origin_id, observation_version);


--
-- Name: collection_kind_raw_input collection_kind_raw_input_route_input_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_raw_input
    ADD CONSTRAINT collection_kind_raw_input_route_input_id_key UNIQUE (route, input_id);


--
-- Name: collection_kind_retired collection_kind_retired_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_retired
    ADD CONSTRAINT collection_kind_retired_pkey PRIMARY KEY (route, collection_id, audience, generation);


--
-- Name: collection_kind_subject collection_kind_subject_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_subject
    ADD CONSTRAINT collection_kind_subject_pkey PRIMARY KEY (route, collection_id, audience, generation, subject_id);


--
-- Name: collection_listing_history collection_listing_history_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_listing_history
    ADD CONSTRAINT collection_listing_history_pkey PRIMARY KEY (route, collection_id);


--
-- Name: collection_member collection_member_ordinal_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_ordinal_key UNIQUE (route, collection_id, ordinal_key) DEFERRABLE;


--
-- Name: collection_member collection_member_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_pkey PRIMARY KEY (route, collection_id, member_id);


--
-- Name: collection_order_repair collection_order_repair_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_order_repair
    ADD CONSTRAINT collection_order_repair_pkey PRIMARY KEY (route, collection_id);


--
-- Name: collection_order_repair collection_order_repair_route_repair_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_order_repair
    ADD CONSTRAINT collection_order_repair_route_repair_id_key UNIQUE (route, repair_id);


--
-- Name: collection_pins collection_pins_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_pins
    ADD CONSTRAINT collection_pins_pkey PRIMARY KEY (route, account_id);


--
-- Name: collection collection_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection
    ADD CONSTRAINT collection_pkey PRIMARY KEY (route, collection_id);


--
-- Name: collection_publication_episode collection_publication_episode_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_episode
    ADD CONSTRAINT collection_publication_episode_pkey PRIMARY KEY (route, publication_id);


--
-- Name: collection_publication_operation collection_publication_operat_route_owner_account_id_creati_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_operation
    ADD CONSTRAINT collection_publication_operat_route_owner_account_id_creati_key UNIQUE (route, owner_account_id, creation_key);


--
-- Name: collection_publication_operation collection_publication_operation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_operation
    ADD CONSTRAINT collection_publication_operation_pkey PRIMARY KEY (route, publication_id);


--
-- Name: collection_publication_operation collection_publication_operation_route_source_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_operation
    ADD CONSTRAINT collection_publication_operation_route_source_id_key UNIQUE (route, source_id);


--
-- Name: collection_publication_source collection_publication_source_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_source
    ADD CONSTRAINT collection_publication_source_pkey PRIMARY KEY (route, source_id);


--
-- Name: collection_publication_staging collection_publication_stagin_route_collection_id_publicati_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging
    ADD CONSTRAINT collection_publication_stagin_route_collection_id_publicati_key UNIQUE (route, collection_id, publication_id);


--
-- Name: collection_publication_staging_evidence collection_publication_staging_evidence_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging_evidence
    ADD CONSTRAINT collection_publication_staging_evidence_pkey PRIMARY KEY (route, collection_id, generation, subject_id);


--
-- Name: collection_publication_staging collection_publication_staging_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging
    ADD CONSTRAINT collection_publication_staging_pkey PRIMARY KEY (route, collection_id, generation);


--
-- Name: collection_publication_staging_seal collection_publication_staging_seal_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging_seal
    ADD CONSTRAINT collection_publication_staging_seal_pkey PRIMARY KEY (route, collection_id, generation);


--
-- Name: collection_retained_output collection_retained_output_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_retained_output
    ADD CONSTRAINT collection_retained_output_pkey PRIMARY KEY (route, collection_id);


--
-- Name: collection_source_output_head collection_source_output_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_head
    ADD CONSTRAINT collection_source_output_head_pkey PRIMARY KEY (route, collection_id);


--
-- Name: collection_source_output_member collection_source_output_member_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_member
    ADD CONSTRAINT collection_source_output_member_pkey PRIMARY KEY (route, collection_id, generation, subject_id);


--
-- Name: collection_source_output collection_source_output_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output
    ADD CONSTRAINT collection_source_output_pkey PRIMARY KEY (route, collection_id, generation);


--
-- Name: collection_source_output_publication collection_source_output_publication_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_publication
    ADD CONSTRAINT collection_source_output_publication_pkey PRIMARY KEY (route, collection_id, generation);


--
-- Name: consumption_statistics_installation consumption_statistics_installation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.consumption_statistics_installation
    ADD CONSTRAINT consumption_statistics_installation_pkey PRIMARY KEY (singleton);


--
-- Name: consumption_statistics_owner consumption_statistics_owner_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.consumption_statistics_owner
    ADD CONSTRAINT consumption_statistics_owner_pkey PRIMARY KEY (route, account_id);


--
-- Name: consumption_statistics_subject consumption_statistics_subject_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.consumption_statistics_subject
    ADD CONSTRAINT consumption_statistics_subject_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: copy_archive_row copy_archive_row_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy_archive_row
    ADD CONSTRAINT copy_archive_row_pkey PRIMARY KEY (route, account_id, upload_id, ordinal);


--
-- Name: copy_archive_upload copy_archive_upload_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy_archive_upload
    ADD CONSTRAINT copy_archive_upload_pkey PRIMARY KEY (route, account_id);


--
-- Name: copy_archive_upload copy_archive_upload_route_account_id_upload_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy_archive_upload
    ADD CONSTRAINT copy_archive_upload_route_account_id_upload_id_key UNIQUE (route, account_id, upload_id);


--
-- Name: copy copy_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy
    ADD CONSTRAINT copy_pkey PRIMARY KEY (route, copy_id);


--
-- Name: copy copy_status_check; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.copy
    ADD CONSTRAINT copy_status_check CHECK ((((library_profile_pin IS NULL) AND (status = ANY (ARRAY['ordered'::text, 'owned'::text, 'lent'::text, 'disposed'::text]))) OR ((library_profile_pin IS NOT NULL) AND (char_length(status) > 0)))) NOT VALID;


--
-- Name: diary_navigation diary_navigation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.diary_navigation
    ADD CONSTRAINT diary_navigation_pkey PRIMARY KEY (route, account_id, slot);


--
-- Name: diary_navigation diary_navigation_route_account_id_navigation_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.diary_navigation
    ADD CONSTRAINT diary_navigation_route_account_id_navigation_id_key UNIQUE (route, account_id, navigation_id);


--
-- Name: entry_deleted entry_deleted_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry_deleted
    ADD CONSTRAINT entry_deleted_pkey PRIMARY KEY (route, account_id, deletion_id);


--
-- Name: entry_personal_fact entry_personal_fact_fact_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry_personal_fact
    ADD CONSTRAINT entry_personal_fact_fact_id_key UNIQUE (route, account_id, fact_id);


--
-- Name: entry_personal_fact entry_personal_fact_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry_personal_fact
    ADD CONSTRAINT entry_personal_fact_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: entry entry_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry
    ADD CONSTRAINT entry_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: entry_source_observation entry_source_observation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry_source_observation
    ADD CONSTRAINT entry_source_observation_pkey PRIMARY KEY (route, account_id, subject_id, provider, record_id);


--
-- Name: entry_state_change entry_state_change_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry_state_change
    ADD CONSTRAINT entry_state_change_pkey PRIMARY KEY (route, account_id, subject_id, incarnation_id, revision);


--
-- Name: entry entry_state_check; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.entry
    ADD CONSTRAINT entry_state_check CHECK ((((library_profile_pin IS NULL) AND (state = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text]))) OR ((library_profile_pin IS NOT NULL) AND (char_length(state) > 0)))) NOT VALID;


--
-- Name: fact_source_head fact_source_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.fact_source_head
    ADD CONSTRAINT fact_source_head_pkey PRIMARY KEY (route, account_id);


--
-- Name: follow_count_account_signal follow_count_account_signal_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_account_signal
    ADD CONSTRAINT follow_count_account_signal_pkey PRIMARY KEY (route, account_id, event_id);


--
-- Name: follow_count_account_work follow_count_account_work_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_account_work
    ADD CONSTRAINT follow_count_account_work_pkey PRIMARY KEY (route, account_id);


--
-- Name: follow_count_destination follow_count_destination_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_destination
    ADD CONSTRAINT follow_count_destination_pkey PRIMARY KEY (route, account_id, target_type, original_id, destination_route, destination_id);


--
-- Name: follow_count_health follow_count_health_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_health
    ADD CONSTRAINT follow_count_health_pkey PRIMARY KEY (node);


--
-- Name: follow_count_owner follow_count_owner_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_owner
    ADD CONSTRAINT follow_count_owner_pkey PRIMARY KEY (route, account_id);


--
-- Name: follow_count_pair follow_count_pair_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_pair
    ADD CONSTRAINT follow_count_pair_pkey PRIMARY KEY (route, target_type, target_id, account_id, original_id);


--
-- Name: follow_count_partition follow_count_partition_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_partition
    ADD CONSTRAINT follow_count_partition_pkey PRIMARY KEY (partition_no);


--
-- Name: follow_count_source follow_count_source_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_source
    ADD CONSTRAINT follow_count_source_pkey PRIMARY KEY (route, account_id, target_type, target_id);


--
-- Name: follow_count_support follow_count_support_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_support
    ADD CONSTRAINT follow_count_support_pkey PRIMARY KEY (route, target_type, target_id, account_id);


--
-- Name: follow_count_terminal_follower follow_count_terminal_follower_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_terminal_follower
    ADD CONSTRAINT follow_count_terminal_follower_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: follow_count_terminal_source follow_count_terminal_source_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_terminal_source
    ADD CONSTRAINT follow_count_terminal_source_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: follow_count_total follow_count_total_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_total
    ADD CONSTRAINT follow_count_total_pkey PRIMARY KEY (route, target_type, target_id);


--
-- Name: follow follow_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow
    ADD CONSTRAINT follow_pkey PRIMARY KEY (route, account_id, target_id);


--
-- Name: identity_epoch_participant_work identity_epoch_participant_work_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_epoch_participant_work
    ADD CONSTRAINT identity_epoch_participant_work_pkey PRIMARY KEY (partition_no, job_id, job_epoch, effect_key);


--
-- Name: identity_epoch_source_basis identity_epoch_source_basis_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_epoch_source_basis
    ADD CONSTRAINT identity_epoch_source_basis_pkey PRIMARY KEY (partition_no, job_id, job_epoch, effect_key);


--
-- Name: identity_scope_effect identity_scope_effect_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_effect
    ADD CONSTRAINT identity_scope_effect_pkey PRIMARY KEY (route, collection_id, plan_key, effect_key, disposition);


--
-- Name: identity_scope_plan identity_scope_plan_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_plan
    ADD CONSTRAINT identity_scope_plan_pkey PRIMARY KEY (route, collection_id, plan_key);


--
-- Name: identity_scope_seal identity_scope_seal_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_seal
    ADD CONSTRAINT identity_scope_seal_pkey PRIMARY KEY (route, collection_id, plan_key, version);


--
-- Name: label_assignment label_assignment_identity; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.label_assignment
    ADD CONSTRAINT label_assignment_identity UNIQUE (route, account_id, assignment_id);


--
-- Name: label_assignment label_assignment_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.label_assignment
    ADD CONSTRAINT label_assignment_pkey PRIMARY KEY (route, account_id, subject_id, label_id);


--
-- Name: library_export library_export_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.library_export
    ADD CONSTRAINT library_export_pkey PRIMARY KEY (route, account_id);


--
-- Name: list_import_anilist list_import_anilist_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.list_import_anilist
    ADD CONSTRAINT list_import_anilist_pkey PRIMARY KEY (route, account_id, import_id, ordinal);


--
-- Name: list_import_mal list_import_mal_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.list_import_mal
    ADD CONSTRAINT list_import_mal_pkey PRIMARY KEY (route, account_id, id);


--
-- Name: members_preparation_owner members_preparation_owner_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.members_preparation_owner
    ADD CONSTRAINT members_preparation_owner_pkey PRIMARY KEY (route, owner_account_id);


--
-- Name: members_preparation members_preparation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.members_preparation
    ADD CONSTRAINT members_preparation_pkey PRIMARY KEY (route, owner_account_id, collection_id, episode_id);


--
-- Name: members_preparation_result members_preparation_result_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.members_preparation_result
    ADD CONSTRAINT members_preparation_result_pkey PRIMARY KEY (route, owner_account_id, collection_id, episode_id, subject_id);


--
-- Name: members_preparation_result members_preparation_result_route_owner_account_id_collectio_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.members_preparation_result
    ADD CONSTRAINT members_preparation_result_route_owner_account_id_collectio_key UNIQUE (route, owner_account_id, collection_id, episode_id, sort_key, subject_id);


--
-- Name: native_public_output_binding native_public_output_binding_partition_no_hold_id_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_binding
    ADD CONSTRAINT native_public_output_binding_partition_no_hold_id_key UNIQUE (partition_no, hold_id);


--
-- Name: native_public_output_binding native_public_output_binding_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_binding
    ADD CONSTRAINT native_public_output_binding_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: native_public_output_binding native_public_output_binding_route_collection_id_effect_key_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_binding
    ADD CONSTRAINT native_public_output_binding_route_collection_id_effect_key_key UNIQUE (route, collection_id, effect_key);


--
-- Name: native_public_output_hold native_public_output_hold_partition_no_capture_id_role_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_hold
    ADD CONSTRAINT native_public_output_hold_partition_no_capture_id_role_key UNIQUE (partition_no, capture_id, role);


--
-- Name: native_public_output_hold native_public_output_hold_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_hold
    ADD CONSTRAINT native_public_output_hold_pkey PRIMARY KEY (partition_no, hold_id);


--
-- Name: native_public_output_receiving native_public_output_receiving_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_receiving
    ADD CONSTRAINT native_public_output_receiving_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: native_public_output_transition native_public_output_transition_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_transition
    ADD CONSTRAINT native_public_output_transition_pkey PRIMARY KEY (partition_no, hold_id);


--
-- Name: native_source_capture native_source_capture_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_source_capture
    ADD CONSTRAINT native_source_capture_pkey PRIMARY KEY (route, capture_id);


--
-- Name: native_source_fence native_source_fence_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_source_fence
    ADD CONSTRAINT native_source_fence_pkey PRIMARY KEY (route, kind, owner_id);


--
-- Name: native_source_hold native_source_hold_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_source_hold
    ADD CONSTRAINT native_source_hold_pkey PRIMARY KEY (route, capture_id, hold_id);


--
-- Name: native_source_receipt native_source_receipt_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_source_receipt
    ADD CONSTRAINT native_source_receipt_pkey PRIMARY KEY (route, capture_id);


--
-- Name: owner_identity_scope owner_identity_scope_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_identity_scope
    ADD CONSTRAINT owner_identity_scope_pkey PRIMARY KEY (partition_no, original, source_id, incarnation, role);


--
-- Name: owner_index_control owner_index_control_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_index_control
    ADD CONSTRAINT owner_index_control_pkey PRIMARY KEY (route, account_id);


--
-- Name: owner_index_label_repair owner_index_label_repair_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_index_label_repair
    ADD CONSTRAINT owner_index_label_repair_pkey PRIMARY KEY (route, account_id, label_id);


--
-- Name: owner_index_pin owner_index_pin_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_index_pin
    ADD CONSTRAINT owner_index_pin_pkey PRIMARY KEY (route, account_id, pin);


--
-- Name: owner_index_state owner_index_state_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_index_state
    ADD CONSTRAINT owner_index_state_pkey PRIMARY KEY (route, account_id, pin, collection_id);


--
-- Name: owner_member_index owner_member_index_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_member_index
    ADD CONSTRAINT owner_member_index_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: owner_member_support owner_member_support_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_member_support
    ADD CONSTRAINT owner_member_support_pkey PRIMARY KEY (route, account_id, subject_id, family, pin);


--
-- Name: owner_write_counter owner_write_counter_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_write_counter
    ADD CONSTRAINT owner_write_counter_pkey PRIMARY KEY (route, account_id);


--
-- Name: personal_label personal_label_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.personal_label
    ADD CONSTRAINT personal_label_pkey PRIMARY KEY (route, account_id, label_id);


--
-- Name: progress_change progress_change_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_change
    ADD CONSTRAINT progress_change_pkey PRIMARY KEY (route, session_id, change_no);


--
-- Name: progress_head progress_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_head
    ADD CONSTRAINT progress_head_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: progress_session progress_session_check2; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.progress_session
    ADD CONSTRAINT progress_session_check2 CHECK (((library_profile_pin IS NOT NULL) OR (unit <> 'percent'::text) OR (((amount IS NULL) OR (amount <= (100)::numeric)) AND ((total IS NULL) OR (total <= (100)::numeric))))) NOT VALID;


--
-- Name: progress_session progress_session_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_session
    ADD CONSTRAINT progress_session_pkey PRIMARY KEY (route, session_id);


--
-- Name: progress_session progress_session_unit_check; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.progress_session
    ADD CONSTRAINT progress_session_unit_check CHECK ((((library_profile_pin IS NULL) AND (unit = ANY (ARRAY['page'::text, 'chapter'::text, 'episode'::text, 'volume'::text, 'minute'::text, 'percent'::text]))) OR ((library_profile_pin IS NOT NULL) AND (char_length(unit) > 0)))) NOT VALID;


--
-- Name: progress_unit progress_unit_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_unit
    ADD CONSTRAINT progress_unit_pkey PRIMARY KEY (route, session_id, unit_id);


--
-- Name: published_log published_log_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.published_log
    ADD CONSTRAINT published_log_pkey PRIMARY KEY (route, log_id);


--
-- Name: reported_year_bucket reported_year_bucket_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.reported_year_bucket
    ADD CONSTRAINT reported_year_bucket_pkey PRIMARY KEY (route, account_id, year, bucket);


--
-- Name: reported_year_owner reported_year_owner_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.reported_year_owner
    ADD CONSTRAINT reported_year_owner_pkey PRIMARY KEY (route, account_id);


--
-- Name: reported_year_subject reported_year_subject_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.reported_year_subject
    ADD CONSTRAINT reported_year_subject_pkey PRIMARY KEY (route, account_id, year, bucket, subject_id);


--
-- Name: shelf_count shelf_count_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_count
    ADD CONSTRAINT shelf_count_pkey PRIMARY KEY (route, account_id, generation_id, bucket, type_id);


--
-- Name: shelf_maintenance_head shelf_maintenance_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_maintenance_head
    ADD CONSTRAINT shelf_maintenance_head_pkey PRIMARY KEY (route, account_id, run_id, subject_id);


--
-- Name: shelf_maintenance shelf_maintenance_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_maintenance
    ADD CONSTRAINT shelf_maintenance_pkey PRIMARY KEY (route, account_id);


--
-- Name: shelf_maintenance_run shelf_maintenance_run_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_maintenance_run
    ADD CONSTRAINT shelf_maintenance_run_pkey PRIMARY KEY (route, account_id, run_id);


--
-- Name: shelf_maintenance_session shelf_maintenance_session_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_maintenance_session
    ADD CONSTRAINT shelf_maintenance_session_pkey PRIMARY KEY (route, account_id, run_id, session_id);


--
-- Name: shelf_maintenance_source shelf_maintenance_source_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_maintenance_source
    ADD CONSTRAINT shelf_maintenance_source_pkey PRIMARY KEY (route, account_id, run_id, subject_id);


--
-- Name: shelf_maintenance_step shelf_maintenance_step_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_maintenance_step
    ADD CONSTRAINT shelf_maintenance_step_pkey PRIMARY KEY (route, account_id, run_id, epoch, sequence);


--
-- Name: shelf_type_node shelf_type_node_parent_chunk_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_node
    ADD CONSTRAINT shelf_type_node_parent_chunk_key UNIQUE (route, account_id, parent_id, chunk);


--
-- Name: shelf_type_node shelf_type_node_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_node
    ADD CONSTRAINT shelf_type_node_pkey PRIMARY KEY (route, account_id, node_id);


--
-- Name: shelf_type_reservation shelf_type_reservation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_reservation
    ADD CONSTRAINT shelf_type_reservation_pkey PRIMARY KEY (route, account_id, reservation_id);


--
-- Name: shelf_type_root shelf_type_root_owner_node_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_root
    ADD CONSTRAINT shelf_type_root_owner_node_key UNIQUE (route, account_id, root_node_id);


--
-- Name: shelf_type_root shelf_type_root_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_root
    ADD CONSTRAINT shelf_type_root_pkey PRIMARY KEY (route, account_id, digest);


--
-- Name: shelf_type_value shelf_type_value_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_value
    ADD CONSTRAINT shelf_type_value_pkey PRIMARY KEY (route, account_id, type_id);


--
-- Name: shelf_writer_owner shelf_writer_owner_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_writer_owner
    ADD CONSTRAINT shelf_writer_owner_pkey PRIMARY KEY (route, account_id);


--
-- Name: subject_collection subject_collection_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_collection
    ADD CONSTRAINT subject_collection_pkey PRIMARY KEY (route, subject_id, collection_id);


--
-- Name: subject_collection_source_fence subject_collection_source_fence_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_collection_source_fence
    ADD CONSTRAINT subject_collection_source_fence_pkey PRIMARY KEY (partition_no, collection_id);


--
-- Name: subject_collection_version subject_collection_version_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_collection_version
    ADD CONSTRAINT subject_collection_version_pkey PRIMARY KEY (route, subject_id, collection_id);


--
-- Name: subject_listing subject_listing_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_listing
    ADD CONSTRAINT subject_listing_pkey PRIMARY KEY (route, subject_id);


--
-- Name: type_preparation_header type_preparation_header_identity_check; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.type_preparation_header
    ADD CONSTRAINT type_preparation_header_identity_check CHECK (((source_identity IS NOT NULL) AND (jsonb_typeof(source_identity) = 'object'::text) AND (origin_identity IS NOT NULL) AND (jsonb_typeof(origin_identity) = 'object'::text))) NOT VALID;


--
-- Name: type_preparation_header type_preparation_header_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_header
    ADD CONSTRAINT type_preparation_header_pkey PRIMARY KEY (route, account_id, preparation_id);


--
-- Name: type_preparation_header type_preparation_header_route_account_id_binding_digest_pre_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_header
    ADD CONSTRAINT type_preparation_header_route_account_id_binding_digest_pre_key UNIQUE (route, account_id, binding_digest, preparation_id);


--
-- Name: type_preparation_progress type_preparation_progress_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_pkey PRIMARY KEY (route, account_id, preparation_id);


--
-- Name: type_preparation_progress type_preparation_progress_ready_proof_check; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_ready_proof_check CHECK (((state <> 'ready'::text) OR ((last_receipt IS NOT NULL) AND (last_transaction_id IS NOT NULL)))) NOT VALID;


--
-- Name: type_preparation_progress type_preparation_progress_receipt_check; Type: CHECK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_receipt_check CHECK ((((last_receipt IS NULL) AND (last_transaction_id IS NULL)) OR ((last_receipt IS NOT NULL) AND (jsonb_typeof(last_receipt) = 'object'::text) AND (last_transaction_id IS NOT NULL)))) NOT VALID;


--
-- Name: type_preparation_slot type_preparation_slot_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_slot
    ADD CONSTRAINT type_preparation_slot_pkey PRIMARY KEY (route, account_id, binding_digest);


--
-- Name: builtin_state_reference_source_support; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX builtin_state_reference_source_support ON library.builtin_state_reference_source USING btree (route, collection_id, subject_id);


--
-- Name: bulk_effect_erasure_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_effect_erasure_owner ON library.bulk_effect USING btree (route, account_id, operation_id, ordinal);


--
-- Name: bulk_effect_expiry; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_effect_expiry ON library.bulk_effect USING btree (route, expires_at, operation_id, ordinal);


--
-- Name: bulk_operation_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_operation_due ON library.bulk_operation USING btree (route, phase, expires_at, operation_id);


--
-- Name: bulk_operation_expiry; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_operation_expiry ON library.bulk_operation USING btree (route, results_expire_at, operation_id);


--
-- Name: bulk_operation_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_operation_owner ON library.bulk_operation USING btree (route, account_id, operation_id);


--
-- Name: bulk_target_erasure_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_target_erasure_owner ON library.bulk_target USING btree (route, account_id, operation_id, ordinal);


--
-- Name: bulk_target_occurrence; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX bulk_target_occurrence ON library.bulk_target USING btree (route, operation_id, collection_id, member_id) WHERE (target_kind = 'occurrence'::text);


--
-- Name: bulk_target_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_target_pending ON library.bulk_target USING btree (route, operation_id, ordinal) WHERE (state = ANY (ARRAY['pending'::text, 'reconciling'::text]));


--
-- Name: bulk_target_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_target_state ON library.bulk_target USING btree (route, operation_id, state, ordinal);


--
-- Name: bulk_target_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX bulk_target_subject ON library.bulk_target USING btree (route, operation_id, subject_id) WHERE (target_kind = 'subject'::text);


--
-- Name: canonical_source_identity_old_fact; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX canonical_source_identity_old_fact ON library.canonical_source_fact USING btree (route, collection_id, generation, basis_digest, driver, stored_subject_id, fact_id);


--
-- Name: canonical_source_identity_raw; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX canonical_source_identity_raw ON library.canonical_source_reference USING btree (route, collection_id, generation, driver, stored_subject_id, fact_id);


--
-- Name: canonical_source_working; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX canonical_source_working ON library.canonical_source_generation USING btree (route, collection_id) WHERE (state = 'working'::text);


--
-- Name: collection_builtin_everything_identity; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX collection_builtin_everything_identity ON library.collection USING btree (route, curator_account_id) WHERE (builtin_kind = 'everything'::text);


--
-- Name: collection_builtin_state_identity; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX collection_builtin_state_identity ON library.collection USING btree (route, curator_account_id, builtin_profile_id, builtin_state_set_id, builtin_state_id) WHERE (builtin_kind = 'state'::text);


--
-- Name: collection_curator_listing; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_listing ON library.collection USING btree (route, curator_account_id, collection_id);


--
-- Name: collection_curator_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_page ON library.collection USING btree (route, curator_account_id, updated_at DESC, collection_id DESC) WHERE (state = 'active'::text);


--
-- Name: collection_curator_public_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_public_page ON library.collection USING btree (route, curator_account_id, updated_at DESC, collection_id DESC) WHERE ((state = 'active'::text) AND (visibility = 'public'::text));


--
-- Name: collection_deletion_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_deletion_due ON library.collection USING btree (route, purge_after, collection_id) WHERE ((state = 'deleted'::text) AND (purge_after IS NOT NULL));


--
-- Name: collection_deletion_pending_legacy; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_deletion_pending_legacy ON library.collection USING btree (route, collection_id) WHERE ((state = 'deleted'::text) AND (deleted_at IS NULL));


--
-- Name: collection_kind_audience_origin_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_audience_origin_owner ON library.collection_kind_audience_origin USING btree (route, owner_account_id, collection_id, preparation_id);


--
-- Name: collection_kind_consent_consumer_episode; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_consent_consumer_episode ON library.collection_kind_consent_consumer USING btree (route, owner_account_id, collection_id, preparation_id, reference_id);


--
-- Name: collection_kind_consent_consumer_erasure; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_consent_consumer_erasure ON library.collection_kind_consent_consumer USING btree (route, owner_account_id, reference_id);


--
-- Name: collection_kind_consent_consumer_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_consent_consumer_owner ON library.collection_kind_consent_consumer USING btree (route, owner_account_id, collection_id, preparation_id);


--
-- Name: collection_kind_consent_transition_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_consent_transition_pending ON library.collection_kind_consent_transition USING btree (route, reference_id, transition_id) WHERE (status <> 'committed'::text);


--
-- Name: collection_kind_count_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_count_account ON library.collection_kind_count USING btree (route, account_id, collection_id, audience, generation, type_id);


--
-- Name: collection_kind_observation_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_observation_account ON library.collection_kind_observation USING btree (route, account_id, collection_id, audience);


--
-- Name: collection_kind_retired_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_retired_account ON library.collection_kind_retired USING btree (route, account_id, collection_id, audience, generation);


--
-- Name: collection_kind_retired_capture; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_retired_capture ON library.collection_kind_retired USING btree (route, collection_id, account_id, capture) WHERE (octet_length(capture) <= 512);


--
-- Name: collection_kind_subject_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_subject_account ON library.collection_kind_subject USING btree (route, account_id, collection_id, audience, generation, subject_id);


--
-- Name: collection_kind_winner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_kind_winner ON library.collection_kind_count USING btree (route, collection_id, audience, generation, votes DESC, type_id);


--
-- Name: collection_member_deletion_id; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX collection_member_deletion_id ON library.collection_member USING btree (route, collection_id, deletion_id) WHERE (deletion_id IS NOT NULL);


--
-- Name: collection_member_live_ordinal; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_member_live_ordinal ON library.collection_member USING btree (route, collection_id, ordinal_key, member_id) WHERE (deletion_id IS NULL);


--
-- Name: collection_member_raw_ordinal; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_member_raw_ordinal ON library.collection_member USING btree (route, collection_id, ordinal_key, member_id);


--
-- Name: collection_member_retention_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_member_retention_due ON library.collection_member USING btree (partition_no, purge_after, route, collection_id, member_id) WHERE ((deletion_id IS NOT NULL) AND (purge_after IS NOT NULL));


--
-- Name: collection_member_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_member_subject ON library.collection_member USING btree (route, collection_id, subject_id, member_id);


--
-- Name: collection_publication_episode_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_publication_episode_owner ON library.collection_publication_episode USING btree (route, owner_account_id, publication_id);


--
-- Name: collection_publication_episode_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX collection_publication_episode_pending ON library.collection_publication_episode USING btree (route, collection_id) WHERE (phase = ANY (ARRAY['staging'::text, 'awaiting_activation'::text]));


--
-- Name: collection_publication_operation_collection; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_publication_operation_collection ON library.collection_publication_operation USING btree (route, collection_id, publication_id);


--
-- Name: collection_publication_operation_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_publication_operation_owner ON library.collection_publication_operation USING btree (route, owner_account_id, publication_id);


--
-- Name: collection_publication_staging_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_publication_staging_account ON library.collection_publication_staging USING btree (route, account_id, collection_id, generation);


--
-- Name: collection_retention_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_retention_due ON library.collection USING btree (partition_no, purge_after, route, collection_id) WHERE ((state = 'deleted'::text) AND (purge_after IS NOT NULL));


--
-- Name: collection_sitemap_public_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_sitemap_public_page ON library.collection USING btree (route, collection_id) INCLUDE (updated_at) WHERE ((state = 'active'::text) AND (visibility = 'public'::text));


--
-- Name: collection_source_output_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_source_output_account ON library.collection_source_output USING btree (route, account_id, collection_id, generation);


--
-- Name: collection_source_output_building; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX collection_source_output_building ON library.collection_source_output USING btree (route, collection_id) WHERE (state = 'building'::text);


--
-- Name: collection_source_output_publication_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_source_output_publication_account ON library.collection_source_output_publication USING btree (route, account_id, collection_id, generation);


--
-- Name: copy_account_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_account_created ON library.copy USING btree (route, account_id, created_at, copy_id);


--
-- Name: copy_account_subject_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_account_subject_created ON library.copy USING btree (route, account_id, subject_id, created_at, copy_id);


--
-- Name: copy_archive_upload_expiry; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_archive_upload_expiry ON library.copy_archive_upload USING btree (expires_at, route, account_id);


--
-- Name: copy_live_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_live_created ON library.copy USING btree (route, account_id, created_at, copy_id) WHERE (deletion_id IS NULL);


--
-- Name: copy_live_profile_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_live_profile_pending ON library.copy USING btree (route, account_id, copy_id) WHERE ((library_profile_pin IS NULL) AND (deletion_id IS NULL));


--
-- Name: copy_live_raw_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_live_raw_source ON library.copy USING btree (route, account_id, subject_id, copy_id) WHERE (deletion_id IS NULL);


--
-- Name: copy_live_subject_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_live_subject_created ON library.copy USING btree (route, account_id, subject_id, created_at, copy_id) WHERE (deletion_id IS NULL);


--
-- Name: copy_profile_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_profile_pending ON library.copy USING btree (route, account_id, copy_id) WHERE (library_profile_pin IS NULL);


--
-- Name: copy_raw_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_raw_source ON library.copy USING btree (route, account_id, subject_id, copy_id);


--
-- Name: copy_retention_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_retention_due ON library.copy USING btree (partition_no, restore_until, route, copy_id) WHERE (deletion_id IS NOT NULL);


--
-- Name: entry_account_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_account_state ON library.entry USING btree (route, account_id, state, updated_at DESC, subject_id);


--
-- Name: entry_account_updated; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_account_updated ON library.entry USING btree (route, account_id, updated_at DESC, subject_id);


--
-- Name: entry_deleted_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_deleted_due ON library.entry_deleted USING btree (partition_no, restore_until, route, account_id, deletion_id);


--
-- Name: entry_deleted_profile_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_deleted_profile_pending ON library.entry_deleted USING btree (route, account_id, deletion_id) WHERE (library_profile_pin IS NULL);


--
-- Name: entry_profile_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_profile_pending ON library.entry USING btree (route, account_id, subject_id) WHERE (library_profile_pin IS NULL);


--
-- Name: entry_shelf_activity; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity ON library.entry USING btree (route, account_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_state ON library.entry USING btree (route, account_id, state, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_state_type ON library.entry USING btree (route, account_id, state, type_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_type ON library.entry USING btree (route, account_id, type_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created ON library.entry USING btree (route, account_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_state ON library.entry USING btree (route, account_id, state, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_state_type ON library.entry USING btree (route, account_id, state, type_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_type ON library.entry USING btree (route, account_id, type_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_finished; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished ON library.entry USING btree (route, account_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_state ON library.entry USING btree (route, account_id, state, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_state_type ON library.entry USING btree (route, account_id, state, type_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_type ON library.entry USING btree (route, account_id, type_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_source_observation_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_source_observation_owner ON library.entry_source_observation USING btree (route, account_id, subject_id, provider, record_id);


--
-- Name: entry_state_change_account_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_state_change_account_subject ON library.entry_state_change USING btree (route, account_id, subject_id, incarnation_id, revision DESC);


--
-- Name: entry_state_change_subject_retention; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_state_change_subject_retention ON library.entry_state_change USING btree (route, account_id, subject_id, changed_at DESC, incarnation_id, revision DESC);


--
-- Name: entry_type_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_type_source ON library.entry USING btree (type_source_id, route, account_id, subject_id);


--
-- Name: follow_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_account_page ON library.follow USING btree (route, account_id, state, updated_at DESC, target_id);


--
-- Name: follow_activity_recipients; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_activity_recipients ON library.follow_count_support USING btree (route, target_type, target_id, account_id) WHERE (support > 0);


--
-- Name: follow_count_account_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_account_pending ON library.follow_count_account_work USING btree (((route >> 4)), oldest_pending_at, route, account_id);


--
-- Name: follow_count_owner_bootstrap; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_owner_bootstrap ON library.follow_count_owner USING btree (partition_no, route, account_id) WHERE (NOT bootstrap_complete);


--
-- Name: follow_count_pair_follower; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_pair_follower ON library.follow_count_pair USING btree (route, account_id, target_type, target_id, original_id);


--
-- Name: follow_count_pair_original; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_pair_original ON library.follow_count_pair USING btree (route, original_id, account_id, target_type, target_id);


--
-- Name: follow_count_partition_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_partition_pending ON library.follow_count_source USING btree (partition_no, pending_since, route, account_id, target_type, target_id) WHERE (pending_since IS NOT NULL);


--
-- Name: follow_count_source_original_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_source_original_page ON library.follow_count_source USING btree (route, account_id, target_id, target_type);


--
-- Name: follow_count_source_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_source_pending ON library.follow_count_source USING btree (route, account_id, pending_since, target_type, target_id) WHERE (pending_since IS NOT NULL);


--
-- Name: follow_count_terminal_source_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_count_terminal_source_pending ON library.follow_count_terminal_source USING btree (partition_no, oldest_pending_at, account_id) WHERE (NOT local_complete);


--
-- Name: identity_epoch_participant_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX identity_epoch_participant_owner ON library.identity_epoch_participant_work USING btree (partition_no, owner_id, job_id, job_epoch, effect_key);


--
-- Name: identity_epoch_participant_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX identity_epoch_participant_pending ON library.identity_epoch_participant_work USING btree (partition_no, job_id, job_epoch, effect_key) WHERE (NOT custodied);


--
-- Name: identity_epoch_source_basis_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX identity_epoch_source_basis_owner ON library.identity_epoch_source_basis USING btree (partition_no, owner_id, job_id, job_epoch, effect_key);


--
-- Name: identity_scope_plan_capture; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX identity_scope_plan_capture ON library.identity_scope_plan USING btree (route, capture_id, collection_id, plan_key);


--
-- Name: identity_scope_plan_generation; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX identity_scope_plan_generation ON library.identity_scope_plan USING btree (route, collection_id, generation);


--
-- Name: identity_scope_plan_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX identity_scope_plan_owner ON library.identity_scope_plan USING btree (route, account_id, collection_id, plan_key);


--
-- Name: identity_scope_plan_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX identity_scope_plan_pending ON library.identity_scope_plan USING btree (route, job_id, job_epoch, collection_id, plan_key) WHERE (state = 'building'::text);


--
-- Name: label_assignment_owner_label; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX label_assignment_owner_label ON library.label_assignment USING btree (route, account_id, label_id, subject_id);


--
-- Name: label_assignment_purge_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX label_assignment_purge_due ON library.label_assignment USING btree (route, purge_after, account_id, subject_id, label_id) WHERE (deleted_at IS NOT NULL);


--
-- Name: label_assignment_reserved_slot; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX label_assignment_reserved_slot ON library.label_assignment USING btree (route, account_id, subject_id, slot_no) WHERE (slot_no IS NOT NULL);


--
-- Name: label_assignment_reserved_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX label_assignment_reserved_source ON library.label_assignment USING btree (route, account_id, subject_id, assignment_id) INCLUDE (label_id, slot_no, revision, transaction_id) WHERE (slot_no IS NOT NULL);


--
-- Name: library_export_copy_seek; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX library_export_copy_seek ON library.copy USING btree (route, account_id, copy_id) WHERE (deletion_id IS NULL);


--
-- Name: library_export_unit_seek; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX library_export_unit_seek ON library.progress_unit USING btree (route, session_id, unit_id COLLATE "C");


--
-- Name: list_import_mal_expiry; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX list_import_mal_expiry ON library.list_import_mal USING btree (expires_at);


--
-- Name: members_preparation_expiry; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX members_preparation_expiry ON library.members_preparation USING btree (route, last_read_at, owner_account_id, collection_id, episode_id) WHERE (state = 'live'::text);


--
-- Name: members_preparation_idle; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX members_preparation_idle ON library.members_preparation USING btree (((route >> 4)), last_read_at, route, owner_account_id, collection_id, episode_id) WHERE (state = 'live'::text);


--
-- Name: members_preparation_idle_retired; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX members_preparation_idle_retired ON library.members_preparation USING btree (((route >> 4)), last_read_at, route, owner_account_id, collection_id, episode_id) WHERE (state = 'retired'::text);


--
-- Name: members_preparation_live_digest; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX members_preparation_live_digest ON library.members_preparation USING btree (route, owner_account_id, basis_digest) WHERE (state = 'live'::text);


--
-- Name: members_preparation_live_lru; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX members_preparation_live_lru ON library.members_preparation USING btree (route, owner_account_id, last_read_at, episode_id) WHERE (state = 'live'::text);


--
-- Name: members_preparation_result_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX members_preparation_result_page ON library.members_preparation_result USING btree (route, owner_account_id, collection_id, episode_id, sort_key, subject_id);


--
-- Name: members_preparation_result_runtime_position; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX members_preparation_result_runtime_position ON library.members_preparation_result USING btree (route, owner_account_id, collection_id, episode_id, "position") WHERE ("position" IS NOT NULL);


--
-- Name: members_preparation_retired_cleanup; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX members_preparation_retired_cleanup ON library.members_preparation USING btree (route, owner_account_id, collection_id, episode_id) WHERE (state = 'retired'::text);


--
-- Name: native_public_output_retained; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_public_output_retained ON library.native_public_output_hold USING btree (route, collection_id, output_generation, incarnation, activation_transaction_id, activation_position, activation_source_generation) WHERE (consumed_by IS NULL);


--
-- Name: native_public_output_successor; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX native_public_output_successor ON library.native_public_output_transition USING btree (partition_no, successor_hold_id) WHERE (successor_hold_id IS NOT NULL);


--
-- Name: native_source_capture_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_capture_account ON library.native_source_capture USING btree (route, account_id, capture_id);


--
-- Name: native_source_capture_collection; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_capture_collection ON library.native_source_capture USING btree (route, collection_id, capture_id);


--
-- Name: native_source_capture_identity; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_capture_identity ON library.native_source_capture USING btree (route, collection_id, account_id, incarnation, generation, scope, owner_epoch, receiving_epoch, effect_key, collection_fence, account_fence, capture_id);


--
-- Name: native_source_fence_account; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_fence_account ON library.native_source_fence USING btree (route, account_id, kind, owner_id);


--
-- Name: native_source_hold_active; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_hold_active ON library.native_source_hold USING btree (route, capture_id, hold_id) WHERE (NOT released);


--
-- Name: native_source_member_raw; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_member_raw ON library.collection_member USING btree (route, collection_id, ordinal_key, member_id);


--
-- Name: native_source_output_raw; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX native_source_output_raw ON library.published_log USING btree (route, account_id, log_id);


--
-- Name: owner_identity_scope_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_identity_scope_owner ON library.owner_identity_scope USING btree (partition_no, owner_id, original, source_id, incarnation, role);


--
-- Name: owner_index_activity; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_activity ON library.owner_member_index USING btree (route, account_id, activity_at DESC, subject_id) WHERE (activity_at IS NOT NULL);


--
-- Name: owner_index_activity_unknown; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_activity_unknown ON library.owner_member_index USING btree (route, account_id, subject_id) WHERE activity_unknown;


--
-- Name: owner_index_copy_scope; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_copy_scope ON library.copy USING btree (route, account_id, subject_id, COALESCE(library_profile_pin, '{}'::jsonb)) WHERE (deletion_id IS NULL);


--
-- Name: owner_index_entry_scope; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_entry_scope ON library.entry USING btree (route, account_id, subject_id, COALESCE(library_profile_pin, '{}'::jsonb));


--
-- Name: owner_index_label_identified; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_label_identified ON library.label_assignment USING btree (route, account_id, subject_id, label_id) WHERE ((deleted_at IS NULL) AND (slot_no IS NOT NULL) AND (assignment_id IS NOT NULL));


--
-- Name: owner_index_label_legacy; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_label_legacy ON library.label_assignment USING btree (route, account_id, subject_id, label_id) WHERE ((deleted_at IS NULL) AND ((slot_no IS NULL) OR (assignment_id IS NULL)));


--
-- Name: owner_index_label_live; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_label_live ON library.label_assignment USING btree (route, account_id, subject_id, label_id) WHERE (deleted_at IS NULL);


--
-- Name: owner_index_pending_pin; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_pending_pin ON library.owner_index_pin USING btree (route, account_id, pin) WHERE (NOT meaning_ready);


--
-- Name: owner_index_session_scope; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_session_scope ON library.progress_session USING btree (route, account_id, subject_id, COALESCE(library_profile_pin, '{}'::jsonb));


--
-- Name: owner_index_state_collection; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_state_collection ON library.owner_index_state USING btree (route, account_id, collection_id, pin);


--
-- Name: owner_index_state_presentation; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_index_state_presentation ON library.owner_index_state USING btree (route, account_id, collection_id, ((pin ->> 'releaseDigest'::text)), pin);


--
-- Name: owner_member_support_pin; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX owner_member_support_pin ON library.owner_member_support USING btree (route, account_id, pin, subject_id, family);


--
-- Name: personal_label_live_name; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX personal_label_live_name ON library.personal_label USING btree (route, account_id, normalized_name) WHERE (deleted_at IS NULL);


--
-- Name: personal_label_purge_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX personal_label_purge_due ON library.personal_label USING btree (route, purge_after, account_id, label_id) WHERE (deleted_at IS NOT NULL);


--
-- Name: progress_session_account_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_account_subject ON library.progress_session USING btree (route, account_id, subject_id, started_at DESC, session_id);


--
-- Name: progress_session_active; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_active ON library.progress_session USING btree (route, account_id, subject_id, last_changed_at DESC, session_id) WHERE (state = 'active'::text);


--
-- Name: progress_session_diary_seek; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_diary_seek ON library.progress_session USING btree (route, account_id, started_at DESC, session_id DESC);


--
-- Name: progress_session_owner_seek; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_owner_seek ON library.progress_session USING btree (route, account_id, session_id);


--
-- Name: progress_session_profile_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_profile_pending ON library.progress_session USING btree (route, account_id, session_id) WHERE (library_profile_pin IS NULL);


--
-- Name: progress_session_raw_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_raw_source ON library.progress_session USING btree (route, account_id, subject_id, session_id);


--
-- Name: published_log_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX published_log_account_page ON library.published_log USING btree (route, account_id, published_at DESC, log_id) WHERE (NOT deleted);


--
-- Name: published_log_due; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX published_log_due ON library.published_log USING btree (partition_no, restore_until, route, log_id) WHERE (deleted AND (restore_until IS NOT NULL));


--
-- Name: published_log_owner; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX published_log_owner ON library.published_log USING btree (route, account_id, log_id) WHERE (account_id IS NOT NULL);


--
-- Name: shelf_count_types; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_count_types ON library.shelf_count USING btree (route, account_id, generation_id, type_id) WHERE ((bucket = 'all'::text) AND (type_id <> '00000000-0000-0000-0000-000000000000'::uuid) AND (n > 0));


--
-- Name: shelf_maintenance_runnable; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_maintenance_runnable ON library.shelf_maintenance_run USING btree (route, account_id, run_id) WHERE ((NOT cancelled) AND (phase <> 'complete'::text));


--
-- Name: shelf_maintenance_step_evidence; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_maintenance_step_evidence ON library.shelf_maintenance_step USING btree (route, account_id, run_id, epoch, sequence) WHERE ((input_identity IS NOT NULL) OR (cursor <> '[]'::jsonb));


--
-- Name: shelf_type_node_terminal_type; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX shelf_type_node_terminal_type ON library.shelf_type_node USING btree (route, account_id, terminal_type_id) WHERE (terminal_type_id IS NOT NULL);


--
-- Name: shelf_type_reservation_generation; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_type_reservation_generation ON library.shelf_type_reservation USING btree (route, account_id, generation_id, reservation_id);


--
-- Name: shelf_writer_owner_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_writer_owner_pending ON library.shelf_writer_owner USING btree (route, account_id, requested_run) WHERE enqueue_pending;


--
-- Name: subject_collection_reverse; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX subject_collection_reverse ON library.subject_collection USING btree (collection_route, collection_id, route, subject_id);


--
-- Name: subject_collection_version_reverse; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX subject_collection_version_reverse ON library.subject_collection_version USING btree (collection_route, collection_id, route, subject_id);


--
-- Name: type_preparation_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX type_preparation_pending ON library.type_preparation_progress USING btree (route, account_id, preparation_id) WHERE (enqueue_pending AND (state = 'pending'::text));


--
-- Name: type_preparation_request; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX type_preparation_request ON library.type_preparation_header USING btree (route, account_id, ((binding ->> 'subjectId'::text)), ((binding ->> 'requestKey'::text)), principal_namespace, created_at DESC, preparation_id DESC);


--
-- Name: collection_kind_consent_consumer collection_kind_original_cancel; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_kind_original_cancel AFTER DELETE OR UPDATE ON library.collection_kind_consent_consumer FOR EACH ROW EXECUTE FUNCTION library.collection_kind_original_cancel();


--
-- Name: collection_kind_audience_origin collection_kind_original_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_kind_original_immutable BEFORE UPDATE ON library.collection_kind_audience_origin FOR EACH ROW EXECUTE FUNCTION library.collection_kind_original_immutable();


--
-- Name: collection_kind_raw_input collection_kind_raw_input_commit; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER collection_kind_raw_input_commit AFTER INSERT ON library.collection_kind_raw_input DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.collection_kind_raw_input_commit();


--
-- Name: collection_kind_raw_input collection_kind_raw_input_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_kind_raw_input_immutable BEFORE UPDATE ON library.collection_kind_raw_input FOR EACH ROW EXECUTE FUNCTION library.collection_kind_raw_input_immutable();


--
-- Name: collection collection_listing_public_history_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_listing_public_history_guard BEFORE INSERT OR DELETE OR UPDATE ON library.collection FOR EACH ROW EXECUTE FUNCTION library.collection_listing_public_history_guard();


--
-- Name: collection_member collection_member_retained_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_member_retained_immutable BEFORE INSERT OR DELETE OR UPDATE ON library.collection_member FOR EACH ROW EXECUTE FUNCTION library.guard_retained_collection_member();


--
-- Name: collection collection_membership_kind_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_membership_kind_immutable BEFORE UPDATE OF membership_kind ON library.collection FOR EACH ROW EXECUTE FUNCTION library.guard_collection_membership_kind();


--
-- Name: collection_order_repair collection_order_capture; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_order_capture BEFORE UPDATE ON library.collection_order_repair FOR EACH ROW EXECUTE FUNCTION library.guard_collection_order_capture();


--
-- Name: collection_member collection_order_member; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_order_member BEFORE INSERT OR DELETE OR UPDATE ON library.collection_member FOR EACH ROW EXECUTE FUNCTION library.guard_collection_order_member();


--
-- Name: collection collection_order_parent; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_order_parent BEFORE DELETE OR UPDATE ON library.collection FOR EACH ROW EXECUTE FUNCTION library.guard_collection_order_parent();


--
-- Name: collection_source_output_head collection_output_frozen_head; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_output_frozen_head BEFORE INSERT OR DELETE OR UPDATE ON library.collection_source_output_head FOR EACH ROW EXECUTE FUNCTION library.guard_frozen_output();


--
-- Name: collection_source_output collection_output_frozen_header; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_output_frozen_header BEFORE INSERT OR DELETE OR UPDATE ON library.collection_source_output FOR EACH ROW EXECUTE FUNCTION library.guard_frozen_output();


--
-- Name: collection_source_output_member collection_output_frozen_member; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_output_frozen_member BEFORE INSERT OR DELETE OR UPDATE ON library.collection_source_output_member FOR EACH ROW EXECUTE FUNCTION library.guard_frozen_output();


--
-- Name: collection_source_output_member collection_output_members; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_output_members AFTER INSERT OR DELETE OR UPDATE ON library.collection_source_output_member FOR EACH ROW EXECUTE FUNCTION library.track_output_members();


--
-- Name: collection_source_output_publication collection_output_publication_commit; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER collection_output_publication_commit AFTER INSERT ON library.collection_source_output_publication DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_output_publication_commit();


--
-- Name: collection_source_output_publication collection_output_publication_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_output_publication_immutable BEFORE UPDATE ON library.collection_source_output_publication FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();


--
-- Name: collection_publication_operation collection_publication_commit; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER collection_publication_commit AFTER INSERT ON library.collection_publication_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_publication_episode_commit();


--
-- Name: collection_publication_operation collection_publication_operation_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_publication_operation_immutable BEFORE UPDATE ON library.collection_publication_operation FOR EACH ROW EXECUTE FUNCTION library.publication_immutable();


--
-- Name: collection_publication_source collection_publication_source_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_publication_source_immutable BEFORE UPDATE ON library.collection_publication_source FOR EACH ROW EXECUTE FUNCTION library.publication_immutable();


--
-- Name: collection collection_retained_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_retained_immutable BEFORE UPDATE ON library.collection FOR EACH ROW EXECUTE FUNCTION library.guard_retained_collection();


--
-- Name: collection_retained_output collection_retained_output_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_retained_output_immutable BEFORE DELETE OR UPDATE ON library.collection_retained_output FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();


--
-- Name: collection_retained_output collection_retained_output_insert; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_retained_output_insert BEFORE INSERT ON library.collection_retained_output FOR EACH ROW EXECUTE FUNCTION library.guard_retained_output_insert();


--
-- Name: collection collection_rule_minimization; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER collection_rule_minimization BEFORE UPDATE OF curator_account_id ON library.collection FOR EACH ROW EXECUTE FUNCTION library.minimize_collection_rule();


--
-- Name: progress_session consumption_statistics_receive; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER consumption_statistics_receive AFTER INSERT OR DELETE OR UPDATE ON library.progress_session FOR EACH ROW EXECUTE FUNCTION library.consumption_statistics_receive();


--
-- Name: progress_session consumption_statistics_truncate; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER consumption_statistics_truncate AFTER TRUNCATE ON library.progress_session FOR EACH STATEMENT EXECUTE FUNCTION library.consumption_statistics_truncate();


--
-- Name: copy copy_fact_source_delete; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER copy_fact_source_delete AFTER DELETE ON library.copy FOR EACH ROW WHEN ((old.deletion_id IS NULL)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: copy copy_fact_source_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER copy_fact_source_rows AFTER INSERT ON library.copy FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: copy copy_fact_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER copy_fact_source_update AFTER UPDATE ON library.copy FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: copy copy_profile_migration_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER copy_profile_migration_writer BEFORE INSERT OR UPDATE ON library.copy FOR EACH ROW EXECUTE FUNCTION library.fence_profile_migration_writer();


--
-- Name: entry entry_fact_source_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_fact_source_rows AFTER INSERT OR DELETE ON library.entry FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: entry entry_fact_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_fact_source_update AFTER UPDATE ON library.entry FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: entry_personal_fact entry_personal_fact_native_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_personal_fact_native_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry_personal_fact FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: entry_personal_fact entry_personal_fact_source_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_personal_fact_source_rows AFTER INSERT OR DELETE ON library.entry_personal_fact FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: entry_personal_fact entry_personal_fact_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_personal_fact_source_update AFTER UPDATE ON library.entry_personal_fact FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: entry entry_profile_migration_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_profile_migration_writer BEFORE INSERT OR UPDATE ON library.entry FOR EACH ROW EXECUTE FUNCTION library.fence_profile_migration_writer();


--
-- Name: entry_source_observation entry_source_observation_native_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_source_observation_native_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry_source_observation FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: entry_source_observation entry_source_observation_source_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_source_observation_source_rows AFTER INSERT OR DELETE ON library.entry_source_observation FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: entry_source_observation entry_source_observation_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER entry_source_observation_source_update AFTER UPDATE ON library.entry_source_observation FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: bangumi_upload export_owner_fence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER export_owner_fence AFTER INSERT OR DELETE OR UPDATE ON library.bangumi_upload FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: bangumi_upload_row export_owner_fence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER export_owner_fence AFTER INSERT OR DELETE OR UPDATE ON library.bangumi_upload_row FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: collection export_owner_fence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER export_owner_fence AFTER INSERT OR DELETE OR UPDATE ON library.collection FOR EACH ROW EXECUTE FUNCTION library.advance_export_collection_fence();


--
-- Name: collection_member export_owner_fence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER export_owner_fence AFTER INSERT OR DELETE OR UPDATE ON library.collection_member FOR EACH ROW EXECUTE FUNCTION library.advance_export_collection_fence();


--
-- Name: collection_pins export_owner_fence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER export_owner_fence AFTER INSERT OR DELETE OR UPDATE ON library.collection_pins FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: list_import_mal export_owner_fence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER export_owner_fence AFTER INSERT OR DELETE OR UPDATE ON library.list_import_mal FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: collection follow_count_new_collection; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER follow_count_new_collection AFTER INSERT ON library.collection FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_total();


--
-- Name: follow follow_count_source_change; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER follow_count_source_change AFTER INSERT OR DELETE OR UPDATE ON library.follow FOR EACH ROW EXECUTE FUNCTION library.record_follow_count_source();


--
-- Name: follow follow_target_type_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER follow_target_type_immutable BEFORE UPDATE OF target_type ON library.follow FOR EACH ROW EXECUTE FUNCTION library.guard_follow_target_type();


--
-- Name: identity_scope_effect identity_scope_effect_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER identity_scope_effect_immutable BEFORE DELETE OR UPDATE ON library.identity_scope_effect FOR EACH ROW EXECUTE FUNCTION library.guard_identity_scope_evidence();


--
-- Name: identity_scope_seal identity_scope_seal_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER identity_scope_seal_immutable BEFORE DELETE OR UPDATE ON library.identity_scope_seal FOR EACH ROW EXECUTE FUNCTION library.guard_identity_scope_evidence();


--
-- Name: label_assignment label_assignment_fact_source_delete; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER label_assignment_fact_source_delete AFTER DELETE ON library.label_assignment FOR EACH ROW WHEN (((old.deleted_at IS NULL) AND (old.slot_no IS NOT NULL))) EXECUTE FUNCTION library.advance_live_label_assignment_delete_source_head();


--
-- Name: label_assignment label_assignment_fact_source_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER label_assignment_fact_source_rows AFTER INSERT ON library.label_assignment FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: label_assignment label_assignment_fact_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER label_assignment_fact_source_update AFTER UPDATE ON library.label_assignment FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: subject_collection live_copy_listing_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER live_copy_listing_guard BEFORE INSERT OR UPDATE ON library.subject_collection FOR EACH ROW EXECUTE FUNCTION library.guard_live_copy_listing();


--
-- Name: subject_collection_version live_copy_listing_version_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER live_copy_listing_version_guard BEFORE INSERT OR UPDATE ON library.subject_collection_version FOR EACH ROW EXECUTE FUNCTION library.guard_live_copy_listing();


--
-- Name: native_public_output_binding native_public_output_binding_commit; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_binding_commit AFTER INSERT ON library.native_public_output_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_binding_commit();


--
-- Name: native_public_output_binding native_public_output_binding_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_binding_immutable BEFORE DELETE OR UPDATE ON library.native_public_output_binding FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();


--
-- Name: collection native_public_output_collection_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_collection_guard BEFORE INSERT OR DELETE OR UPDATE ON library.collection FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();


--
-- Name: collection_source_output native_public_output_header_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_header_guard BEFORE INSERT OR DELETE OR UPDATE ON library.collection_source_output FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();


--
-- Name: native_public_output_hold native_public_output_hold_consumed; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_hold_consumed AFTER UPDATE ON library.native_public_output_hold DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_transition_commit();


--
-- Name: native_public_output_hold native_public_output_hold_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_hold_guard BEFORE INSERT OR DELETE OR UPDATE ON library.native_public_output_hold FOR EACH ROW EXECUTE FUNCTION library.guard_public_output_hold();


--
-- Name: collection_source_output_member native_public_output_member_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_member_guard BEFORE INSERT OR DELETE OR UPDATE ON library.collection_source_output_member FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();


--
-- Name: collection_source_output_publication native_public_output_publication_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_publication_guard BEFORE INSERT OR DELETE OR UPDATE ON library.collection_source_output_publication FOR EACH ROW EXECUTE FUNCTION library.guard_retained_public_output();


--
-- Name: native_public_output_receiving native_public_output_receiving_closed; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_receiving_closed AFTER UPDATE ON library.native_public_output_receiving DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_transition_commit();


--
-- Name: native_public_output_receiving native_public_output_receiving_guard; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_receiving_guard BEFORE DELETE OR UPDATE ON library.native_public_output_receiving FOR EACH ROW EXECUTE FUNCTION library.guard_public_output_receiving();


--
-- Name: native_public_output_binding native_public_output_semantic_binding; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_semantic_binding AFTER INSERT ON library.native_public_output_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_semantic_binding();


--
-- Name: native_public_output_transition native_public_output_semantic_disposition; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_semantic_disposition AFTER INSERT ON library.native_public_output_transition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_semantic_disposition();


--
-- Name: native_public_output_hold native_public_output_successor_commit; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_successor_commit AFTER INSERT ON library.native_public_output_hold DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_successor_commit();


--
-- Name: native_public_output_transition native_public_output_transition_commit; Type: TRIGGER; Schema: library; Owner: -
--

CREATE CONSTRAINT TRIGGER native_public_output_transition_commit AFTER INSERT ON library.native_public_output_transition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_public_output_transition_commit();


--
-- Name: native_public_output_transition native_public_output_transition_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_public_output_transition_immutable BEFORE DELETE OR UPDATE ON library.native_public_output_transition FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();


--
-- Name: collection_source_output native_source_output_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_output_writer AFTER INSERT OR DELETE OR UPDATE ON library.collection_source_output FOR EACH ROW EXECUTE FUNCTION library.fence_selected_output();


--
-- Name: collection_source_output_head native_source_output_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_output_writer AFTER INSERT OR DELETE OR UPDATE ON library.collection_source_output_head FOR EACH ROW EXECUTE FUNCTION library.fence_selected_output();


--
-- Name: native_source_receipt native_source_receipt_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_receipt_immutable BEFORE UPDATE ON library.native_source_receipt FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();


--
-- Name: collection native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.collection FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: collection_member native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.collection_member FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: copy native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.copy FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: entry native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: entry_deleted native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry_deleted FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: fact_source_head native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.fact_source_head FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: label_assignment native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.label_assignment FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: personal_label native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.personal_label FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: progress_change native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.progress_change FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: progress_session native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.progress_session FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: progress_unit native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.progress_unit FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: published_log native_source_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER native_source_writer AFTER INSERT OR DELETE OR UPDATE ON library.published_log FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: owner_member_index owner_index_activity_insert; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER owner_index_activity_insert BEFORE INSERT ON library.owner_member_index FOR EACH ROW EXECUTE FUNCTION library.initialize_owner_activity();


--
-- Name: personal_label personal_label_fact_source_delete; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER personal_label_fact_source_delete AFTER DELETE ON library.personal_label FOR EACH ROW WHEN ((old.deleted_at IS NULL)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: personal_label personal_label_fact_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER personal_label_fact_source_update AFTER UPDATE ON library.personal_label FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: progress_session progress_session_fact_source_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER progress_session_fact_source_rows AFTER INSERT OR DELETE ON library.progress_session FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: progress_session progress_session_fact_source_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER progress_session_fact_source_update AFTER UPDATE ON library.progress_session FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: collection_publication_staging_evidence publication_staging_evidence; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER publication_staging_evidence AFTER INSERT OR DELETE OR UPDATE ON library.collection_publication_staging_evidence FOR EACH ROW EXECUTE FUNCTION library.track_publication_staging_evidence();


--
-- Name: collection_publication_staging_seal publication_staging_seal_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER publication_staging_seal_immutable BEFORE UPDATE ON library.collection_publication_staging_seal FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();


--
-- Name: published_log published_log_fact_delete; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER published_log_fact_delete AFTER DELETE ON library.published_log FOR EACH ROW WHEN (((old.account_id IS NOT NULL) AND (NOT old.deleted))) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: published_log published_log_fact_insert; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER published_log_fact_insert AFTER INSERT ON library.published_log FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: published_log published_log_fact_visibility; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER published_log_fact_visibility AFTER UPDATE ON library.published_log FOR EACH ROW WHEN ((old.deleted IS DISTINCT FROM new.deleted)) EXECUTE FUNCTION library.advance_fact_source_head();


--
-- Name: progress_session reported_year_receive; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER reported_year_receive BEFORE INSERT OR DELETE OR UPDATE ON library.progress_session FOR EACH ROW EXECUTE FUNCTION library.reported_year_receive();


--
-- Name: progress_session reported_year_truncate; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER reported_year_truncate AFTER TRUNCATE ON library.progress_session FOR EACH STATEMENT EXECUTE FUNCTION library.reported_year_truncate();


--
-- Name: progress_session session_profile_migration_writer; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER session_profile_migration_writer BEFORE INSERT OR UPDATE ON library.progress_session FOR EACH ROW EXECUTE FUNCTION library.fence_profile_migration_writer();


--
-- Name: shelf_type_reservation shelf_type_reservation_input_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER shelf_type_reservation_input_immutable BEFORE INSERT OR UPDATE ON library.shelf_type_reservation FOR EACH ROW EXECUTE FUNCTION library.guard_shelf_type_reservation_input();


--
-- Name: subject_collection_source_fence subject_collection_source_fence_order; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER subject_collection_source_fence_order BEFORE UPDATE ON library.subject_collection_source_fence FOR EACH ROW EXECUTE FUNCTION library.guard_listing_order();


--
-- Name: subject_collection_version subject_collection_version_order; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER subject_collection_version_order BEFORE UPDATE ON library.subject_collection_version FOR EACH ROW EXECUTE FUNCTION library.guard_listing_order();


--
-- Name: type_preparation_header type_preparation_header_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER type_preparation_header_immutable BEFORE UPDATE ON library.type_preparation_header FOR EACH ROW EXECUTE FUNCTION library.guard_type_preparation_header();


--
-- Name: entry_personal_fact zz_entry_personal_fact_owner_scope_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_entry_personal_fact_owner_scope_rows AFTER INSERT OR DELETE ON library.entry_personal_fact FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: entry_personal_fact zz_entry_personal_fact_owner_scope_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_entry_personal_fact_owner_scope_update AFTER UPDATE ON library.entry_personal_fact FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: entry_source_observation zz_entry_source_observation_owner_scope_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_entry_source_observation_owner_scope_rows AFTER INSERT OR DELETE ON library.entry_source_observation FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: entry_source_observation zz_entry_source_observation_owner_scope_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_entry_source_observation_owner_scope_update AFTER UPDATE ON library.entry_source_observation FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: copy zz_owner_index_copy_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_copy_rows AFTER INSERT OR DELETE ON library.copy FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: copy zz_owner_index_copy_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_copy_update AFTER UPDATE OF deletion_id, library_profile_pin, subject_id ON library.copy FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: entry zz_owner_index_entry_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_entry_rows AFTER INSERT OR DELETE ON library.entry FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: entry zz_owner_index_entry_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_entry_update AFTER UPDATE OF state, library_profile_pin, owner_write_seq ON library.entry FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: label_assignment zz_owner_index_label_assignment_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_label_assignment_rows AFTER INSERT OR DELETE ON library.label_assignment FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: label_assignment zz_owner_index_label_assignment_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_label_assignment_update AFTER UPDATE OF deleted_at, slot_no, label_id, subject_id ON library.label_assignment FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: personal_label zz_owner_index_label_parent; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_label_parent AFTER DELETE OR UPDATE OF deleted_at ON library.personal_label FOR EACH ROW EXECUTE FUNCTION library.queue_owner_label_repair();


--
-- Name: progress_session zz_owner_index_progress_session_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_progress_session_rows AFTER INSERT OR DELETE ON library.progress_session FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: progress_session zz_owner_index_progress_session_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zz_owner_index_progress_session_update AFTER UPDATE OF state, library_profile_pin, subject_id ON library.progress_session FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_member_scope();


--
-- Name: entry zzz_owner_activity_entry_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zzz_owner_activity_entry_rows AFTER INSERT OR DELETE ON library.entry FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_activity();


--
-- Name: entry zzz_owner_activity_entry_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zzz_owner_activity_entry_update AFTER UPDATE OF activity_at, subject_id ON library.entry FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_activity();


--
-- Name: progress_head zzz_owner_activity_progress_rows; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zzz_owner_activity_progress_rows AFTER INSERT OR DELETE ON library.progress_head FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_activity();


--
-- Name: progress_head zzz_owner_activity_progress_update; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER zzz_owner_activity_progress_update AFTER UPDATE OF last_changed_at, subject_id ON library.progress_head FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION library.maintain_owner_activity();


--
-- Name: bangumi_upload_row bangumi_upload_row_route_account_id_upload_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bangumi_upload_row
    ADD CONSTRAINT bangumi_upload_row_route_account_id_upload_id_fkey FOREIGN KEY (route, account_id, upload_id) REFERENCES library.bangumi_upload(route, account_id, upload_id) ON DELETE CASCADE;


--
-- Name: builtin_state_reference_source builtin_state_reference_source_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.builtin_state_reference_source
    ADD CONSTRAINT builtin_state_reference_source_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.builtin_collection_reference(route, collection_id);


--
-- Name: canonical_source_fact canonical_source_fact_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_fact
    ADD CONSTRAINT canonical_source_fact_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: canonical_source_generation canonical_source_generation_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_generation
    ADD CONSTRAINT canonical_source_generation_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: canonical_source_head canonical_source_head_route_collection_id_generation_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_head
    ADD CONSTRAINT canonical_source_head_route_collection_id_generation_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.canonical_source_generation(route, collection_id, generation);


--
-- Name: canonical_source_reference canonical_source_reference_route_collection_id_generation_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_reference
    ADD CONSTRAINT canonical_source_reference_route_collection_id_generation_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.canonical_source_generation(route, collection_id, generation);


--
-- Name: canonical_source_scope canonical_source_scope_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_scope
    ADD CONSTRAINT canonical_source_scope_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: canonical_source_state canonical_source_state_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.canonical_source_state
    ADD CONSTRAINT canonical_source_state_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: collection_kind_audience_origin collection_kind_audience_orig_route_collection_id_audience_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_audience_origin
    ADD CONSTRAINT collection_kind_audience_orig_route_collection_id_audience_fkey FOREIGN KEY (route, collection_id, audience) REFERENCES library.collection_kind_observation(route, collection_id, audience) ON DELETE CASCADE;


--
-- Name: collection_kind_consent_transition collection_kind_consent_transition_route_reference_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_consent_transition
    ADD CONSTRAINT collection_kind_consent_transition_route_reference_id_fkey FOREIGN KEY (route, reference_id) REFERENCES library.collection_kind_consent_consumer(route, reference_id) ON DELETE CASCADE;


--
-- Name: collection_kind_raw_input collection_kind_raw_input_route_origin_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_kind_raw_input
    ADD CONSTRAINT collection_kind_raw_input_route_origin_id_fkey FOREIGN KEY (route, origin_id) REFERENCES library.collection_kind_audience_origin(route, origin_id) ON DELETE CASCADE;


--
-- Name: collection_member collection_member_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: collection_order_repair collection_order_repair_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_order_repair
    ADD CONSTRAINT collection_order_repair_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id) ON DELETE CASCADE;


--
-- Name: collection_publication_episode collection_publication_episode_route_publication_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_episode
    ADD CONSTRAINT collection_publication_episode_route_publication_id_fkey FOREIGN KEY (route, publication_id) REFERENCES library.collection_publication_operation(route, publication_id);


--
-- Name: collection_publication_episode collection_publication_episode_route_source_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_episode
    ADD CONSTRAINT collection_publication_episode_route_source_id_fkey FOREIGN KEY (route, source_id) REFERENCES library.collection_publication_source(route, source_id);


--
-- Name: collection_publication_source collection_publication_source_route_publication_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_source
    ADD CONSTRAINT collection_publication_source_route_publication_id_fkey FOREIGN KEY (route, publication_id) REFERENCES library.collection_publication_operation(route, publication_id);


--
-- Name: collection_publication_source collection_publication_source_route_source_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_source
    ADD CONSTRAINT collection_publication_source_route_source_id_fkey FOREIGN KEY (route, source_id) REFERENCES library.collection_publication_operation(route, source_id);


--
-- Name: collection_publication_staging_evidence collection_publication_stagi_route_collection_id_generati_fkey1; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging_evidence
    ADD CONSTRAINT collection_publication_stagi_route_collection_id_generati_fkey1 FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_publication_staging(route, collection_id, generation);


--
-- Name: collection_publication_staging_seal collection_publication_stagi_route_collection_id_generati_fkey2; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging_seal
    ADD CONSTRAINT collection_publication_stagi_route_collection_id_generati_fkey2 FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_publication_staging(route, collection_id, generation);


--
-- Name: collection_publication_staging collection_publication_stagin_route_collection_id_generati_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_publication_staging
    ADD CONSTRAINT collection_publication_stagin_route_collection_id_generati_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_source_output(route, collection_id, generation);


--
-- Name: collection_retained_output collection_retained_output_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_retained_output
    ADD CONSTRAINT collection_retained_output_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES editorial.write_basis(partition_no, transaction_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: collection_retained_output collection_retained_output_route_collection_id_generation_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_retained_output
    ADD CONSTRAINT collection_retained_output_route_collection_id_generation_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_source_output(route, collection_id, generation);


--
-- Name: collection_source_output_head collection_source_output_head_route_collection_id_generati_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_head
    ADD CONSTRAINT collection_source_output_head_route_collection_id_generati_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_source_output(route, collection_id, generation);


--
-- Name: collection_source_output_member collection_source_output_memb_route_collection_id_generati_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_member
    ADD CONSTRAINT collection_source_output_memb_route_collection_id_generati_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_source_output(route, collection_id, generation);


--
-- Name: collection_source_output_publication collection_source_output_publ_route_collection_id_generati_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_publication
    ADD CONSTRAINT collection_source_output_publ_route_collection_id_generati_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.collection_source_output(route, collection_id, generation);


--
-- Name: collection_source_output_publication collection_source_output_publi_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output_publication
    ADD CONSTRAINT collection_source_output_publi_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES editorial.write_basis(partition_no, transaction_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: collection_source_output collection_source_output_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_source_output
    ADD CONSTRAINT collection_source_output_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: copy_archive_row copy_archive_row_route_account_id_upload_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy_archive_row
    ADD CONSTRAINT copy_archive_row_route_account_id_upload_id_fkey FOREIGN KEY (route, account_id, upload_id) REFERENCES library.copy_archive_upload(route, account_id, upload_id);


--
-- Name: entry_source_observation entry_source_observation_parent_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry_source_observation
    ADD CONSTRAINT entry_source_observation_parent_fkey FOREIGN KEY (route, account_id, subject_id) REFERENCES library.entry_personal_fact(route, account_id, subject_id) ON DELETE CASCADE;


--
-- Name: follow_count_terminal_source follow_count_terminal_source_partition_no_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow_count_terminal_source
    ADD CONSTRAINT follow_count_terminal_source_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: identity_scope_effect identity_scope_effect_route_collection_id_plan_key_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_effect
    ADD CONSTRAINT identity_scope_effect_route_collection_id_plan_key_fkey FOREIGN KEY (route, collection_id, plan_key) REFERENCES library.identity_scope_plan(route, collection_id, plan_key);


--
-- Name: identity_scope_plan identity_scope_plan_route_capture_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_plan
    ADD CONSTRAINT identity_scope_plan_route_capture_id_fkey FOREIGN KEY (route, capture_id) REFERENCES library.native_source_capture(route, capture_id);


--
-- Name: identity_scope_plan identity_scope_plan_route_collection_id_generation_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_plan
    ADD CONSTRAINT identity_scope_plan_route_collection_id_generation_fkey FOREIGN KEY (route, collection_id, generation) REFERENCES library.canonical_source_generation(route, collection_id, generation);


--
-- Name: identity_scope_plan identity_scope_plan_route_collection_id_old_head_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_plan
    ADD CONSTRAINT identity_scope_plan_route_collection_id_old_head_fkey FOREIGN KEY (route, collection_id, old_head) REFERENCES library.canonical_source_generation(route, collection_id, generation);


--
-- Name: identity_scope_seal identity_scope_seal_route_collection_id_plan_key_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.identity_scope_seal
    ADD CONSTRAINT identity_scope_seal_route_collection_id_plan_key_fkey FOREIGN KEY (route, collection_id, plan_key) REFERENCES library.identity_scope_plan(route, collection_id, plan_key);


--
-- Name: label_assignment label_assignment_route_account_id_label_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.label_assignment
    ADD CONSTRAINT label_assignment_route_account_id_label_id_fkey FOREIGN KEY (route, account_id, label_id) REFERENCES library.personal_label(route, account_id, label_id);


--
-- Name: members_preparation_result members_preparation_result_route_owner_account_id_collecti_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.members_preparation_result
    ADD CONSTRAINT members_preparation_result_route_owner_account_id_collecti_fkey FOREIGN KEY (route, owner_account_id, collection_id, episode_id) REFERENCES library.members_preparation(route, owner_account_id, collection_id, episode_id);


--
-- Name: native_public_output_binding native_public_output_binding_partition_no_accepted_transac_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_binding
    ADD CONSTRAINT native_public_output_binding_partition_no_accepted_transac_fkey FOREIGN KEY (partition_no, accepted_transaction_id, owner_epoch, accepted_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: native_public_output_hold native_public_output_consumption; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_hold
    ADD CONSTRAINT native_public_output_consumption FOREIGN KEY (partition_no, consumed_by) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: native_public_output_hold native_public_output_hold_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_hold
    ADD CONSTRAINT native_public_output_hold_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES library.native_public_output_binding(partition_no, capture_id);


--
-- Name: native_public_output_receiving native_public_output_receiving_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_receiving
    ADD CONSTRAINT native_public_output_receiving_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES library.native_public_output_binding(partition_no, capture_id);


--
-- Name: native_public_output_transition native_public_output_transiti_partition_no_successor_hold__fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_transition
    ADD CONSTRAINT native_public_output_transiti_partition_no_successor_hold__fkey FOREIGN KEY (partition_no, successor_hold_id) REFERENCES library.native_public_output_hold(partition_no, hold_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: native_public_output_transition native_public_output_transiti_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_transition
    ADD CONSTRAINT native_public_output_transiti_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, epoch, "position") REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: native_public_output_transition native_public_output_transition_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_transition
    ADD CONSTRAINT native_public_output_transition_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES library.native_public_output_binding(partition_no, capture_id);


--
-- Name: native_public_output_transition native_public_output_transition_partition_no_hold_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_public_output_transition
    ADD CONSTRAINT native_public_output_transition_partition_no_hold_id_fkey FOREIGN KEY (partition_no, hold_id) REFERENCES library.native_public_output_hold(partition_no, hold_id);


--
-- Name: native_source_hold native_source_hold_route_capture_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_source_hold
    ADD CONSTRAINT native_source_hold_route_capture_id_fkey FOREIGN KEY (route, capture_id) REFERENCES library.native_source_receipt(route, capture_id);


--
-- Name: native_source_receipt native_source_receipt_route_capture_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.native_source_receipt
    ADD CONSTRAINT native_source_receipt_route_capture_id_fkey FOREIGN KEY (route, capture_id) REFERENCES library.native_source_capture(route, capture_id);


--
-- Name: owner_index_state owner_index_state_route_account_id_pin_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.owner_index_state
    ADD CONSTRAINT owner_index_state_route_account_id_pin_fkey FOREIGN KEY (route, account_id, pin) REFERENCES library.owner_index_pin(route, account_id, pin) ON DELETE CASCADE;


--
-- Name: progress_change progress_change_route_session_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_change
    ADD CONSTRAINT progress_change_route_session_id_fkey FOREIGN KEY (route, session_id) REFERENCES library.progress_session(route, session_id);


--
-- Name: progress_unit progress_unit_route_session_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_unit
    ADD CONSTRAINT progress_unit_route_session_id_fkey FOREIGN KEY (route, session_id) REFERENCES library.progress_session(route, session_id);


--
-- Name: shelf_type_node shelf_type_node_terminal_type_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_node
    ADD CONSTRAINT shelf_type_node_terminal_type_id_fkey FOREIGN KEY (route, account_id, terminal_type_id) REFERENCES library.shelf_type_value(route, account_id, type_id);


--
-- Name: shelf_type_root shelf_type_root_primary_type_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_root
    ADD CONSTRAINT shelf_type_root_primary_type_id_fkey FOREIGN KEY (route, account_id, primary_type_id) REFERENCES library.shelf_type_value(route, account_id, type_id);


--
-- Name: type_preparation_progress type_preparation_progress_route_account_id_preparation_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_route_account_id_preparation_id_fkey FOREIGN KEY (route, account_id, preparation_id) REFERENCES library.type_preparation_header(route, account_id, preparation_id);


--
-- Name: type_preparation_progress type_preparation_progress_route_account_id_type_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_route_account_id_type_id_fkey FOREIGN KEY (route, account_id, type_id) REFERENCES library.shelf_type_value(route, account_id, type_id);


--
-- Name: type_preparation_slot type_preparation_slot_route_account_id_binding_digest_prep_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_slot
    ADD CONSTRAINT type_preparation_slot_route_account_id_binding_digest_prep_fkey FOREIGN KEY (route, account_id, binding_digest, preparation_id) REFERENCES library.type_preparation_header(route, account_id, binding_digest, preparation_id);


--
-- PostgreSQL database dump complete
--


