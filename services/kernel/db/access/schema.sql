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
-- Name: access; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA access;


--
-- Name: account_discovery_after(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.account_discovery_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; a uuid; v bigint; delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.state = 'active' AND NOT OLD.authn_fenced THEN delta := delta - 1; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.state = 'active' AND NOT NEW.authn_fenced THEN delta := delta + 1; END IF;
    r := NEW.route; a := NEW.account_id; v := NEW.discovery_revision;
  ELSE
    r := OLD.route; a := OLD.account_id; v := nextval('access.account_discovery_revision');
  END IF;
  UPDATE access.account_discovery_population SET population = population + delta, revision = v WHERE partition_no = r >> 4;
  PERFORM semantic.enqueue_account_public_filter(partition_no,revision,claim_revision)
    FROM access.account_discovery_population WHERE partition_no=r >> 4;
  IF TG_OP <> 'UPDATE' OR NOT access.native_terminal_account_ready(OLD) THEN
    INSERT INTO access.account_discovery_intent VALUES (r, a, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.state = 'deleted' THEN
    DELETE FROM access.account_discovery_claim_cursor WHERE route = r AND account_id = a;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: account_discovery_before(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.account_discovery_before() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.account_id) IS DISTINCT FROM (OLD.route, OLD.account_id) THEN
    RAISE EXCEPTION 'Account discovery source keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  -- Retain the original native owner while the same-home Source obligation commits.
  PERFORM 1 FROM core.partition WHERE partition_no=p AND write_state='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
  -- Serialize allocation with the native head; a late commit must advance it too.
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  -- Same local lock order as retained enrollment: Account head, then Source head.
  PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;


--
-- Name: account_discovery_claim_after(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.account_discovery_claim_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; v bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD.route; v := nextval('access.account_discovery_revision');
  ELSE r := NEW.route; v := NEW.discovery_revision; END IF;
  UPDATE access.account_discovery_population SET claim_revision = v WHERE partition_no = r >> 4;
  PERFORM semantic.enqueue_account_public_filter(partition_no,revision,claim_revision)
    FROM access.account_discovery_population WHERE partition_no=r >> 4;
  IF TG_OP <> 'INSERT' AND OLD.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, OLD.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, NEW.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: account_discovery_claim_before(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.account_discovery_claim_before() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.normalized_handle) IS DISTINCT FROM (OLD.route, OLD.normalized_handle) THEN
    RAISE EXCEPTION 'Account discovery claim keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  -- Retain the original native owner while the same-home Source obligation commits.
  PERFORM 1 FROM core.partition WHERE partition_no=p AND write_state='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  -- Same local lock order as retained enrollment: Account head, then Source head.
  PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;


--
-- Name: account_discovery_preferences(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.account_discovery_preferences() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = OLD.route AND account_id = OLD.account_id;
  ELSE
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = NEW.route AND account_id = NEW.account_id;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: account_discovery_truncate(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.account_discovery_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE home integer;
BEGIN
  -- A table reset has no Account row identity. Each original native home remains
  -- independently dirty; no event delivery or clearing of intents retires it.
  FOR home IN SELECT partition_no FROM access.account_discovery_population ORDER BY partition_no LOOP
    PERFORM 1 FROM core.partition WHERE partition_no=home AND write_state='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
    PERFORM 1 FROM access.account_discovery_population WHERE partition_no=home FOR UPDATE;
    PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=home FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
    IF TG_TABLE_NAME = 'account' THEN
      UPDATE access.account_discovery_population SET population=0,
        revision=nextval('access.account_discovery_revision') WHERE partition_no=home;
    ELSE
      UPDATE access.account_discovery_population SET claim_revision=nextval('access.account_discovery_revision')
        WHERE partition_no=home;
    END IF;
    PERFORM semantic.enqueue_account_public_filter(partition_no,revision,claim_revision)
      FROM access.account_discovery_population WHERE partition_no=home;
  END LOOP;
  RETURN NULL;
END $$;


--
-- Name: advance_current_resource_roles(timestamp with time zone); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.advance_current_resource_roles(p_at timestamp with time zone DEFAULT clock_timestamp()) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE install access.current_resource_role_install; source access.resource_role_grant;
  item access.current_resource_role_due; anchor timestamptz; touched integer := 0;
BEGIN
  SELECT * INTO STRICT install FROM access.current_resource_role_install WHERE singleton FOR UPDATE;
  IF NOT install.complete THEN
    FOR source IN SELECT * FROM access.resource_role_grant
      WHERE erasure_key > install.after_key AND erasure_key <= install.cut
      ORDER BY erasure_key LIMIT 100 FOR UPDATE
    LOOP
      PERFORM access.index_current_resource_role(source);
      install.after_key := source.erasure_key;
      touched := touched+1;
    END LOOP;
    UPDATE access.current_resource_role_install SET after_key=install.after_key,
      complete=(touched < 100 OR install.after_key=install.cut) WHERE singleton;
    RETURN touched;
  END IF;
  -- Each iteration removes one exact due reference. The index supplies its next start key.
  FOR counter IN 1..100 LOOP
    SELECT * INTO item FROM access.current_resource_role_due WHERE due_at <= p_at
      ORDER BY due_at,route,resource_id,interval_key LIMIT 1;
    EXIT WHEN NOT FOUND;
    SELECT processed_at INTO STRICT anchor FROM access.current_resource_role_frontier
      WHERE route=item.route AND resource_id=item.resource_id FOR UPDATE;
    -- A concurrent source writer may have removed/replaced this boundary before the frontier lock.
    DELETE FROM access.current_resource_role_due WHERE route=item.route AND resource_id=item.resource_id
      AND due_at=item.due_at AND interval_key=item.interval_key;
    IF NOT FOUND THEN CONTINUE; END IF;
    anchor := greatest(anchor,item.due_at);
    DELETE FROM access.current_resource_role_key WHERE interval_key=item.interval_key;
    INSERT INTO access.current_resource_role_key
      SELECT route,resource_id,grant_role,subject_kind,subject_id,subject_role,erasure_key
      FROM access.resource_role_grant WHERE erasure_key=item.interval_key AND valid @> anchor
      ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET processed_at=anchor,version=version+1
      WHERE route=item.route AND resource_id=item.resource_id;
    touched := touched+1;
  END LOOP;
  RETURN touched;
END; $$;


--
-- Name: advance_operator_relation(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.advance_operator_relation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF access.native_terminal_account_ready(OLD) AND NEW.operator_relation_version=0
     AND OLD.operator_account_id IS NULL AND NEW.operator_account_id IS NULL
     AND OLD.operator_reservation_id IS NULL AND NEW.operator_reservation_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id
     OR NEW.operator_reservation_id IS DISTINCT FROM OLD.operator_reservation_id THEN
    NEW.operator_relation_version := OLD.operator_relation_version + 1;
  ELSIF NEW.operator_relation_version IS DISTINCT FROM OLD.operator_relation_version THEN
    RAISE EXCEPTION 'Operator relation version is command owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: agent_identity_original_source_valid(integer, jsonb); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.agent_identity_original_source_valid(home integer, s jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS (
  SELECT 1 FROM semantic.identity_epoch_receipt_binding b
  JOIN semantic.identity_epoch_receipt_claim c
    ON (c.partition_no,c.receipt_key,c.generation)=(b.partition_no,b.receipt_key,b.generation)
  JOIN semantic.identity_epoch_receipt_claim_commit k
    ON (k.partition_no,k.receipt_key,k.generation,k.transaction_id)=
       (c.partition_no,c.receipt_key,c.generation,c.transaction_id)
  JOIN semantic.identity_epoch_native_commit n
    ON (n.partition_no,n.transaction_id)=(c.partition_no,c.transaction_id)
    AND n.purpose='admission' AND n.xmin=k.xmin AND n.xmin=c.xmin
  JOIN core.partition p ON p.partition_no=c.partition_no AND p.write_state='active'
    AND p.epoch=n.epoch AND p.position>=n.position AND n.position>0
  WHERE b.partition_no=home AND b.receipt_key=s->'claim'->>'key'
    AND b.account_id::text=s->'input'->'receipt'->>'account' AND b.state='accepted'
    AND b.intent_digest=c.intent_digest AND (b.accepted_job,b.accepted_epoch)=(c.job_id,c.job_epoch)
    AND NOT c.imported AND c.xmin::text<>pg_current_xact_id()::text
    AND c.intent=s->'input'->'intent' AND c.receipt=s->'input'->'receipt' AND c.intent_digest=s->>'digest'
    AND s->'native'=jsonb_build_object('partition',n.partition_no,'epoch',n.epoch,
      'position',n.position::text,'transactionId',n.transaction_id::text)
    AND s->'job'=jsonb_build_object('jobId',c.job_id::text,'epoch',c.job_epoch::text)
    AND s->'claim'=jsonb_build_object('partition',c.partition_no,'key',c.receipt_key,
      'generation',c.generation::text,'transactionId',c.transaction_id::text,
      'home',c.job_home,'scope',c.scope_digest,'sources',c.sources)
 );
$$;


--
-- Name: agent_identity_recovery_skeleton(jsonb); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.agent_identity_recovery_skeleton(s jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
 SELECT jsonb_build_object(
   'digest',s->'digest',
   'native',jsonb_build_object('partition',s->'native'->'partition','epoch',s->'native'->'epoch',
     'position',s->'native'->'position','transactionId',s->'native'->'transactionId'),
   'job',jsonb_build_object('jobId',s->'job'->'jobId','epoch',s->'job'->'epoch'),
   'claim',jsonb_build_object('partition',s->'claim'->'partition','generation',s->'claim'->'generation',
     'transactionId',s->'claim'->'transactionId','home',s->'claim'->'home','scope',s->'claim'->'scope'));
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_identity_intent; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_identity_intent (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL,
    receipt_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    account_kind text NOT NULL,
    catalogue_id uuid NOT NULL,
    request_id uuid,
    requested_by uuid,
    decided_by uuid,
    decision_route integer,
    decision_receipt_id uuid,
    decision_epoch integer,
    decision_position bigint,
    decision_transaction_id uuid,
    pending_receipt_id uuid NOT NULL,
    verification_receipt_id uuid,
    disposition text,
    reason text,
    release text NOT NULL,
    intent jsonb NOT NULL,
    intent_digest text NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    undo_job_id uuid,
    undo_job_epoch bigint,
    delivery_key text NOT NULL,
    workflow_id text NOT NULL,
    native_command_kind text NOT NULL,
    native_receipt_key text NOT NULL,
    minimized boolean DEFAULT false NOT NULL,
    CONSTRAINT agent_identity_intent_account_kind_check CHECK ((account_kind = ANY (ARRAY['actor'::text, 'organization'::text]))),
    CONSTRAINT agent_identity_intent_check CHECK ((((direction = 'account-agent.verify'::text) AND (native_command_kind = 'access.agent-verification.pending'::text)) OR ((direction = 'account-agent.unverify'::text) AND (native_command_kind = ANY (ARRAY['access.agent-verification.released'::text, 'access.agent-verification.revoked'::text, 'access.agent-verification.deleted'::text]))))),
    CONSTRAINT agent_identity_intent_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT agent_identity_intent_check2 CHECK ((source_partition = (route / 16))),
    CONSTRAINT agent_identity_intent_check3 CHECK ((((direction = 'account-agent.verify'::text) AND (request_id IS NOT NULL) AND (decision_route = 0) AND (decision_receipt_id = receipt_id) AND (decision_epoch > 0) AND (decision_position > 0) AND (decision_transaction_id = receipt_id) AND (verification_receipt_id IS NULL) AND (undo_job_id IS NULL) AND (undo_job_epoch IS NULL) AND (disposition IS NULL)) OR ((direction = 'account-agent.unverify'::text) AND (verification_receipt_id IS NOT NULL) AND (source_transaction_id = receipt_id) AND (disposition IS NOT NULL) AND (undo_job_id IS NOT NULL) AND (undo_job_epoch > 0)))),
    CONSTRAINT agent_identity_intent_check4 CHECK (((direction <> 'account-agent.verify'::text) OR (source_transaction_id = pending_receipt_id))),
    CONSTRAINT agent_identity_intent_direction_check CHECK ((direction = ANY (ARRAY['account-agent.verify'::text, 'account-agent.unverify'::text]))),
    CONSTRAINT agent_identity_intent_disposition_check CHECK ((disposition = ANY (ARRAY['released'::text, 'revoked'::text]))),
    CONSTRAINT agent_identity_intent_intent_digest_check CHECK ((intent_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_intent_reason_check CHECK ((char_length(reason) <= 500)),
    CONSTRAINT agent_identity_intent_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT agent_identity_intent_source_position_check CHECK ((source_position > 0))
);


--
-- Name: agent_identity_recovery_valid(access.agent_identity_intent); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.agent_identity_recovery_valid(i access.agent_identity_intent) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM access.agent_identity_recovery a WHERE
     (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
     AND a.original_source IS NOT NULL
 ) THEN access.agent_identity_retained_recovery_valid(i) ELSE EXISTS (
  SELECT 1 FROM access.agent_identity_recovery a
  JOIN core.receipt r ON r.partition_no=a.source_partition AND r.principal_kind='account'
    AND r.principal_id=a.requested_by AND r.command_kind=i.native_command_kind
    AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=a.source_transaction_id
    AND r.epoch=a.source_epoch AND r.position=a.source_position AND r.payload_state='present'
    AND r.xmin::text<>pg_current_xact_id()::text
  JOIN core.receipt c ON c.partition_no=a.source_partition AND c.principal_kind='account'
    AND c.principal_id=a.requested_by AND c.command_kind='access.agent-identity.recover'
    AND c.idempotency_key=a.recovery_receipt_key AND c.transaction_id=a.recovery_transaction_id
    AND c.epoch=a.recovery_epoch AND c.position=a.recovery_position
    AND c.xmin::text=pg_current_xact_id()::text AND c.payload_state='present'
    AND encode(c.request_digest,'hex')=a.recovery_digest
    AND c.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s]',
      to_json(i.delivery_key),to_json(i.source_transaction_id::text),i.source_epoch,to_json(i.source_position::text),
      to_json(i.intent_digest),COALESCE(to_json(a.verification_intent_digest)::text,'null'),
      (a.original_source->'native'->'transactionId')::text,(a.original_source->'native'->'epoch')::text,
      (a.original_source->'native'->'position')::text,(a.original_source->'claim'->'generation')::text,
      (a.original_source->'job'->'jobId')::text,(a.original_source->'job'->'epoch')::text,
      (a.original_source->'claim'->'scope')::text,COALESCE(to_json(i.decision_transaction_id::text)::text,'null'),
      COALESCE(i.decision_epoch::text,'null'),COALESCE(to_json(i.decision_position::text)::text,'null')),'UTF8'))
  JOIN core.partition p ON p.partition_no=a.source_partition AND p.write_state='active'
    AND p.epoch=a.source_epoch AND p.position>=a.recovery_position
  WHERE (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
    AND a.xmin::text=pg_current_xact_id()::text
    AND a.requested_by=i.requested_by AND a.decided_by IS NOT DISTINCT FROM i.decided_by
    AND a.source_partition=i.source_partition AND a.source_epoch=i.source_epoch
    AND a.source_position=i.source_position AND a.source_transaction_id=i.source_transaction_id
    AND a.intent_digest=i.intent_digest AND NOT i.minimized
    AND i.pending_receipt_id=r.transaction_id
    AND i.delivery_key=format('["%s","%s","%s"]',i.direction,i.account_id::text,i.receipt_id::text)
    AND a.original_source->'input'=jsonb_build_object('intent',i.intent,'receipt',
      jsonb_build_object('account',i.account_id::text,'kind',i.direction,'receipt',i.receipt_id::text))
    AND a.original_source->>'digest'=i.intent_digest
    AND i.intent->>'release'=i.release
    AND access.agent_identity_original_source_valid(i.source_partition,a.original_source)
    -- The original Source admission must never masquerade as the Account command.
    AND a.original_source->'native'->>'transactionId'<>i.source_transaction_id::text
    AND a.original_source->'native'->>'transactionId'<>a.recovery_transaction_id::text
    AND (a.original_source->'native'->>'position')::bigint>i.source_position
    AND (a.original_source->'native'->>'position')::bigint<a.recovery_position
    AND ((i.direction='account-agent.verify'
      AND a.original_source->'priorVerification'='null'::jsonb
      AND a.verification_intent_digest IS NULL AND i.verification_receipt_id IS NULL
      AND i.decided_by IS NOT NULL AND i.decision_route=0 AND i.decision_receipt_id=i.receipt_id
      AND i.decision_transaction_id=i.receipt_id AND i.decision_epoch>0 AND i.decision_position>0
      AND i.intent=jsonb_build_object('kind','merge','redirected',i.agent_id::text,
        'survivor',i.catalogue_id::text,'release',i.release)
      AND i.workflow_id='accounts.agent-verification:'||i.request_id::text||':'||i.receipt_id::text
      AND r.command_kind='access.agent-verification.pending'
      AND r.response=jsonb_build_object('requestId',i.request_id::text,'accountId',i.account_id::text)
      AND r.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s]',to_json(i.request_id::text),
        to_json(i.account_id::text),to_json(i.account_kind),to_json(i.catalogue_id::text),
        to_json(i.receipt_id::text)),'UTF8')))
    OR (i.direction='account-agent.unverify'
      AND access.agent_identity_original_source_valid(i.source_partition,a.original_source->'priorVerification')
      AND (a.original_source->'priorVerification'->'native'->>'position')::bigint<i.source_position
      AND a.original_source->'priorVerification'->>'verificationReceipt'=i.verification_receipt_id::text
      AND a.original_source->'priorVerification'->>'digest'=a.verification_intent_digest
      AND a.original_source->'priorVerification'->'input'=jsonb_build_object('intent',
        jsonb_build_object('kind','merge','redirected',i.agent_id::text,'survivor',i.catalogue_id::text,'release',i.release),
        'receipt',jsonb_build_object('account',i.account_id::text,'kind','account-agent.verify',
          'receipt',i.verification_receipt_id::text))
      AND a.original_source->'priorVerification'->'job'=i.intent->'undoJob'
      AND i.intent=jsonb_build_object('kind','unmerge','original',i.agent_id::text,'release',i.release,
        'verificationReceipt',i.verification_receipt_id::text,'undoJob',
        jsonb_build_object('jobId',i.undo_job_id::text,'epoch',i.undo_job_epoch::text))
      AND i.request_id IS NULL AND i.decision_route IS NULL AND i.decision_receipt_id IS NULL
      AND i.decision_epoch IS NULL AND i.decision_position IS NULL AND i.decision_transaction_id IS NULL
      AND i.workflow_id='accounts.agent-verification-reversal:'||i.account_id::text||':'||i.receipt_id::text
      AND r.response=jsonb_build_object('accountId',i.account_id::text,'receiptId',i.receipt_id::text,
        'requestedBy',i.requested_by::text,'kind',i.disposition,'reason',i.reason,
        'catalogueSubjectId',i.catalogue_id::text,'verificationReceiptId',i.verification_receipt_id::text)
      AND i.decided_by IS NOT DISTINCT FROM CASE WHEN i.disposition='revoked' THEN i.requested_by END
      AND ((r.command_kind='access.agent-verification.deleted' AND i.disposition='revoked'
        AND i.reason='Account deleted' AND i.requested_by=i.account_id
        AND r.request_digest=sha256(convert_to(i.account_id::text,'UTF8'))
        AND EXISTS (SELECT 1 FROM access.account t WHERE t.route=i.route AND t.account_id=i.account_id AND t.state='deleted'))
      OR (r.command_kind='access.agent-verification.'||i.disposition AND EXISTS (
        SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
          AND b.principal_kind='account' AND b.principal_id=r.principal_id AND b.epoch=r.epoch AND b.position=r.position)))))
 ) END;
$$;


--
-- Name: agent_identity_retained_recovery_valid(access.agent_identity_intent); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.agent_identity_retained_recovery_valid(i access.agent_identity_intent) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS (
  SELECT 1 FROM access.agent_identity_recovery a
  JOIN core.receipt r ON r.partition_no=a.source_partition AND r.principal_kind='account'
    AND r.principal_id=a.requested_by AND r.command_kind=i.native_command_kind
    AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=a.source_transaction_id
    AND r.epoch=a.source_epoch AND r.position=a.source_position AND r.payload_state='present'
    AND r.xmin::text<>pg_current_xact_id()::text
  JOIN core.receipt c ON c.partition_no=a.source_partition AND c.principal_kind='account'
    AND c.principal_id=a.requested_by AND c.command_kind='access.agent-identity.recover'
    AND c.idempotency_key=a.recovery_receipt_key
    AND c.transaction_id=a.recovery_transaction_id AND c.epoch=a.recovery_epoch
    AND c.position=a.recovery_position AND c.xmin::text=pg_current_xact_id()::text
    AND c.payload_state='present'
    AND c.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s,%s]',
      to_json(i.delivery_key),to_json(i.source_transaction_id::text),i.source_epoch,
      to_json(i.source_position::text),to_json(i.intent_digest),to_json(a.verification_intent_digest)), 'UTF8'))
  JOIN core.partition p ON p.partition_no=a.source_partition AND p.write_state='active'
    AND p.epoch=a.source_epoch AND p.position>=a.recovery_position
  JOIN access.agent_identity_intent v ON v.route=i.route AND v.account_id=i.account_id
    AND v.direction='account-agent.verify' AND v.receipt_id=i.verification_receipt_id
    AND v.intent_digest=a.verification_intent_digest AND NOT v.minimized
    AND v.xmin::text<>pg_current_xact_id()::text
    AND v.source_epoch=i.source_epoch AND v.catalogue_id=i.catalogue_id
    AND v.source_position<r.position
    AND v.agent_id=i.agent_id AND v.account_kind=i.account_kind AND v.release=i.release
  WHERE (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
    AND a.xmin::text=pg_current_xact_id()::text
    AND a.requested_by=i.requested_by AND a.decided_by IS NOT DISTINCT FROM i.decided_by
    AND a.source_partition=i.source_partition AND a.source_epoch=i.source_epoch
    AND a.source_position=i.source_position AND a.source_transaction_id=i.source_transaction_id
    AND a.intent_digest=i.intent_digest AND NOT i.minimized
    AND i.direction='account-agent.unverify' AND i.pending_receipt_id=i.receipt_id
    AND i.request_id IS NULL AND i.decision_route IS NULL AND i.decision_receipt_id IS NULL
    AND i.decision_epoch IS NULL AND i.decision_position IS NULL AND i.decision_transaction_id IS NULL
    AND i.delivery_key=format('["%s","%s","%s"]',i.direction,i.account_id::text,i.receipt_id::text)
    AND i.workflow_id='accounts.agent-verification-reversal:'||i.account_id::text||':'||i.receipt_id::text
    AND i.intent=jsonb_build_object('kind','unmerge','original',i.agent_id::text,
      'undoJob',jsonb_build_object('jobId',i.undo_job_id::text,'epoch',i.undo_job_epoch::text),
      'verificationReceipt',i.verification_receipt_id::text,'release',v.release)
    AND i.intent_digest=encode(sha256(convert_to(format(
      '[{"kind":"unmerge","original":%s,"release":%s,"undoJob":{"epoch":%s,"jobId":%s},"verificationReceipt":%s},{"account":%s,"kind":"account-agent.unverify","receipt":%s}]',
      to_json(i.agent_id::text),to_json(i.release),to_json(i.undo_job_epoch::text),to_json(i.undo_job_id::text),
      to_json(i.verification_receipt_id::text),to_json(i.account_id::text),to_json(i.receipt_id::text)), 'UTF8')), 'hex')
    AND r.response=jsonb_build_object('accountId',i.account_id::text,'receiptId',i.receipt_id::text,
      'requestedBy',i.requested_by::text,'kind',i.disposition,'reason',i.reason,
      'catalogueSubjectId',i.catalogue_id::text,'verificationReceiptId',i.verification_receipt_id::text)
    AND i.decided_by IS NOT DISTINCT FROM CASE WHEN i.disposition='revoked' THEN i.requested_by END
    AND ((r.command_kind='access.agent-verification.deleted' AND i.disposition='revoked'
       AND i.reason='Account deleted' AND i.requested_by=i.account_id
       AND r.request_digest=sha256(convert_to(i.account_id::text,'UTF8'))
       AND EXISTS (SELECT 1 FROM access.account t WHERE t.route=i.route AND t.account_id=i.account_id
         AND t.state='deleted'))
     OR (r.command_kind='access.agent-verification.'||i.disposition AND EXISTS (
       SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=r.partition_no
         AND b.transaction_id=r.transaction_id AND b.principal_kind='account' AND b.principal_id=r.principal_id
         AND b.epoch=r.epoch AND b.position=r.position)))
 );
$$;


--
-- Name: auth_erasure_cut_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_cut_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth erasure cut is permanent'; END IF;
 IF (NEW.cut_id,NEW.participant,NEW.inventory_version,NEW.producer_version)
    IS DISTINCT FROM (OLD.cut_id,OLD.participant,OLD.inventory_version,OLD.producer_version)
    OR NEW.sealed_partitions<>OLD.sealed_partitions+1
    OR NOT EXISTS(SELECT 1 FROM access.auth_erasure_cut_partition
                  WHERE cut_id=OLD.cut_id AND partition_no=OLD.sealed_partitions) THEN
  RAISE EXCEPTION 'Auth erasure cut must advance by one retained native partition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: auth_erasure_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION 'Auth erasure source evidence is permanent and immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: auth_erasure_index_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_index_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF (TG_OP='UPDATE' AND OLD.auth_obligation_indexed AND NOT NEW.auth_obligation_indexed)
    OR (NEW.auth_obligation_indexed AND NOT EXISTS(
      SELECT 1 FROM access.auth_erasure_obligation WHERE route=NEW.route AND account_id=NEW.account_id)) THEN
  RAISE EXCEPTION 'Auth erasure index cannot discard source evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: auth_erasure_live_partition_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_live_partition_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Auth live enrollment is permanent' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NOT NEW.lineage_valid OR NEW.enrollment_floor<>NEW.enrolled_through OR NOT EXISTS(
   SELECT 1 FROM access.auth_erasure_source s JOIN core.partition p USING(partition_no)
    WHERE s.partition_no=NEW.partition_no AND s.initialized AND s.head=NEW.enrolled_through
     AND (s.generation,s.source_epoch,s.source_owner)=(NEW.generation,NEW.source_epoch,NEW.source_owner)
     AND p.write_state='active' AND p.epoch=s.source_epoch AND p.node=s.source_owner) THEN
   RAISE EXCEPTION 'Auth live enrollment requires current native source' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (NEW.partition_no,NEW.generation,NEW.source_epoch,NEW.source_owner,NEW.enrollment_floor)
    IS DISTINCT FROM (OLD.partition_no,OLD.generation,OLD.source_epoch,OLD.source_owner,OLD.enrollment_floor)
    OR NEW.enrolled_through<>OLD.enrolled_through+1 OR (NOT OLD.lineage_valid AND NEW.lineage_valid)
    OR NOT EXISTS(SELECT 1 FROM access.auth_erasure_obligation
                  WHERE partition_no=NEW.partition_no AND ordinal=NEW.enrolled_through) THEN
   RAISE EXCEPTION 'Auth live enrollment cannot repin, skip or regress' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: auth_erasure_live_subscription_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_live_subscription_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM access.auth_erasure_cut_partition c
   JOIN access.auth_erasure_source s USING(partition_no)
   JOIN core.partition p USING(partition_no)
   JOIN access.auth_erasure_live_partition l USING(partition_no)
  WHERE c.cut_id=NEW.cut_id AND c.partition_no=NEW.partition_no
   AND (c.generation,c.source_epoch,c.source_owner,c.high_water)=
       (NEW.generation,NEW.source_epoch,NEW.source_owner,NEW.high_water)
   AND (s.generation,s.source_epoch,s.source_owner)=(c.generation,c.source_epoch,c.source_owner)
   AND (l.generation,l.source_epoch,l.source_owner)=(c.generation,c.source_epoch,c.source_owner)
   AND s.initialized AND s.head=NEW.arm_high_water AND l.enrolled_through=s.head AND l.lineage_valid
   AND p.write_state='active' AND p.epoch=c.source_epoch AND p.node=c.source_owner AND p.position>=c.source_position
   AND NOT EXISTS(SELECT 1 FROM access.auth_erasure_obligation o
                  WHERE o.partition_no=c.partition_no AND o.minimum_authn_epoch IS NULL)) THEN
  RAISE EXCEPTION 'Auth live subscription requires retained native cut and enrollment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: auth_erasure_producer(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_producer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM access.capture_auth_erasure_obligation(NEW.route,NEW.account_id,true);
 RETURN NEW;
END; $$;


--
-- Name: auth_erasure_source_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_erasure_source_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth erasure source is permanent'; END IF;
 IF (NEW.partition_no,NEW.generation,NEW.source_epoch,NEW.source_owner)
    IS DISTINCT FROM (OLD.partition_no,OLD.generation,OLD.source_epoch,OLD.source_owner)
    OR NEW.head<OLD.head OR (OLD.initialized AND NOT NEW.initialized) THEN
  RAISE EXCEPTION 'Auth erasure source cannot change lineage or regress' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: auth_receiving_closure_insert_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_receiving_closure_insert_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_receiving_control_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_receiving_control_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving control is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'owner-unavailable' OR NEW.revision<>1 OR NEW.database_identity IS NOT NULL
    OR NEW.receiving_incarnation IS NOT NULL OR NEW.restore_generation IS NOT NULL
    OR NEW.owner_installation IS NOT NULL OR NEW.writer_fence IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving registration cannot install physical ownership';
  END IF;
 ELSE
  IF (NEW.partition_no,NEW.source_generation,NEW.source_epoch,NEW.source_owner)
    IS DISTINCT FROM (OLD.partition_no,OLD.source_generation,OLD.source_epoch,OLD.source_owner)
    OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'Auth receiving transition must preserve Source and advance its fence';
  END IF;
  -- No original physical-owner installation ABI exists here. Invalidation is
  -- implemented; activation must be integrated by the original owner, replacing
  -- this refusal with its genuine owner-record validation, never a session flag.
  IF NEW.state='active' THEN
   RAISE EXCEPTION 'Auth original physical-owner installation unavailable';
  END IF;
  IF (NEW.database_identity,NEW.receiving_incarnation,NEW.restore_generation,NEW.owner_installation,NEW.writer_fence)
   IS DISTINCT FROM (OLD.database_identity,OLD.receiving_incarnation,OLD.restore_generation,OLD.owner_installation,OLD.writer_fence) THEN
   RAISE EXCEPTION 'Auth invalidation cannot install physical ownership';
  END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: auth_receiving_control_source_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_receiving_control_source_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM 1 FROM core.partition p JOIN access.auth_erasure_source s USING(partition_no)
 WHERE p.partition_no=NEW.partition_no AND p.write_state='active' AND s.initialized
 AND octet_length(s.source_owner)<=256 AND p.epoch=s.source_epoch AND p.node=s.source_owner
 AND s.generation=NEW.source_generation AND s.source_epoch=NEW.source_epoch AND s.source_owner=NEW.source_owner
 FOR SHARE OF p,s;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth receiving registration Source mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: auth_receiving_obligation_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_receiving_obligation_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving obligation is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.custody_revision IS NOT NULL OR NEW.physical_closure IS NOT NULL OR NEW.receiving_closure IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving registration cannot assert physical custody';
  END IF;
 ELSE
  IF (NEW.route,NEW.account_id,NEW.version,NEW.at,NEW.partition_no)
   IS DISTINCT FROM (OLD.route,OLD.account_id,OLD.version,OLD.at,OLD.partition_no) THEN
   RAISE EXCEPTION 'Auth receiving obligation root is immutable';
  END IF;
  IF (NEW.custody_revision,NEW.physical_closure,NEW.receiving_closure)
   IS DISTINCT FROM (OLD.custody_revision,OLD.physical_closure,OLD.receiving_closure) THEN
   RAISE EXCEPTION 'Auth original physical receiving custody operation unavailable';
  END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: auth_receiving_obligation_root_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.auth_receiving_obligation_root_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM 1 FROM access.account a JOIN access.erasure e USING(route,account_id)
 JOIN access.auth_erasure_obligation o USING(route,account_id)
 WHERE a.route=NEW.route AND a.account_id=NEW.account_id AND NEW.partition_no=NEW.route/16
 AND a.state='deleted' AND a.authn_fenced AND o.minimum_authn_epoch IS NOT NULL
 AND a.minimum_authn_epoch>=o.minimum_authn_epoch AND e.version=NEW.version AND e.at=NEW.at
 AND o.version=e.version AND o.at=e.at FOR SHARE OF a,e,o;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth receiving registration barrier mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: capture_auth_erasure_obligation(integer, uuid, boolean); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.capture_auth_erasure_obligation(r integer, a uuid, native boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE source access.auth_erasure_source; root access.erasure; terminal access.account;
 original access.lifecycle_fence_receipt; candidate access.lifecycle_fence_receipt; found_count integer:=0;
BEGIN
 -- Even while source lineage recovery is pending, current native deletion still
 -- commits and retains its exact obligation in the same ordinal feed. It cannot
 -- relabel the old source epoch or release a stale cut.
 source:=access.lock_auth_erasure_source(r/16,NOT native);
 SELECT * INTO root FROM access.erasure WHERE route=r AND account_id=a FOR UPDATE;
 IF NOT FOUND OR root.auth_obligation_indexed THEN RETURN; END IF;
 SELECT * INTO terminal FROM access.account WHERE route=r AND account_id=a;
 -- A receipt's original native tombstone kind is retained independently of the
 -- mutable current floor. Never infer the original floor from terminal or T.
 FOR candidate IN SELECT * FROM access.lifecycle_fence_receipt
  WHERE route=r AND account_id=a AND kind='tombstone' LIMIT 2
 LOOP
  found_count:=found_count+1; original:=candidate;
 END LOOP;
 IF found_count<>1 OR terminal.state<>'deleted' OR NOT terminal.authn_fenced
    OR terminal.minimum_authn_epoch<original.minimum_authn_epoch THEN
  original.minimum_authn_epoch:=NULL; original.receipt_id:=NULL;
 ELSIF native THEN
  -- New native capture must belong to the actual tombstone transaction, not a
  -- later read/relabel of the current floor or a fabricated old receipt.
  IF NOT EXISTS(SELECT 1 FROM access.lifecycle_fence_receipt f
     WHERE f.route=r AND f.account_id=a AND f.receipt_id=original.receipt_id
       AND f.transaction_id=terminal.transaction_id AND f.xmin::text=pg_current_xact_id()::text)
     OR terminal.fence_receipt_id<>original.receipt_id THEN
   original.minimum_authn_epoch:=NULL; original.receipt_id:=NULL;
  END IF;
 END IF;
 UPDATE access.auth_erasure_source SET head=head+1 WHERE partition_no=r/16 RETURNING * INTO source;
 INSERT INTO access.auth_erasure_obligation(partition_no,ordinal,route,account_id,version,at,minimum_authn_epoch,receipt_id)
 VALUES(r/16,source.head,r,a,root.version,root.at,original.minimum_authn_epoch,original.receipt_id);
 UPDATE access.erasure SET auth_obligation_indexed=true WHERE route=r AND account_id=a;
END; $$;


--
-- Name: capture_current_resource_role(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.capture_current_resource_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Even deletion of the final source row advances the native resource version.
    INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
    SELECT OLD.route,OLD.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
    ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET version=version+1
    WHERE route=OLD.route AND resource_id=OLD.resource_id;
    DELETE FROM access.current_resource_role_key WHERE interval_key=OLD.erasure_key;
    DELETE FROM access.current_resource_role_due WHERE interval_key=OLD.erasure_key;
  END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM access.index_current_resource_role(NEW); END IF;
  RETURN NULL;
END; $$;


--
-- Name: capture_resource_role_provenance(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.capture_resource_role_provenance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r access.resource_role_grant; i access.resource_initialization; native_tx uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
 IF r.subject_kind<>'identity' OR r.subject_role<>'' THEN RETURN r; END IF;
 SELECT * INTO i FROM access.resource_initialization WHERE route=r.route AND resource_id=r.resource_id;
 IF NOT FOUND THEN RETURN r; END IF;
 native_tx:=coalesce(nullif(current_setting('access.role_native_transaction',true),'' )::uuid,r.transaction_id);
 INSERT INTO access.resource_role_provenance(route,resource_id,resource_type,original_creator,account_id,
   grant_role,valid,side,grant_transaction,source_transaction)
 VALUES(r.route,r.resource_id,i.resource_type,i.creator_id,r.subject_id,r.grant_role,r.valid,
   CASE WHEN TG_OP='DELETE' THEN 'former' ELSE 'new' END,r.transaction_id,native_tx);
 RETURN r;
END; $$;


--
-- Name: check_agent_identity_recovery_retention(access.agent_identity_intent, text, jsonb, uuid); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.check_agent_identity_recovery_retention(i access.agent_identity_intent, p_role text, b jsonb, erased uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE a record; c core.agent_identity_recovery_inventory;
 h core.agent_identity_history_copy; role_hash bytea; actual_accounts jsonb; role_count integer;
 supported_roles boolean; n integer:=0; receiver record; receiver_count integer:=0;
 effects_position bigint; expected_workflow text;
BEGIN
 SELECT recovery_epoch,recovery_position,recovery_transaction_id,recovery_receipt_key,intent_digest,
   source_partition,source_epoch,source_position,source_transaction_id,requested_by,decided_by,
   original_source_minimized,
   CASE WHEN original_source_minimized THEN original_source ELSE NULL END AS original_source
   INTO a FROM access.agent_identity_recovery WHERE route=i.route AND account_id=i.account_id
     AND direction=i.direction AND receipt_id=i.receipt_id FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO c FROM core.agent_identity_recovery_inventory WHERE partition_no=i.source_partition
   AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
   AND source_receipt_id=i.receipt_id FOR SHARE;
 IF NOT FOUND OR c.state<>'sealed' OR c.native_writer_state<>'closed' OR
    c.producer_version<>1 OR c.conversion_coverage<>'native-receipt-outbox/v1' OR
    cardinality(c.expected_locators)<>2 OR
    c.expected_event_types IS DISTINCT FROM ARRAY['com.rezics.access.account-updated.v1'] OR
    c.native_command_kind<>'access.agent-identity.recover' OR c.native_principal_kind<>'account' OR
    c.native_receipt_key IS DISTINCT FROM a.recovery_receipt_key OR
    c.source_digest IS DISTINCT FROM a.intent_digest OR
    (c.recovery_epoch,c.recovery_position,c.recovery_transaction_id)
      IS DISTINCT FROM (a.recovery_epoch,a.recovery_position,a.recovery_transaction_id) OR
    (a.source_partition,a.source_epoch,a.source_position,a.source_transaction_id,a.intent_digest)
      IS DISTINCT FROM (i.source_partition,i.source_epoch,i.source_position,i.source_transaction_id,i.intent_digest) OR
    c.receiver_epoch<>c.recovery_epoch OR
    NOT (a.requested_by IS NOT DISTINCT FROM i.requested_by OR
      (p_role='requester' AND a.requested_by IS NULL AND i.requested_by IS NOT NULL)) OR
    NOT (a.decided_by IS NOT DISTINCT FROM i.decided_by OR
      (p_role='decider' AND a.decided_by IS NULL AND i.decided_by IS NOT NULL)) OR
    (a.original_source_minimized AND
      (a.original_source IS NULL OR a.original_source IS DISTINCT FROM access.agent_identity_recovery_skeleton(a.original_source))) THEN
   RAISE EXCEPTION 'identity retention recovery cut changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.partition p JOIN core.history_family_domain d ON d.singleton
   WHERE p.partition_no=c.partition_no AND p.write_state='active' AND p.epoch=c.receiver_epoch
     AND d.generation=c.domain_generation AND p.position>=c.recovery_position FOR SHARE OF p,d;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery restore changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.receipt r WHERE r.partition_no=c.partition_no AND r.principal_kind=c.native_principal_kind
   AND r.principal_id=c.native_principal_id AND r.command_kind=c.native_command_kind
   AND r.idempotency_key=c.native_receipt_key AND r.transaction_id=c.recovery_transaction_id
   AND r.epoch=c.recovery_epoch AND r.position=c.recovery_position AND r.request_digest=c.native_request_digest
   AND r.payload_state='minimized' AND r.response='null'::jsonb FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery receipt remains' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.outbox o WHERE o.partition_no=c.partition_no AND o.epoch=c.recovery_epoch
   AND o.position=c.recovery_position AND o.event_seq=0 AND o.event_count=1
   AND o.type=c.expected_event_types[1] AND o.payload_state='minimized' AND o.data='{}'::jsonb AND o.subject IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery event remains' USING ERRCODE='23514'; END IF;
 SELECT position INTO effects_position FROM core.consumer_checkpoint WHERE partition_no=c.partition_no
   AND consumer='effects' AND position>=c.recovery_position FOR SHARE;
 IF effects_position IS NULL THEN RAISE EXCEPTION 'identity retention recovery effects pending' USING ERRCODE='23514'; END IF;
 expected_workflow:='fx:'||c.recovery_epoch||':'||c.partition_no||':'||c.recovery_position||':0:account_discovery_redrive';
 FOR receiver IN SELECT consumer,workflow_id,state FROM core.history_event_consumer
   WHERE partition_no=c.partition_no AND position=c.recovery_position AND event_seq=0
   ORDER BY consumer LIMIT 33 FOR SHARE
 LOOP
   receiver_count:=receiver_count+1;
   IF receiver_count>32 OR receiver.consumer<>'account_discovery_redrive' OR
      receiver.workflow_id<>expected_workflow OR receiver.state<>'completed' THEN
     RAISE EXCEPTION 'identity retention recovery effect consumer unknown' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF receiver_count<>1 THEN RAISE EXCEPTION 'identity retention recovery effect consumer unavailable' USING ERRCODE='23514'; END IF;
 FOR h IN SELECT * FROM core.agent_identity_history_copy WHERE partition_no=c.partition_no
   AND source_route=c.source_route AND source_account_id=c.source_account_id AND source_direction=c.source_direction
   AND source_receipt_id=c.source_receipt_id AND source_digest=c.source_digest
   AND source_epoch=c.recovery_epoch AND source_position=c.recovery_position
   AND source_transaction_id=c.recovery_transaction_id ORDER BY artifact_type,locator LIMIT 3 FOR SHARE
 LOOP
   n:=n+1;
   IF n>2 OR h.receiver_epoch<>c.receiver_epoch OR h.domain_generation<>c.domain_generation OR
      NOT h.locator=ANY(c.expected_locators) THEN
     RAISE EXCEPTION 'identity retention recovery serializer cut changed' USING ERRCODE='23514'; END IF;
   SELECT jsonb_agg(jsonb_build_array(account_route,account_id::text,roles) ORDER BY account_route,account_id),
     count(*),bool_and(minimizer_version=1),
     sha256(convert_to(replace(json_agg(json_build_array(account_route,account_id,roles)
       ORDER BY account_route,account_id)::text,' ',''),'UTF8'))
     INTO actual_accounts,role_count,supported_roles,role_hash FROM (
       SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
       WHERE partition_no=c.partition_no AND artifact_type=h.artifact_type AND locator=h.locator
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE
     ) scope;
   IF role_count NOT BETWEEN 1 AND 64 OR supported_roles IS DISTINCT FROM true OR
      actual_accounts IS DISTINCT FROM c.expected_accounts THEN
     RAISE EXCEPTION 'identity retention recovery roles changed' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM core.history_receiving_proof p JOIN core.history_locator l
     ON l.partition_no=p.partition_no AND l.account_route=p.account_route AND l.account_id=p.account_id
       AND l.artifact_type=p.artifact_type AND l.locator=p.locator
     JOIN core.history_seal s ON s.partition_no=l.partition_no AND s.account_route=l.account_route AND s.account_id=l.account_id
     WHERE p.partition_no=c.partition_no AND p.account_route=(b->>'accountRoute')::integer
       AND p.account_id=erased AND p.artifact_type=h.artifact_type AND p.locator=h.locator
       AND p.role_digest=role_hash AND p.barrier_version=(b->>'version')::integer AND p.barrier_at=b->>'at'
       AND p.partition_epoch=c.receiver_epoch AND l.state='minimized' AND l.proof_barrier=erased
       AND l.minimizer_version=1 AND s.phase<>'open' AND s.barrier_id=erased FOR SHARE OF p,l,s;
   IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery receiving copy pending' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'identity retention recovery cut incomplete' USING ERRCODE='23514'; END IF;
 -- Search owns current discovery enrollment. A checkpoint or a population scan does
 -- not prove its current generation set or same-home closure; keep this transition pending
 -- until History/Work supplies that released-owner observation and final verification.
 RAISE EXCEPTION 'identity retention recovery discovery owner unavailable' USING ERRCODE='23514';
END $$;


--
-- Name: check_agent_identity_retention(access.agent_identity_intent, text); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.check_agent_identity_retention(i access.agent_identity_intent, p_role text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE m core.agent_identity_work; inv core.agent_identity_inventory;
 o core.agent_identity_sdk_obligation; b jsonb; ref jsonb; erased uuid; c record;
 l record; role_hash bytea; supported_roles boolean; n integer:=0; k integer; r record;
BEGIN
 IF i.source_partition<>0 OR p_role IS NULL OR p_role NOT IN ('subject','requester','decider') THEN
   RAISE EXCEPTION 'identity retention source home unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT m FROM core.agent_identity_work WHERE source_key=i.delivery_key FOR SHARE;
 ref:=m.history_authority->'reference'; b:=ref->'barrier';
 erased:=CASE p_role WHEN 'subject' THEN i.account_id WHEN 'requester' THEN i.requested_by ELSE i.decided_by END;
 IF erased IS NULL OR ref->>'erasedRole' IS DISTINCT FROM p_role OR
    b->>'accountId' IS DISTINCT FROM erased::text OR (b->>'accountRoute')::integer/16<>0 OR
    ref->'receipt' IS DISTINCT FROM jsonb_build_object('kind',i.direction,'account',i.account_id,'receipt',i.receipt_id) OR
    ref->>'sourceDigest' IS DISTINCT FROM i.intent_digest OR
    ref->'source' IS DISTINCT FROM jsonb_build_object('partition',i.source_partition,'epoch',i.source_epoch,
      'position',i.source_position::text,'transactionId',i.source_transaction_id) OR
    m.workflow_id IS DISTINCT FROM i.workflow_id OR m.source->>'digest' IS DISTINCT FROM i.intent_digest OR
    m.sdk_readiness IS NULL OR m.sdk_closure IS NULL OR m.sdk_retirement_receipt IS NULL OR
    (p_role='subject' AND m.history_authority->>'disposition' IS DISTINCT FROM 'discharged') OR
    (p_role<>'subject' AND m.history_authority->>'disposition' IS DISTINCT FROM 'transferred') THEN
   RAISE EXCEPTION 'identity retention original custody changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM access.erasure e JOIN access.account a ON a.route=e.route AND a.account_id=e.account_id
   WHERE e.route=(b->>'accountRoute')::integer AND e.account_id=erased
     AND e.version=(b->>'version')::integer AND e.at=(b->>'at')::timestamptz
     AND a.state='deleted' AND a.authn_fenced FOR SHARE OF e,a;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention root changed' USING ERRCODE='23514'; END IF;
 PERFORM core.check_agent_identity_history(m.custody_id,m.sdk_readiness->'binding',m.history_authority,m.sdk_closure,'closure');
 PERFORM core.check_agent_identity_history_absence(m.custody_id);
 SELECT * INTO STRICT inv FROM core.agent_identity_inventory WHERE partition_no=i.source_partition
   AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
   AND source_receipt_id=i.receipt_id FOR SHARE;
 SELECT * INTO STRICT o FROM core.agent_identity_sdk_obligation WHERE partition_no=i.source_partition
   AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
   AND source_receipt_id=i.receipt_id FOR SHARE;
 IF inv.state<>'sealed' OR inv.native_writer_state<>'closed' OR inv.producer_version<>1 OR
    inv.conversion_coverage<>'native-receipt-outbox/v1' OR cardinality(inv.expected_locators) NOT BETWEEN 2 AND 3 OR
    inv.generation<>o.generation OR inv.receiver_epoch<>i.source_epoch OR
    (inv.source_digest,inv.source_epoch,inv.source_position,inv.source_transaction_id) IS DISTINCT FROM
    (i.intent_digest,i.source_epoch,i.source_position,i.source_transaction_id) THEN
   RAISE EXCEPTION 'identity retention native cut changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.history_family_domain WHERE singleton AND generation=inv.domain_generation FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention restore changed' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT 'durable-work/v1'::text AS artifact_type,
     decode('0103','hex')||convert_to(m.custody_id::text,'UTF8') AS locator,
     m.receiver_epoch AS receiver_epoch
   UNION ALL SELECT h.artifact_type,h.locator,h.receiver_epoch FROM (
     SELECT * FROM core.agent_identity_history_copy WHERE partition_no=i.source_partition
       AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
       AND source_receipt_id=i.receipt_id ORDER BY artifact_type,locator LIMIT 4 FOR SHARE
   ) h WHERE h.source_digest=i.intent_digest AND h.source_epoch=i.source_epoch
     AND h.source_position=i.source_position AND h.source_transaction_id=i.source_transaction_id
     AND h.domain_generation=inv.domain_generation AND h.receiver_epoch=inv.receiver_epoch
 LOOP
   n:=n+1;
   IF n>4 OR (c.artifact_type<>'durable-work/v1' AND NOT c.locator=ANY(inv.expected_locators)) THEN
     RAISE EXCEPTION 'identity retention copy cut changed' USING ERRCODE='23514'; END IF;
   SELECT sha256(convert_to(replace(json_agg(json_build_array(account_route,account_id,roles)
       ORDER BY account_route,account_id)::text,' ',''),'UTF8')),count(*),bool_and(minimizer_version=1)
       INTO role_hash,k,supported_roles FROM (
     SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator WHERE partition_no=0
       AND artifact_type=c.artifact_type AND locator=c.locator ORDER BY account_route,account_id LIMIT 65 FOR SHARE
   ) scope;
   IF k NOT BETWEEN 1 AND 64 OR supported_roles IS DISTINCT FROM true THEN RAISE EXCEPTION 'identity retention role union changed' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM core.history_receiving_proof p JOIN core.history_locator l
     ON l.partition_no=p.partition_no AND l.account_route=p.account_route AND l.account_id=p.account_id
       AND l.artifact_type=p.artifact_type AND l.locator=p.locator
     JOIN core.history_seal s ON s.partition_no=l.partition_no AND s.account_route=l.account_route AND s.account_id=l.account_id
     WHERE p.partition_no=0 AND p.account_route=(b->>'accountRoute')::integer AND p.account_id=erased
       AND p.artifact_type=c.artifact_type AND p.locator=c.locator AND p.role_digest=role_hash
       AND p.barrier_version=(b->>'version')::integer AND p.barrier_at=b->>'at' AND p.partition_epoch=c.receiver_epoch
       AND l.state='minimized' AND l.proof_barrier=erased AND l.minimizer_version=1
       AND s.phase<>'open' AND s.barrier_id=erased FOR SHARE OF p,l,s;
   IF NOT FOUND THEN RAISE EXCEPTION 'identity retention receiving copy pending' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n<>cardinality(inv.expected_locators)+1 THEN
   RAISE EXCEPTION 'identity retention copy cut incomplete' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.history_work WHERE partition_no=0 AND work_id=m.custody_id
   AND owner='access.agent-identity' AND request_digest=m.request_digest AND state='retired'
   AND owner_ready AND absence_verified AND request IS NULL AND scope IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention durable physical copy remains' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.receipt WHERE partition_no=0 AND principal_kind=inv.native_principal_kind
   AND principal_id=inv.native_principal_id AND command_kind=inv.native_command_kind AND idempotency_key=inv.native_receipt_key
   AND transaction_id=i.source_transaction_id AND epoch=i.source_epoch AND position=i.source_position
   AND payload_state='minimized' AND response='null'::jsonb FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention receipt physical copy remains' USING ERRCODE='23514'; END IF;
 k:=0;
 FOR r IN SELECT * FROM core.outbox WHERE partition_no=0 AND position=i.source_position
   ORDER BY event_seq LIMIT 3 FOR SHARE
 LOOP
   k:=k+1;
   IF k>2 OR r.epoch<>i.source_epoch OR r.payload_state<>'minimized' OR r.data<>'{}'::jsonb OR r.subject IS NOT NULL
     OR r.type IS DISTINCT FROM inv.expected_event_types[k] THEN
     RAISE EXCEPTION 'identity retention outbox physical copy remains' USING ERRCODE='23514'; END IF;
   n:=0;
   FOR l IN SELECT * FROM core.history_event_consumer WHERE partition_no=0 AND position=r.position
     AND event_seq=r.event_seq ORDER BY consumer LIMIT 33 FOR SHARE
   LOOP
     n:=n+1;
     IF n>32 OR l.workflow_id<>m.workflow_id OR l.state NOT IN ('completed','transferred') OR
        o.handoff_partition<>0 OR o.handoff_epoch<>r.epoch OR o.handoff_position<>r.position OR
        o.handoff_event_type<>r.type OR o.handoff_transaction_id<>i.source_transaction_id OR
        l.consumer<>'agent_verification_reversal' OR i.direction<>'account-agent.unverify' THEN
       RAISE EXCEPTION 'outbox-receiving-custody-unavailable' USING ERRCODE='23514'; END IF;
   END LOOP;
 END LOOP;
 IF k<>cardinality(inv.expected_event_types) THEN
   RAISE EXCEPTION 'identity retention original outbox incomplete' USING ERRCODE='23514'; END IF;
 PERFORM access.check_agent_identity_recovery_retention(i,p_role,b,erased);
END $$;


--
-- Name: close_membership_authority(integer, uuid, uuid, timestamp with time zone, uuid); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.close_membership_authority(p_route integer, p_organization_id uuid, p_member_id uuid, p_at timestamp with time zone, p_transaction_id uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  target record;
  changed integer := 0;
  overlapping CURSOR FOR
    SELECT m.valid
    FROM access.organization_member m
    WHERE m.route = p_route AND m.organization_id = p_organization_id
      AND m.member_account_id = p_member_id
      AND m.valid && tstzrange(p_at, NULL, '[)')
    -- Retain the native GiST traversal; all matching routes have distance zero.
    ORDER BY m.route <-> p_route
    FOR UPDATE;
BEGIN
  OPEN overlapping;
  LOOP
    FETCH overlapping INTO target;
    EXIT WHEN NOT FOUND;

    IF lower_inf(target.valid) OR lower(target.valid) < p_at THEN
      UPDATE access.organization_member
      SET valid = tstzrange(lower(target.valid), p_at,
                            CASE WHEN lower_inc(target.valid) THEN '[)' ELSE '()' END),
          transaction_id = p_transaction_id
      WHERE CURRENT OF overlapping;
    ELSE
      -- Including lower = T: delete rather than construct an empty range.
      DELETE FROM access.organization_member WHERE CURRENT OF overlapping;
    END IF;
    changed := changed + 1;
  END LOOP;
  CLOSE overlapping;
  RETURN changed;
END;
$$;


--
-- Name: committed_continuation_completion_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.committed_continuation_completion_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Committed continuation completions are immutable';
END;
$$;


--
-- Name: committed_continuation_entries(jsonb, integer, integer, boolean); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.committed_continuation_entries(value jsonb, minimum integer, maximum integer, completed boolean) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) BETWEEN minimum AND maximum
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS elem
      WHERE jsonb_typeof(elem) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(elem) AS object_key) <> CASE WHEN completed THEN 5 ELSE 4 END
        OR COALESCE(elem->>'step', '') !~ '^[a-z][a-z0-9-]{0,63}$'
        OR COALESCE(length(elem->>'target'), 0) NOT BETWEEN 1 AND 128
        OR COALESCE(length(elem->>'key'), 0) NOT BETWEEN 1 AND 240
        OR COALESCE(elem->>'digest', '') !~ '^[0-9a-f]{64}$'
        OR (completed AND COALESCE(elem->>'receiptId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR (NOT completed AND jsonb_exists(elem, 'receiptId'))
    );
$_$;


--
-- Name: committed_continuation_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.committed_continuation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(OLD) - 'expires_at' - 'completions') = (to_jsonb(NEW) - 'expires_at' - 'completions')
    AND (
      (OLD.expires_at = NEW.expires_at
        AND jsonb_array_length(NEW.completions) = jsonb_array_length(OLD.completions) + 1
        AND NEW.completions @> OLD.completions)
      OR (NEW.completions = OLD.completions AND NEW.expires_at > OLD.expires_at AND NEW.expires_at > OLD.created_at)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Committed continuations are immutable';
END;
$$;


--
-- Name: deliver_resource_role_provenance(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.deliver_resource_role_provenance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM access.try_deliver_resource_role_provenance(NEW.route,NEW.occurrence);
 RETURN NEW;
END; $$;


--
-- Name: enroll_auth_erasure_live(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.enroll_auth_erasure_live() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 -- capture_auth_erasure_obligation already holds the native home/source locks.
 -- A changed home keeps ordinary deletion working, but poisons this old lineage
 -- permanently until an actual native lineage handoff is implemented by its owner.
 UPDATE access.auth_erasure_live_partition l SET enrolled_through=NEW.ordinal,
  lineage_valid=l.lineage_valid AND EXISTS(
   SELECT 1 FROM access.auth_erasure_source s JOIN core.partition p USING(partition_no)
    WHERE s.partition_no=NEW.partition_no AND s.head=NEW.ordinal
     AND (s.generation,s.source_epoch,s.source_owner)=(l.generation,l.source_epoch,l.source_owner)
     AND p.write_state='active' AND p.epoch=l.source_epoch AND p.node=l.source_owner)
 WHERE l.partition_no=NEW.partition_no;
 RETURN NEW;
END; $$;


--
-- Name: erasure_entry_account(text, text); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.erasure_entry_account(step text, target text) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT CASE
   WHEN step IN ('erase-auth-owner','revoke-auth-sessions','operator-responsibility-page','operator-unfence-page')
     THEN target::uuid
   WHEN step IN ('retire-operator','release-operator','fence','unfence') THEN split_part(target,':',1)::uuid
 END;
$$;


--
-- Name: erasure_requested_principal(text); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.erasure_requested_principal(value text) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT CASE WHEN value ~ '^urn:rezics:request:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN split_part(value, ':', 4)::uuid END;
$_$;


--
-- Name: guard_account_creation_time(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_account_creation_time() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.created_at IS DISTINCT FROM OLD.created_at AND NOT (NEW.created_at IS NULL AND access.native_terminal_account_ready(OLD)) THEN
  RAISE EXCEPTION 'Account creation time is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;


--
-- Name: guard_account_identity(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_account_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.route IS DISTINCT FROM OLD.route THEN
    RAISE EXCEPTION 'Account ID, kind and route are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.minimum_authn_epoch < OLD.minimum_authn_epoch THEN
    RAISE EXCEPTION 'Authentication epoch floor cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_agent_identity_intent(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_agent_identity_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE role text; erased uuid; i access.agent_identity_intent; a access.agent_identity_recovery;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Account identity source requires receiving erasure custody' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='agent_identity_recovery' THEN
   SELECT * INTO STRICT i FROM access.agent_identity_intent WHERE route=OLD.route AND account_id=OLD.account_id
     AND direction=OLD.direction AND receipt_id=OLD.receipt_id FOR SHARE;
   SELECT history_authority->'reference'->>'erasedRole',
     (history_authority->'reference'->'barrier'->>'accountId')::uuid INTO role,erased
     FROM core.agent_identity_work WHERE source_key=i.delivery_key FOR SHARE;
   PERFORM access.check_agent_identity_retention(i,role);
   IF (to_jsonb(NEW)-ARRAY['requested_by','decided_by','original_source','original_source_minimized']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['requested_by','decided_by','original_source','original_source_minimized']) OR
      NEW.requested_by IS DISTINCT FROM (CASE WHEN OLD.requested_by=erased THEN NULL ELSE OLD.requested_by END) OR
      NEW.decided_by IS DISTINCT FROM (CASE WHEN OLD.decided_by=erased THEN NULL ELSE OLD.decided_by END) OR
      NEW.original_source IS DISTINCT FROM (CASE WHEN role='subject' AND OLD.original_source IS NOT NULL
        THEN access.agent_identity_recovery_skeleton(OLD.original_source) ELSE OLD.original_source END) OR
      NEW.original_source_minimized IS DISTINCT FROM
        (OLD.original_source_minimized OR (role='subject' AND OLD.original_source IS NOT NULL)) THEN
     RAISE EXCEPTION 'identity recovery may minimize only the erased role' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME<>'agent_identity_intent' THEN
   RAISE EXCEPTION 'Account identity source requires receiving erasure custody' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['requested_by','decided_by','reason','intent','minimized']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['requested_by','decided_by','reason','intent','minimized']) THEN
   RAISE EXCEPTION 'Immutable account identity source' USING ERRCODE='23514'; END IF;
 SELECT history_authority->'reference'->>'erasedRole',
   (history_authority->'reference'->'barrier'->>'accountId')::uuid INTO role,erased
   FROM core.agent_identity_work WHERE source_key=OLD.delivery_key FOR SHARE;
 PERFORM access.check_agent_identity_retention(OLD,role);
 SELECT * INTO a FROM access.agent_identity_recovery WHERE route=OLD.route AND account_id=OLD.account_id
   AND direction=OLD.direction AND receipt_id=OLD.receipt_id FOR SHARE;
 IF FOUND AND ((role='subject' AND a.original_source IS NOT NULL AND NOT a.original_source_minimized) OR
    (role='requester' AND a.requested_by IS NOT NULL) OR (role='decider' AND a.decided_by IS NOT NULL)) THEN
   RAISE EXCEPTION 'identity recovery role transition is incomplete' USING ERRCODE='23514'; END IF;
 IF NEW.requested_by IS DISTINCT FROM (CASE WHEN OLD.requested_by=erased THEN NULL ELSE OLD.requested_by END) OR
    NEW.decided_by IS DISTINCT FROM (CASE WHEN OLD.decided_by=erased THEN NULL ELSE OLD.decided_by END) OR
    NEW.reason IS DISTINCT FROM (CASE WHEN OLD.decided_by=erased THEN NULL ELSE OLD.reason END) OR
    NEW.minimized IS DISTINCT FROM (OLD.minimized OR role='subject') OR
    NEW.intent IS DISTINCT FROM (CASE WHEN role='subject' THEN '{}'::jsonb ELSE OLD.intent END) THEN
   RAISE EXCEPTION 'identity retention may minimize only the erased personal role' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_agent_identity_recovery_insert(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_agent_identity_recovery_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.original_source_minimized THEN
   RAISE EXCEPTION 'New recovery source cannot claim prior minimization' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_assignment_identity(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_assignment_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR (NEW.issued_valid IS NOT NULL AND NEW.issued_valid IS DISTINCT FROM NEW.valid) THEN
      RAISE EXCEPTION 'Assignment must begin with its original validity' USING ERRCODE = '23514';
    END IF;
    NEW.issued_valid := NEW.valid;
  ELSE
    IF ROW(NEW.route, NEW.principal_id, NEW.request_id, NEW.creator_principal_id, NEW.issued_valid, NEW.transaction_id)
       IS DISTINCT FROM
       ROW(OLD.route, OLD.principal_id, OLD.request_id, OLD.creator_principal_id, OLD.issued_valid, OLD.transaction_id)
       OR (OLD.creator_principal_id IS NOT NULL AND NEW.assigned_actor_id IS DISTINCT FROM OLD.assigned_actor_id)
       OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.valid) IS DISTINCT FROM ROW(OLD.revoked_at, OLD.valid))
       OR (OLD.creator_principal_id IS NOT NULL AND NEW.revoked_at IS NULL AND NEW.valid IS DISTINCT FROM OLD.valid)
       OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
           AND NEW.valid IS DISTINCT FROM OLD.valid * tstzrange(NULL, NEW.revoked_at, '[)')) THEN
      RAISE EXCEPTION 'Assignment identity and revocation are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_auth_receiving_witness(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_auth_receiving_witness() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_erasure(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Erasure records are permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.route IS DISTINCT FROM OLD.route OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.at IS DISTINCT FROM OLD.at
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Erasure records cannot reopen or change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_erasure_acknowledgement(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_erasure_acknowledgement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  store text;
  resolved jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.route IS DISTINCT FROM OLD.route OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.participant IS DISTINCT FROM OLD.participant OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.retained IS DISTINCT FROM OLD.retained OR NOT (NEW.resolutions @> OLD.resolutions) THEN
    RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
  END IF;
  FOR store, resolved IN SELECT key, value FROM jsonb_each(NEW.resolutions) LOOP
    IF jsonb_typeof(resolved) <> 'string' OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.retained) x
      WHERE x->>'store' = store AND (x->>'expiresAt')::timestamptz <= (resolved #>> '{}')::timestamptz
    ) THEN
      RAISE EXCEPTION 'Invalid retention resolution' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: guard_identity_technical_source(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_identity_technical_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION 'Accepted Accounts technical custody requires its native consumer release';
END; $$;


--
-- Name: guard_lifecycle_responsibility(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_lifecycle_responsibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ((NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id AND NEW.operator_account_id IS NOT NULL)
      OR (NEW.state = 'deleted' AND OLD.state <> 'deleted'))
     AND EXISTS (SELECT 1 FROM access.lifecycle_coordination
                 WHERE route = OLD.route AND account_id = OLD.account_id) THEN
    RAISE EXCEPTION 'Unresolved account responsibility' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_live_copy_gate(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_live_copy_gate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.outcome='applying' AND NEW.outcome IN ('applied','superseded')
   AND (to_jsonb(OLD)-'outcome')=(to_jsonb(NEW)-'outcome') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.outcome<>'applying' AND NOT OLD.retired AND NEW.retired
   AND NEW.effect_key IS NULL AND NEW.payload IS NULL AND NEW.roles IS NULL
   AND (to_jsonb(OLD)-'effect_key'-'payload'-'roles'-'retired')=(to_jsonb(NEW)-'effect_key'-'payload'-'roles'-'retired')
   AND current_setting('rezics.erasure_progress',true) IS NOT NULL THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy receiver result is immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: guard_live_copy_hold(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_live_copy_hold() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.result_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access.live_copy_role_gate g
   WHERE (g.route,g.source_domain,g.transition_id,g.role_index)=(NEW.route,NEW.source_domain,NEW.transition_id,NEW.role_index)
   AND g.result_id IS NULL) THEN RAISE EXCEPTION 'Live copy role gate is closed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM access.account a WHERE a.route=NEW.route AND a.account_id=NEW.account_id
    AND a.state='active' AND NOT a.authn_fenced FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Live copy requires an active native role account' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM access.live_copy_domain d JOIN core.partition p USING(partition_no)
    WHERE d.partition_no=NEW.route>>4 AND d.domain_id=NEW.account_domain AND d.state='active'
      AND (d.node,d.epoch)=(p.node,p.epoch) AND p.write_state='active') THEN
   RAISE EXCEPTION 'Live copy account domain unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.result_id IS NULL AND NEW.result_id IS NOT NULL
   AND (to_jsonb(OLD)-'result_id'-'outcome')=(to_jsonb(NEW)-'result_id'-'outcome') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND OLD.result_id IS NOT NULL AND current_setting('rezics.erasure_progress',true) IS NOT NULL THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Live copy hold identity and terminal result are immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: guard_live_copy_inventory(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_live_copy_inventory() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE closed boolean;
BEGIN
 INSERT INTO access.live_copy_seal(partition_no,account_id) VALUES(NEW.route>>4,NEW.account_id) ON CONFLICT DO NOTHING;
 SELECT sealed INTO STRICT closed FROM access.live_copy_seal WHERE partition_no=NEW.route>>4 AND account_id=NEW.account_id FOR SHARE;
 IF closed THEN RAISE EXCEPTION 'Live copy inventory sealed for account erasure' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_live_copy_role_gate(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_live_copy_role_gate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.result_id IS NULL AND NEW.result_id IS NOT NULL
  AND (to_jsonb(OLD)-'result_id'-'outcome')=(to_jsonb(NEW)-'result_id'-'outcome') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy role closure is immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: guard_live_copy_transition(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_live_copy_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='pending' AND NEW.state='pending'
  AND (to_jsonb(OLD)-'next_run')=(to_jsonb(NEW)-'next_run') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.state='pending' AND NEW.state='complete' AND NEW.result_id IS NOT NULL
  AND (to_jsonb(OLD)-'state'-'result_id'-'outcome'-'next_run')=(to_jsonb(NEW)-'state'-'result_id'-'outcome'-'next_run') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.state='complete' AND NEW.state='retired' AND NEW.payload IS NULL AND NEW.roles IS NULL
  AND NEW.effect_key=jsonb_build_object('retired',OLD.transition_id)
  AND (to_jsonb(OLD)-'state'-'payload'-'roles'-'effect_key')=(to_jsonb(NEW)-'state'-'payload'-'roles'-'effect_key')
  AND current_setting('rezics.erasure_progress',true) IS NOT NULL THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy original source and effect are immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: guard_membership_inverse(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_membership_inverse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM access.membership_inverse_terminal t
    WHERE t.route = OLD.route AND t.account_id = OLD.account_id
      AND t.kind = OLD.kind AND t.group_id = OLD.group_id
      AND t.reservation_id = OLD.reservation_id
      AND t.reservation_transaction_id = OLD.transaction_id
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    -- Rotation keeps the logical membership and cap slot, but retires only a
    -- reservation whose immutable authoritative terminal proof was verified.
    IF NEW.route = OLD.route AND NEW.account_id = OLD.account_id
      AND NEW.kind = OLD.kind AND NEW.group_id = OLD.group_id
      AND NEW.reservation_id <> OLD.reservation_id THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Membership inverse requires verified terminal compensation' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_membership_terminal(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_membership_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Membership terminal proof is immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_native_continuation_delete(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_native_continuation_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD))
 OR EXISTS (SELECT 1 FROM access.committed_continuation_entry WHERE route=OLD.route AND continuation_id=OLD.continuation_id)
 OR EXISTS (SELECT 1 FROM access.committed_continuation_completion WHERE route=OLD.route AND continuation_id=OLD.continuation_id)
 OR EXISTS (SELECT 1 FROM access.operator_fence_page WHERE route=OLD.route AND continuation_id=OLD.continuation_id) THEN
  RAISE EXCEPTION 'Continuation erasure requires finished consumers and drained children' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END;
$$;


--
-- Name: guard_native_erasure_replay(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_native_erasure_replay() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM 1 FROM access.committed_continuation c
   WHERE c.route=NEW.route AND c.continuation_id=NEW.continuation_id FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Native continuation has been erased' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM access.erasure_native_consumed_child d
   WHERE d.route=NEW.route AND d.continuation_id=NEW.continuation_id
   AND d.artifact=CASE TG_TABLE_NAME WHEN 'committed_continuation_entry' THEN 'entry'
     WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END
   AND d.entry_key=CASE WHEN TG_TABLE_NAME='operator_fence_page'
     THEN sha256(convert_to(to_jsonb(NEW)->>'page_key','UTF8'))
     ELSE sha256(convert_to(concat_ws(':',to_jsonb(NEW)->>'step',to_jsonb(NEW)->>'key'),'UTF8')) END) THEN
  RAISE EXCEPTION 'Native continuation child is permanently consumed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;


--
-- Name: guard_realm_erasure_succession(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_realm_erasure_succession() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Realm succession source custody has no consumer closure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route,NEW.resource_id,NEW.account_id,NEW.source_route,NEW.source_version,NEW.source_at,
         NEW.source_ownership_state,NEW.source_orphaned_at,NEW.source_claim_eligible_at)
       IS DISTINCT FROM ROW(OLD.route,OLD.resource_id,OLD.account_id,OLD.source_route,OLD.source_version,OLD.source_at,
         OLD.source_ownership_state,OLD.source_orphaned_at,OLD.source_claim_eligible_at)
     OR (OLD.decision_state IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Realm succession source and terminal decision are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: guard_realm_membership_transition(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_realm_membership_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.proof_transaction_id IS NULL AND NEW.proof_transaction_id IS NOT NULL
    AND NEW.outcome IS NOT NULL AND NEW.consumed_transaction_id IS NOT NULL
    AND (to_jsonb(OLD) - 'proof_transaction_id' - 'outcome' - 'consumed_transaction_id') =
        (to_jsonb(NEW) - 'proof_transaction_id' - 'outcome' - 'consumed_transaction_id')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Realm transition provenance and consumption are immutable' USING ERRCODE = '23514';
END; $$;


--
-- Name: guard_resource_role_provenance(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_resource_role_provenance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE enrolled record;
BEGIN
 IF ROW(NEW.route,NEW.occurrence,NEW.resource_id,NEW.resource_type,NEW.original_creator,NEW.account_id,
        NEW.grant_role,NEW.valid,NEW.side,NEW.grant_transaction,NEW.source_transaction)
    IS DISTINCT FROM
    ROW(OLD.route,OLD.occurrence,OLD.resource_id,OLD.resource_type,OLD.original_creator,OLD.account_id,
        OLD.grant_role,OLD.valid,OLD.side,OLD.grant_transaction,OLD.source_transaction) THEN
   RAISE EXCEPTION 'Native role occurrence metadata is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.resource_type='semantic.context' AND
    (NEW.context_key IS DISTINCT FROM OLD.context_key OR NEW.delivery IS DISTINCT FROM OLD.delivery) THEN
   IF OLD.delivery<>'pending' OR NEW.delivery='pending' THEN
     RAISE EXCEPTION 'Invalid native Context delivery transition' USING ERRCODE='23514';
   END IF;
   -- Re-run the real, idempotent Source port rather than trusting a supplied result/key.
   -- This also protects direct SQL updates without reading any Source-owned table.
   IF to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)') IS NULL THEN
     RAISE EXCEPTION 'Context historical-party receiver unavailable' USING ERRCODE='23514';
   END IF;
   SELECT * INTO enrolled FROM semantic.enroll_context_role_provenance(
     OLD.route,OLD.occurrence,OLD.resource_id,OLD.original_creator,OLD.account_id,OLD.grant_role,
     OLD.valid::text,OLD.side,OLD.grant_transaction,OLD.source_transaction);
   IF NOT FOUND THEN
     RAISE EXCEPTION 'Context historical-party enrollment unresolved' USING ERRCODE='23514';
   END IF;
   IF NOT coalesce(
     (NEW.delivery='delivered' AND enrolled.state='enrolled' AND enrolled.context_key>0
       AND NEW.context_key=enrolled.context_key)
     OR (NEW.delivery='not-applicable' AND enrolled.state='not-applicable' AND NEW.context_key IS NULL),false) THEN
     RAISE EXCEPTION 'Context delivery requires actual native Source enrollment' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_retired_handle(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_retired_handle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.state = 'retired' THEN
    RAISE EXCEPTION 'Retired handles are permanent' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.state = 'retired' THEN
    IF TG_OP <> 'UPDATE' OR OLD.state <> 'reserved' OR OLD.hold_operation_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM access.erasure e WHERE e.account_id = OLD.account_id
        AND e.route = (get_byte(uuid_send(OLD.account_id),10)*256+get_byte(uuid_send(OLD.account_id),11)))
      OR EXISTS (SELECT 1 FROM access.lifecycle_handle_operation o WHERE o.account_id = OLD.account_id
        AND o.route = (get_byte(uuid_send(OLD.account_id),10)*256+get_byte(uuid_send(OLD.account_id),11))
        AND o.state = 'published') THEN
      RAISE EXCEPTION 'Handle erasure requires a permanent obligation and finished consumer' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM access.erasure e WHERE e.account_id = NEW.account_id
    AND e.route = (get_byte(uuid_send(NEW.account_id),10)*256+get_byte(uuid_send(NEW.account_id),11))) THEN
    -- The committed deletion's real native redirect consumer may finish. No new
    -- reservation, hold, ownership or revival can cross the permanent barrier.
    IF TG_OP <> 'UPDATE' OR OLD.account_id IS DISTINCT FROM NEW.account_id
      OR OLD.state <> 'active' OR NEW.state <> 'reserved' OR NEW.hold_operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'Erased accounts cannot allocate handles' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: resource_role_grant; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_role_grant (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_kind text DEFAULT 'identity'::text NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    grant_role text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT resource_role_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_role_grant_check1 CHECK ((((subject_kind = 'identity'::text) AND (subject_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((subject_kind = 'active_accounts'::text) AND (subject_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (subject_role = ''::text)))),
    CONSTRAINT resource_role_grant_grant_role_check CHECK ((grant_role ~ '^[a-z][a-z0-9_.-]*$'::text)),
    CONSTRAINT resource_role_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_role_grant_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['identity'::text, 'active_accounts'::text]))),
    CONSTRAINT resource_role_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_role_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: index_current_resource_role(access.resource_role_grant); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.index_current_resource_role(source access.resource_role_grant) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE anchor timestamptz;
BEGIN
  INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
  SELECT source.route,source.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
  ON CONFLICT DO NOTHING;
  UPDATE access.current_resource_role_frontier SET version=version+1
  WHERE route=source.route AND resource_id=source.resource_id RETURNING processed_at INTO STRICT anchor;
  DELETE FROM access.current_resource_role_key WHERE interval_key=source.erasure_key;
  DELETE FROM access.current_resource_role_due WHERE interval_key=source.erasure_key;
  IF source.valid @> anchor THEN
    INSERT INTO access.current_resource_role_key VALUES
      (source.route,source.resource_id,source.grant_role,source.subject_kind,source.subject_id,source.subject_role,source.erasure_key);
  END IF;
  INSERT INTO access.current_resource_role_due
    SELECT source.route,source.resource_id,boundary,source.erasure_key
    FROM (VALUES (lower(source.valid)),(upper(source.valid))) b(boundary)
    WHERE boundary > anchor ON CONFLICT DO NOTHING;
END; $$;


--
-- Name: initialize_auth_erasure_partition(integer); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.initialize_auth_erasure_partition(p integer) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE source access.auth_erasure_source; item record;
BEGIN
 source:=access.lock_auth_erasure_source(p);
 IF source.initialized THEN RETURN true; END IF;
 FOR item IN SELECT route,account_id FROM access.erasure
   WHERE route BETWEEN p*16 AND p*16+15 AND NOT auth_obligation_indexed
   ORDER BY route,account_id LIMIT 48
 LOOP
  PERFORM access.capture_auth_erasure_obligation(item.route,item.account_id,false);
 END LOOP;
 IF EXISTS(SELECT 1 FROM access.erasure WHERE route BETWEEN p*16 AND p*16+15 AND NOT auth_obligation_indexed) THEN
  RETURN false;
 END IF;
 UPDATE access.auth_erasure_source SET initialized=true WHERE partition_no=p;
 RETURN true;
END; $$;


--
-- Name: initialize_membership_inverse(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.initialize_membership_inverse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Accounts born after the writer barrier have no historical memberships.
  NEW.membership_inverse_complete := true;
  RETURN NEW;
END;
$$;


--
-- Name: live_copy_account_delete_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.live_copy_account_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM access.lifecycle_coordination WHERE route=OLD.route AND account_id=OLD.account_id AND purpose='live-copy') THEN
  RAISE EXCEPTION 'Unresolved account responsibility' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END; $$;


--
-- Name: live_copy_coordination_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.live_copy_coordination_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.purpose='live-copy' AND (NEW.related_account_id<>NEW.account_id OR NOT EXISTS(
    SELECT 1 FROM access.live_copy_hold h WHERE (h.route,h.account_id,h.reservation_id)=(NEW.route,NEW.account_id,NEW.reservation_id)
      AND h.source_transaction_id=NEW.transaction_id AND h.result_id IS NULL)) THEN
   RAISE EXCEPTION 'Live copy coordination requires native original hold' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.purpose='live-copy' AND NOT EXISTS(SELECT 1 FROM access.live_copy_hold h
   WHERE (h.route,h.account_id,h.reservation_id)=(OLD.route,OLD.account_id,OLD.reservation_id)
   AND h.result_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Live copy coordination requires exact terminal consumption' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.purpose='live-copy' OR NEW.purpose='live-copy' THEN
   RAISE EXCEPTION 'Live copy coordination identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END; $$;


--
-- Name: live_copy_gate_commit(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.live_copy_gate_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM access.live_copy_gate WHERE route=NEW.route AND source_domain=NEW.source_domain
    AND transition_id=NEW.transition_id AND outcome='applying') THEN
  RAISE EXCEPTION 'Live copy effect and terminal result must commit together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;


--
-- Name: live_copy_partition_activation_guard(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.live_copy_partition_activation_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.write_state='active' AND (TG_OP='INSERT' OR
    (NEW.node,NEW.epoch,NEW.write_state) IS DISTINCT FROM (OLD.node,OLD.epoch,OLD.write_state))
  AND NOT EXISTS(SELECT 1 FROM access.live_copy_domain d
   WHERE d.partition_no=NEW.partition_no AND d.state='active' AND (d.node,d.epoch)=(NEW.node,NEW.epoch)) THEN
  RAISE EXCEPTION 'Live copy domain requires native lineage reconciliation before activation' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.position<OLD.position THEN
  RAISE EXCEPTION 'Live copy committed tail cannot move backwards online' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: auth_erasure_source; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_source (
    partition_no integer NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    source_epoch integer NOT NULL,
    source_owner text NOT NULL,
    head bigint DEFAULT 0 NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    CONSTRAINT auth_erasure_source_head_check CHECK ((head >= 0)),
    CONSTRAINT auth_erasure_source_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT auth_erasure_source_source_epoch_check CHECK ((source_epoch > 0))
);


--
-- Name: lock_auth_erasure_source(integer, boolean); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.lock_auth_erasure_source(p integer, require_lineage boolean DEFAULT true) RETURNS access.auth_erasure_source
    LANGUAGE plpgsql
    AS $$
DECLARE home core.partition; source access.auth_erasure_source;
BEGIN
 SELECT * INTO home FROM core.partition WHERE partition_no=p AND p BETWEEN 0 AND 4095 FOR UPDATE;
 IF NOT FOUND OR home.write_state<>'active' THEN
  RAISE EXCEPTION 'Auth erasure source home unavailable' USING ERRCODE='40001';
 END IF;
 INSERT INTO access.auth_erasure_source(partition_no,source_epoch,source_owner)
 VALUES(p,home.epoch,home.node) ON CONFLICT DO NOTHING;
 SELECT * INTO source FROM access.auth_erasure_source WHERE partition_no=p FOR UPDATE;
 IF require_lineage AND (source.source_epoch<>home.epoch OR source.source_owner<>home.node) THEN
  RAISE EXCEPTION 'Auth erasure source lineage recovery required' USING ERRCODE='40001';
 END IF;
 RETURN source;
END; $$;


--
-- Name: lock_current_auth_receiving_closure(integer, uuid, integer, timestamp with time zone); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.lock_current_auth_receiving_closure(r integer, a uuid, v integer, t timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: resource_role_provenance; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_role_provenance (
    route integer NOT NULL,
    occurrence bigint NOT NULL,
    resource_id uuid NOT NULL,
    resource_type text NOT NULL,
    original_creator uuid NOT NULL,
    account_id uuid NOT NULL,
    grant_role text NOT NULL,
    valid tstzrange,
    side text NOT NULL,
    grant_transaction uuid,
    source_transaction uuid NOT NULL,
    context_key bigint,
    delivery text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT resource_role_provenance_delivery_check CHECK ((delivery = ANY (ARRAY['pending'::text, 'delivered'::text, 'not-applicable'::text]))),
    CONSTRAINT resource_role_provenance_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_role_provenance_side_check CHECK ((side = ANY (ARRAY['creator'::text, 'new'::text, 'former'::text])))
);


--
-- Name: lock_resource_role_provenance(integer, bigint); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.lock_resource_role_provenance(p_route integer, p_occurrence bigint) RETURNS SETOF access.resource_role_provenance
    LANGUAGE plpgsql
    AS $$
DECLARE source access.resource_role_provenance;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0 THEN
   RAISE EXCEPTION 'Invalid native role occurrence key' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM core.partition WHERE partition_no=p_route/16 AND write_state='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native Context home unavailable' USING ERRCODE='40001'; END IF;
 SELECT * INTO source FROM access.resource_role_provenance
   WHERE route=p_route AND occurrence=p_occurrence FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF source.route<>(get_byte(uuid_send(source.resource_id),10)*256+get_byte(uuid_send(source.resource_id),11))
    OR source.source_transaction='00000000-0000-0000-0000-000000000000'::uuid
    OR (source.side='creator' AND (source.account_id<>source.original_creator OR source.grant_role<>''
        OR source.grant_transaction IS NOT NULL OR source.valid IS NOT NULL))
    OR (source.side IN ('new','former') AND (source.grant_transaction IS NULL OR source.valid IS NULL)) THEN
   RAISE EXCEPTION 'Invalid native role occurrence provenance' USING ERRCODE='23514';
 END IF;
 RETURN NEXT source;
END; $$;


--
-- Name: native_erasure_delete_ready(text, jsonb); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.native_erasure_delete_ready(store text, value jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE erased uuid; root access.committed_continuation;
BEGIN
 SELECT p.account_id INTO erased FROM access.erasure_native_progress p JOIN access.erasure e USING(route,account_id)
 WHERE p.progress_id::text=current_setting('rezics.erasure_progress',true);
 IF erased IS NULL OR value->>'erasure_row_id' IS DISTINCT FROM current_setting('rezics.erasure_row',true) THEN RETURN false; END IF;
 IF store='membership_inverse_terminal' THEN
  RETURN (erased=(value->>'account_id')::uuid OR erased=(value->>'group_id')::uuid)
   AND NOT EXISTS (SELECT 1 FROM access.membership_inverse m WHERE m.route=(value->>'route')::int
     AND m.account_id=(value->>'account_id')::uuid AND m.kind=value->>'kind' AND m.group_id=(value->>'group_id')::uuid
     AND m.reservation_id=(value->>'reservation_id')::uuid)
   AND NOT EXISTS (SELECT 1 FROM access.lifecycle_coordination c WHERE c.route=(value->>'route')::int
     AND c.account_id=(value->>'account_id')::uuid AND c.reservation_id=(value->>'reservation_id')::uuid);
 ELSIF store='lifecycle_membership_slot' THEN
  RETURN (value->>'terminal')::boolean AND (erased=(value->>'organization_id')::uuid OR erased=(value->>'member_account_id')::uuid);
 ELSIF store IN ('committed_continuation_entry','committed_continuation_completion','committed_continuation','operator_fence_page') THEN
  IF NOT EXISTS (SELECT 1 FROM access.erasure_continuation_role r WHERE r.route=(value->>'route')::int
    AND r.row_id=(value->>'erasure_row_id')::uuid AND r.account_id=erased
    AND r.artifact=CASE store WHEN 'committed_continuation' THEN 'root' WHEN 'committed_continuation_entry' THEN 'entry'
      WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END) THEN RETURN false; END IF;
  SELECT * INTO root FROM access.committed_continuation WHERE route=(value->>'route')::int
    AND continuation_id=(value->>'continuation_id')::uuid;
  RETURN root.allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb
    AND EXISTS (SELECT 1 FROM access.auth_history_proof p JOIN access.erasure e USING(route,account_id)
      WHERE p.route=root.route AND p.account_id=root.account_id AND p.phase='native-consumed'
        AND p.continuation_id=root.continuation_id AND p.receipt_id=root.barrier_receipt_id AND p.version=e.version AND p.at=e.at)
    AND NOT EXISTS (SELECT 1 FROM access.lifecycle_handle_operation h
      WHERE h.route=root.route AND h.account_id=root.account_id AND h.state='published');
 END IF;
 RETURN false;
END;
$$;


--
-- Name: account; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    handle text COLLATE pg_catalog."C",
    display_name text,
    avatar_url text,
    biography text,
    state text DEFAULT 'pending'::text NOT NULL,
    operator_account_id uuid,
    controller_id uuid,
    birth_date date,
    content_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    suspension_reason text,
    minimum_authn_epoch bigint DEFAULT 1 NOT NULL,
    transaction_id uuid NOT NULL,
    registration_id uuid,
    registration_expires_at timestamp with time zone,
    authn_fenced boolean DEFAULT false NOT NULL,
    fence_receipt_id uuid,
    operator_relation_version bigint DEFAULT 0 NOT NULL,
    operator_reservation_id uuid,
    membership_inverse_complete boolean DEFAULT false NOT NULL,
    handle_operation_id text,
    created_at timestamp with time zone DEFAULT statement_timestamp(),
    rate_tier text DEFAULT 'ordinary'::text NOT NULL,
    links jsonb DEFAULT '[]'::jsonb NOT NULL,
    avatar uuid,
    public_views jsonb DEFAULT '{"posts": true, "realms": false, "reviews": true, "collections": true}'::jsonb NOT NULL,
    speakers_listed boolean DEFAULT false NOT NULL,
    agent_verified boolean DEFAULT false NOT NULL,
    agent_subject_id uuid,
    agent_verification_receipt_id uuid,
    pending_agent_subject_id uuid,
    pending_agent_receipt_id uuid,
    public_changed_at timestamp with time zone DEFAULT statement_timestamp(),
    handle_change_times timestamp with time zone[] DEFAULT '{}'::timestamp with time zone[] NOT NULL,
    membership_time timestamp with time zone,
    discovery_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT account_agent_verification_check CHECK ((((pending_agent_subject_id IS NULL) = (pending_agent_receipt_id IS NULL)) AND ((agent_verified AND (agent_subject_id IS NOT NULL) AND (agent_verification_receipt_id IS NOT NULL) AND (pending_agent_subject_id IS NULL)) OR ((NOT agent_verified) AND (agent_subject_id IS NULL) AND (agent_verification_receipt_id IS NULL))))),
    CONSTRAINT account_avatar_route_check CHECK (((avatar IS NULL) OR (route = ((get_byte(uuid_send(avatar), 10) * 256) + get_byte(uuid_send(avatar), 11))))),
    CONSTRAINT account_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_check1 CHECK (((operator_account_id IS NULL) OR ((kind = 'actor'::text) AND (operator_account_id <> account_id)))),
    CONSTRAINT account_content_preferences_check CHECK ((jsonb_typeof(content_preferences) = 'object'::text)),
    CONSTRAINT account_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT account_handle_change_times_check CHECK ((cardinality(handle_change_times) <= 5)),
    CONSTRAINT account_handle_check CHECK ((handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT account_kind_check CHECK ((kind = ANY (ARRAY['actor'::text, 'organization'::text]))),
    CONSTRAINT account_links_check CHECK (((jsonb_typeof(links) = 'array'::text) AND (jsonb_array_length(links) <= 5))),
    CONSTRAINT account_live_timestamps CHECK (((state = 'deleted'::text) OR ((created_at IS NOT NULL) AND (public_changed_at IS NOT NULL)))),
    CONSTRAINT account_membership_time_check CHECK (isfinite(membership_time)),
    CONSTRAINT account_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0)),
    CONSTRAINT account_operator_relation_version_check CHECK ((operator_relation_version >= 0)),
    CONSTRAINT account_public_views_check CHECK (((jsonb_typeof(public_views) = 'object'::text) AND (public_views ?& ARRAY['posts'::text, 'reviews'::text, 'collections'::text, 'realms'::text]) AND ((public_views - ARRAY['posts'::text, 'reviews'::text, 'collections'::text, 'realms'::text]) = '{}'::jsonb) AND (jsonb_typeof((public_views -> 'posts'::text)) = 'boolean'::text) AND (jsonb_typeof((public_views -> 'reviews'::text)) = 'boolean'::text) AND (jsonb_typeof((public_views -> 'collections'::text)) = 'boolean'::text) AND (jsonb_typeof((public_views -> 'realms'::text)) = 'boolean'::text))),
    CONSTRAINT account_rate_tier_check CHECK ((rate_tier = ANY (ARRAY['ordinary'::text, 'trusted'::text, 'service'::text]))),
    CONSTRAINT account_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT account_service_tier_actor CHECK (((rate_tier <> 'service'::text) OR (kind = 'actor'::text))),
    CONSTRAINT account_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text, 'deleted'::text])))
);


--
-- Name: native_terminal_account_ready(access.account); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.native_terminal_account_ready(value access.account) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT value.state='deleted' AND value.authn_fenced
  AND value.account_id::text=current_setting('rezics.erasure_terminal',true)
  AND EXISTS (SELECT 1 FROM access.erasure e WHERE e.route=value.route AND e.account_id=value.account_id)
  AND EXISTS (SELECT 1 FROM access.erasure_native_progress p WHERE p.route=value.route AND p.account_id=value.account_id
    AND p.progress_id::text=current_setting('rezics.erasure_progress',true)
    -- Original terminal phase 61 runs only after all appended source phases.
    AND p.phase=74
    AND NOT EXISTS (SELECT 1 FROM access.erasure_native_blocked b WHERE b.progress_id=p.progress_id AND b.phase<>61));
$$;


--
-- Name: operator_fence_page_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.operator_fence_page_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Operator fence pages are immutable';
END;
$$;


--
-- Name: preserve_live_copy_domain(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.preserve_live_copy_domain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION 'Live copy domains require controlled native migration' USING ERRCODE='23514';
END; $$;


--
-- Name: preserve_live_copy_seal(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.preserve_live_copy_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND NOT OLD.sealed AND NEW.sealed
   AND (NEW.partition_no,NEW.account_id)=(OLD.partition_no,OLD.account_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy account seal is permanent' USING ERRCODE='23514';
END; $$;


--
-- Name: record_native_continuation_roles(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_native_continuation_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  root access.committed_continuation;
  artifact text;
  actor uuid;
BEGIN
  artifact := CASE TG_TABLE_NAME WHEN 'committed_continuation' THEN 'root'
    WHEN 'committed_continuation_entry' THEN 'entry'
    WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END;
  SELECT * INTO STRICT root FROM access.committed_continuation
    WHERE route=NEW.route AND continuation_id=NEW.continuation_id;
  INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
    SELECT NEW.route,id,artifact,NEW.erasure_row_id FROM unnest(ARRAY[root.account_id,root.prior_operator_account_id]) id
    WHERE id IS NOT NULL ON CONFLICT DO NOTHING;
  IF artifact IN ('entry','completion') THEN
    actor := access.erasure_entry_account(NEW.step,NEW.target);
    IF actor IS NOT NULL THEN
      INSERT INTO access.erasure_continuation_role VALUES(NEW.route,actor,artifact,NEW.erasure_row_id) ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    FOR actor IN SELECT access.erasure_entry_account(a->>'step',a->>'target')
      FROM jsonb_array_elements(NEW.allowlist) a LOOP
      IF actor IS NOT NULL THEN
        INSERT INTO access.erasure_continuation_role VALUES(NEW.route,actor,artifact,NEW.erasure_row_id) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: record_public_account_change(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_public_account_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND access.native_terminal_account_ready(OLD) THEN
    NEW.public_changed_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.public_changed_at := NEW.created_at;
  ELSIF ROW(NEW.account_id, NEW.kind, NEW.state, NEW.authn_fenced, NEW.avatar, NEW.public_views,
            NEW.speakers_listed, NEW.handle, NEW.display_name, NEW.avatar_url, NEW.biography,
            NEW.links, NEW.operator_account_id, NEW.agent_verified, NEW.agent_subject_id)
        IS DISTINCT FROM
        ROW(OLD.account_id, OLD.kind, OLD.state, OLD.authn_fenced, OLD.avatar, OLD.public_views,
            OLD.speakers_listed, OLD.handle, OLD.display_name, OLD.avatar_url, OLD.biography,
            OLD.links, OLD.operator_account_id, OLD.agent_verified, OLD.agent_subject_id) THEN
    NEW.public_changed_at := statement_timestamp();
  ELSE
    NEW.public_changed_at := OLD.public_changed_at;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: record_rating_controller(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_rating_controller() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    at := '-infinity';
  ELSIF NEW.operator_account_id IS NOT DISTINCT FROM OLD.operator_account_id THEN
    RETURN NEW;
  ELSE
    -- Native relation and deletion commands supply their authoritative T.
    -- Direct relation removal uses the database transaction time.
    at := COALESCE(NULLIF(current_setting('rezics.operator_at', true), '')::timestamptz,
                   transaction_timestamp());
  END IF;
  INSERT INTO access.rating_counter_controller (route, account_id, effective_at, controller_id)
  VALUES (NEW.route, NEW.account_id, at, COALESCE(NEW.operator_account_id, NEW.account_id))
  ON CONFLICT (route, account_id, effective_at) DO UPDATE SET controller_id = EXCLUDED.controller_id;
  RETURN NEW;
END;
$$;


--
-- Name: try_deliver_resource_role_provenance(integer, bigint); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.try_deliver_resource_role_provenance(p_route integer, p_occurrence bigint) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE source access.resource_role_provenance; enrolled record;
BEGIN
 SELECT * INTO source FROM access.lock_resource_role_provenance(p_route,p_occurrence);
 IF NOT FOUND THEN RETURN 'missing'; END IF;
 IF source.delivery<>'pending' THEN RETURN source.delivery; END IF;
 IF source.resource_type='semantic.context' THEN
   IF to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)') IS NULL THEN
     RETURN 'receiver-unavailable';
   END IF;
   -- At the original deferred trigger the executor has already written its genuine
   -- editorial basis. No setting or made-up Source commit substitutes for that basis.
   SELECT * INTO enrolled FROM semantic.enroll_context_role_provenance(
     source.route,source.occurrence,source.resource_id,source.original_creator,source.account_id,source.grant_role,
     source.valid::text,source.side,source.grant_transaction,source.source_transaction);
   IF NOT FOUND THEN RETURN 'pending'; END IF;
   IF enrolled.state='pending' THEN RETURN 'pending'; END IF;
   IF enrolled.state='enrolled' AND enrolled.context_key>0 THEN
     UPDATE access.resource_role_provenance SET delivery='delivered',context_key=enrolled.context_key
       WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
     RETURN 'delivered';
   ELSIF enrolled.state='not-applicable' THEN
     UPDATE access.resource_role_provenance SET delivery='not-applicable',context_key=NULL
       WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
     RETURN 'not-applicable';
   END IF;
   RAISE EXCEPTION 'Invalid native Context enrollment result' USING ERRCODE='23514';
 END IF;
 UPDATE access.resource_role_provenance SET delivery='not-applicable'
   WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
 RETURN 'not-applicable';
END; $$;


--
-- Name: validate_agent_identity_intent(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.validate_agent_identity_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.minimized OR NEW.requested_by IS NULL OR
       (NOT EXISTS (SELECT 1 FROM core.receipt r
          WHERE r.partition_no=NEW.source_partition AND r.principal_kind='account'
            AND r.principal_id=NEW.requested_by AND r.command_kind=NEW.native_command_kind
            AND r.idempotency_key=NEW.native_receipt_key
            AND r.transaction_id=NEW.source_transaction_id AND r.epoch=NEW.source_epoch
            AND r.position=NEW.source_position AND r.xmin::text=pg_current_xact_id()::text)
        AND NOT access.agent_identity_recovery_valid(NEW)) THEN
        RAISE EXCEPTION 'Account identity intent lacks original same-command native receipt or verified native recovery' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: validate_agent_identity_recovery(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.validate_agent_identity_recovery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i access.agent_identity_intent;
BEGIN
    SELECT * INTO i FROM access.agent_identity_intent
      WHERE (route,account_id,direction,receipt_id)=(NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id);
    IF NOT access.agent_identity_recovery_valid(i) THEN
        RAISE EXCEPTION 'Account identity recovery lacks genuine original and actual recovery custody' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: validate_identity_reversal_settlement(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.validate_identity_reversal_settlement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
 component jsonb;
 receiving jsonb;
 technical access.agent_identity_technical_source%ROWTYPE;
 idx integer;
BEGIN
 IF NEW.transaction_id::text IS DISTINCT FROM current_setting('access.identity_reversal_transaction',true)
  OR NOT EXISTS(SELECT 1 FROM core.receipt c JOIN core.outbox o
    ON (o.partition_no,o.epoch,o.position)=(c.partition_no,c.epoch,c.position)
   JOIN core.partition p ON p.partition_no=c.partition_no
   CROSS JOIN core.history_family_domain d
   WHERE c.partition_no=NEW.partition_no AND c.transaction_id=NEW.transaction_id
    AND c.command_kind='access.agent-verification.reversed' AND c.idempotency_key=NEW.native_receipt_key
    AND c.principal_kind='account' AND c.epoch=NEW.owner_epoch AND c.position=NEW.position
    AND c.xmin::text=pg_current_xact_id()::text AND o.xmin=c.xmin
    AND o.type='com.rezics.access.agent-verification.reversed.v1' AND o.event_seq=0
    AND o.subject=NEW.account_id::text
    AND o.data->>'receiptId'=NEW.reversal_receipt_id::text
    AND o.data->>'verificationReceiptId'=NEW.verification_receipt_id::text
    AND o.data->>'accountId'=NEW.account_id::text
    AND o.data->>'requestedBy'=c.principal_id::text
    AND p.epoch=NEW.owner_epoch AND p.position=NEW.position AND p.write_state='active'
    AND p.moved_to IS NULL AND d.singleton AND d.generation=NEW.domain_generation) THEN
  RAISE EXCEPTION 'Account reversal settlement lacks its original atomic terminal command' USING ERRCODE='23514';
 END IF;
 FOR idx IN 0..1 LOOP
  component := CASE WHEN idx=0 THEN NEW.verified ELSE NEW.reversed END;
  receiving := NEW.receivers->idx;
  SELECT * INTO technical FROM access.agent_identity_technical_source t
   WHERE t.route=NEW.route AND t.account_id=NEW.account_id
    AND t.direction=CASE WHEN idx=0 THEN 'account-agent.verify' ELSE 'account-agent.unverify' END
    AND t.receipt_id=CASE WHEN idx=0 THEN NEW.verification_receipt_id ELSE NEW.reversal_receipt_id END;
  IF NOT FOUND OR technical.source_digest IS DISTINCT FROM component->>'digest'
   OR jsonb_build_object('partition',technical.source_partition,'epoch',technical.source_epoch,
     'position',technical.source_position::text,'transactionId',technical.source_transaction_id)
       IS DISTINCT FROM component->'source'
   OR jsonb_build_object('partition',technical.source_partition,'epoch',technical.receiving_epoch,
     'position',technical.receiving_position::text,'transactionId',technical.receiving_transaction_id)
       IS DISTINCT FROM receiving
   OR technical.domain_generation<>NEW.domain_generation OR technical.receiving_epoch<>NEW.owner_epoch
   OR NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_receipt_binding b
    JOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key,generation)
    JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
    JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
     AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin AND c.xmin=k.xmin
    JOIN semantic.identity_epoch_native_commit u ON u.partition_no=b.partition_no
     AND u.transaction_id=b.consumer_undo_transaction_id AND u.purpose='admission'
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=n.epoch AND p.epoch=u.epoch
     AND p.position>=n.position AND p.position>=u.position AND p.write_state='active' AND p.moved_to IS NULL
    WHERE b.partition_no=NEW.partition_no AND c.receipt=component->'receipt'
     AND b.receipt_key='[' || to_json(component->'receipt'->>'kind')::text || ',' ||
      to_json(component->'receipt'->>'account')::text || ',' || to_json(component->'receipt'->>'receipt')::text || ']' 
     AND b.state='accepted' AND b.intent_digest=technical.source_digest AND c.intent_digest=b.intent_digest
     AND c.intent=technical.intent AND b.accepted_job=c.job_id AND b.accepted_epoch=c.job_epoch
     AND c.job_id=technical.accepted_job_id AND c.job_epoch=technical.accepted_job_epoch
     AND c.generation=technical.binding_generation AND k.transaction_id=technical.binding_transaction_id
     AND c.transaction_id=k.transaction_id AND p.epoch=technical.source_epoch
     AND jsonb_build_object('generation',c.generation::text,'transactionId',k.transaction_id,
       'home',c.job_home,'scope',c.scope_digest,'sources',c.sources,
       'job',jsonb_build_object('jobId',c.job_id,'epoch',c.job_epoch::text))=component->'binding'
     AND b.consumer_undo_generation::text=component->>'undoGeneration'
     AND NEW.domain_generation::text=component->>'restoreGeneration') THEN
   RAISE EXCEPTION 'Account reversal settlement lacks exact original accepted input/receiver' USING ERRCODE='23514';
  END IF;
 END LOOP;
 -- The independently accepted reversal names the verification's original accepted
 -- job as undo, never its own job. No caller flags or terminal-list inference.
 IF NOT EXISTS(SELECT 1 FROM access.agent_identity_technical_source r
  WHERE r.route=NEW.route AND r.account_id=NEW.account_id AND r.direction='account-agent.unverify'
   AND r.receipt_id=NEW.reversal_receipt_id AND r.intent->>'verificationReceipt'=NEW.verification_receipt_id::text
   AND r.intent->'undoJob'=NEW.verified->'binding'->'job'
   AND r.intent->'undoJob' IS DISTINCT FROM NEW.reversed->'binding'->'job') THEN
  RAISE EXCEPTION 'Account reversal settlement substituted the original undo job' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: validate_identity_technical_source(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.validate_identity_technical_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.receiving_transaction_id::text IS DISTINCT FROM current_setting('access.identity_technical_transaction',true)
  OR NOT EXISTS(SELECT 1 FROM core.outbox o JOIN core.partition p USING(partition_no)
    WHERE o.partition_no=NEW.source_partition AND o.epoch=NEW.receiving_epoch
      AND o.position=NEW.receiving_position AND o.event_seq=0
      AND o.xmin::text=pg_current_xact_id()::text
      AND p.epoch=o.epoch AND p.position=o.position AND p.write_state='active')
  OR NOT EXISTS(SELECT 1 FROM access.agent_identity_technical_role r
    WHERE (r.route,r.account_id,r.direction,r.receipt_id)=
      (NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id)
      AND r.role_account_id=NEW.account_id AND r.roles=32) THEN
  RAISE EXCEPTION 'Accounts technical custody lacks same-command native receiving fence/inventory' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: workflow_approval_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.workflow_approval_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.operation->>'kind' = 'credential' AND OLD.consumed_at IS NULL AND OLD.consumed_transaction_id IS NULL
    AND NEW.consumed_at IS NOT NULL AND NEW.consumed_transaction_id IS NOT NULL
    AND NEW.consumed_at >= OLD.created_at AND NEW.consumed_at < OLD.expires_at
    AND (to_jsonb(OLD) - 'consumed_at' - 'consumed_transaction_id') = (to_jsonb(NEW) - 'consumed_at' - 'consumed_transaction_id')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Workflow approvals are immutable';
END;
$$;


--
-- Name: account_discovery_claim_cursor; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account_discovery_claim_cursor (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    claim_partition integer NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT account_discovery_claim_cursor_claim_partition_check CHECK (((claim_partition >= 0) AND (claim_partition <= 4095))),
    CONSTRAINT account_discovery_claim_cursor_revision_check CHECK ((revision > 0))
);


--
-- Name: account_discovery_claim_intent; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account_discovery_claim_intent (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT account_discovery_claim_intent_revision_check CHECK ((revision > 0)),
    CONSTRAINT account_discovery_claim_intent_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: account_discovery_intent; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account_discovery_intent (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT account_discovery_intent_revision_check CHECK ((revision > 0)),
    CONSTRAINT account_discovery_intent_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: account_discovery_population; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account_discovery_population (
    partition_no integer NOT NULL,
    population bigint NOT NULL,
    revision bigint NOT NULL,
    claim_revision bigint NOT NULL,
    CONSTRAINT account_discovery_population_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT account_discovery_population_population_check CHECK ((population >= 0))
);


--
-- Name: account_discovery_revision; Type: SEQUENCE; Schema: access; Owner: -
--

CREATE SEQUENCE access.account_discovery_revision
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_preferences; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account_preferences (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    spoiler_level integer NOT NULL,
    suitability text NOT NULL,
    version integer NOT NULL,
    shelf jsonb DEFAULT '{}'::jsonb NOT NULL,
    notifications jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT account_preferences_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_preferences_notifications_check CHECK (((jsonb_typeof(notifications) = 'object'::text) AND (octet_length((notifications)::text) <= 2048))),
    CONSTRAINT account_preferences_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT account_preferences_shelf_check CHECK (((jsonb_typeof(shelf) = 'object'::text) AND (octet_length((shelf)::text) <= 16384))),
    CONSTRAINT account_preferences_spoiler_level_check CHECK (((spoiler_level >= 0) AND (spoiler_level <= 2))),
    CONSTRAINT account_preferences_suitability_check CHECK ((suitability = ANY (ARRAY['blur'::text, 'show'::text]))),
    CONSTRAINT account_preferences_version_check CHECK ((version > 0))
);


--
-- Name: agent_identity_recovery; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_identity_recovery (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL,
    receipt_id uuid NOT NULL,
    requested_by uuid,
    decided_by uuid,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    intent_digest text NOT NULL,
    verification_intent_digest text,
    recovery_transaction_id uuid NOT NULL,
    recovery_epoch integer NOT NULL,
    recovery_position bigint NOT NULL,
    recovery_receipt_key text NOT NULL,
    original_source jsonb,
    recovery_digest text,
    original_source_minimized boolean DEFAULT false NOT NULL,
    CONSTRAINT agent_identity_recovery_check CHECK ((source_partition = (route / 16))),
    CONSTRAINT agent_identity_recovery_check1 CHECK (((direction <> 'account-agent.unverify'::text) OR (source_transaction_id = receipt_id))),
    CONSTRAINT agent_identity_recovery_check2 CHECK ((recovery_transaction_id <> source_transaction_id)),
    CONSTRAINT agent_identity_recovery_check3 CHECK ((recovery_epoch = source_epoch)),
    CONSTRAINT agent_identity_recovery_check4 CHECK ((recovery_position > source_position)),
    CONSTRAINT agent_identity_recovery_check5 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT agent_identity_recovery_check6 CHECK (((original_source IS NOT NULL) OR ((direction = 'account-agent.unverify'::text) AND (verification_intent_digest IS NOT NULL) AND (recovery_digest IS NULL)))),
    CONSTRAINT agent_identity_recovery_check7 CHECK (((original_source IS NULL) = (recovery_digest IS NULL))),
    CONSTRAINT agent_identity_recovery_direction_check CHECK ((direction = ANY (ARRAY['account-agent.verify'::text, 'account-agent.unverify'::text]))),
    CONSTRAINT agent_identity_recovery_intent_digest_check CHECK ((intent_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_recovery_recovery_digest_check CHECK ((recovery_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_recovery_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT agent_identity_recovery_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT agent_identity_recovery_verification_intent_digest_check CHECK ((verification_intent_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: agent_identity_reversal_settlement; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_identity_reversal_settlement (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reversal_receipt_id uuid NOT NULL,
    verification_receipt_id uuid CONSTRAINT agent_identity_reversal_settle_verification_receipt_id_not_null NOT NULL,
    verified jsonb NOT NULL,
    reversed jsonb NOT NULL,
    receivers jsonb NOT NULL,
    partition_no integer NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    domain_generation bigint NOT NULL,
    transaction_id uuid NOT NULL,
    native_receipt_key text NOT NULL,
    CONSTRAINT agent_identity_reversal_settlement_check CHECK ((partition_no = (route / 16))),
    CONSTRAINT agent_identity_reversal_settlement_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT agent_identity_reversal_settlement_check2 CHECK ((reversal_receipt_id <> verification_receipt_id)),
    CONSTRAINT agent_identity_reversal_settlement_check3 CHECK (((verified -> 'receipt'::text) = jsonb_build_object('kind', 'account-agent.verify', 'account', account_id, 'receipt', verification_receipt_id))),
    CONSTRAINT agent_identity_reversal_settlement_check4 CHECK (((reversed -> 'receipt'::text) = jsonb_build_object('kind', 'account-agent.unverify', 'account', account_id, 'receipt', reversal_receipt_id))),
    CONSTRAINT agent_identity_reversal_settlement_domain_generation_check CHECK ((domain_generation > 0)),
    CONSTRAINT agent_identity_reversal_settlement_native_receipt_key_check CHECK ((octet_length(native_receipt_key) <= 255)),
    CONSTRAINT agent_identity_reversal_settlement_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT agent_identity_reversal_settlement_position_check CHECK (("position" > 0)),
    CONSTRAINT agent_identity_reversal_settlement_receivers_check CHECK (((jsonb_typeof(receivers) = 'array'::text) AND (jsonb_array_length(receivers) = 2) AND (octet_length((receivers)::text) <= 1024))),
    CONSTRAINT agent_identity_reversal_settlement_reversed_check CHECK (((jsonb_typeof(reversed) = 'object'::text) AND (octet_length((reversed)::text) <= 8192))),
    CONSTRAINT agent_identity_reversal_settlement_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT agent_identity_reversal_settlement_verified_check CHECK (((jsonb_typeof(verified) = 'object'::text) AND (octet_length((verified)::text) <= 8192)))
);


--
-- Name: agent_identity_technical_role; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_identity_technical_role (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL,
    receipt_id uuid NOT NULL,
    role_account_id uuid NOT NULL,
    roles integer NOT NULL,
    CONSTRAINT agent_identity_technical_role_roles_check CHECK (((roles >= 1) AND (roles <= 262143))),
    CONSTRAINT identity_technical_retained_subject CHECK (((role_account_id = account_id) AND (roles = 32)))
);


--
-- Name: agent_identity_technical_source; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_identity_technical_source (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL,
    receipt_id uuid NOT NULL,
    intent jsonb NOT NULL,
    source_digest text NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    accepted_job_id uuid NOT NULL,
    accepted_job_epoch bigint NOT NULL,
    binding_generation bigint NOT NULL,
    binding_transaction_id uuid NOT NULL,
    workflow_id text NOT NULL,
    receiving_transaction_id uuid CONSTRAINT agent_identity_technical_sour_receiving_transaction_id_not_null NOT NULL,
    receiving_epoch integer NOT NULL,
    domain_generation bigint NOT NULL,
    receiving_position bigint NOT NULL,
    CONSTRAINT agent_identity_technical_source_accepted_job_epoch_check CHECK ((accepted_job_epoch > 0)),
    CONSTRAINT agent_identity_technical_source_binding_generation_check CHECK ((binding_generation > 0)),
    CONSTRAINT agent_identity_technical_source_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT agent_identity_technical_source_check1 CHECK ((source_partition = (route / 16))),
    CONSTRAINT agent_identity_technical_source_check2 CHECK ((receiving_transaction_id <> source_transaction_id)),
    CONSTRAINT agent_identity_technical_source_check3 CHECK ((((direction = 'account-agent.verify'::text) AND ((intent ->> 'kind'::text) = 'merge'::text) AND (intent ?& ARRAY['kind'::text, 'redirected'::text, 'survivor'::text, 'release'::text]) AND ((intent - ARRAY['kind'::text, 'redirected'::text, 'survivor'::text, 'release'::text]) = '{}'::jsonb)) OR ((direction = 'account-agent.unverify'::text) AND ((intent ->> 'kind'::text) = 'unmerge'::text) AND (intent ?& ARRAY['kind'::text, 'original'::text, 'undoJob'::text, 'verificationReceipt'::text, 'release'::text]) AND ((intent - ARRAY['kind'::text, 'original'::text, 'undoJob'::text, 'verificationReceipt'::text, 'release'::text]) = '{}'::jsonb) AND ((intent -> 'undoJob'::text) ?& ARRAY['jobId'::text, 'epoch'::text]) AND (((intent -> 'undoJob'::text) - ARRAY['jobId'::text, 'epoch'::text]) = '{}'::jsonb)))),
    CONSTRAINT agent_identity_technical_source_direction_check CHECK ((direction = ANY (ARRAY['account-agent.verify'::text, 'account-agent.unverify'::text]))),
    CONSTRAINT agent_identity_technical_source_domain_generation_check CHECK ((domain_generation > 0)),
    CONSTRAINT agent_identity_technical_source_intent_check CHECK ((octet_length((intent)::text) <= 2048)),
    CONSTRAINT agent_identity_technical_source_receiving_epoch_check CHECK ((receiving_epoch > 0)),
    CONSTRAINT agent_identity_technical_source_receiving_position_check CHECK ((receiving_position > 0)),
    CONSTRAINT agent_identity_technical_source_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT agent_identity_technical_source_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_technical_source_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT agent_identity_technical_source_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT agent_identity_technical_source_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: agent_page; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_page (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    account_id uuid NOT NULL,
    verification_receipt_id uuid NOT NULL,
    CONSTRAINT agent_page_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: agent_verification_request; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_verification_request (
    route integer NOT NULL,
    request_id uuid NOT NULL,
    account_id uuid NOT NULL,
    account_kind text NOT NULL,
    requested_by uuid,
    catalogue_subject_id uuid NOT NULL,
    statement text NOT NULL,
    links jsonb DEFAULT '[]'::jsonb NOT NULL,
    state text NOT NULL,
    reason text,
    problem_type text,
    problem_detail text,
    decision_receipt_id uuid,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT agent_verification_request_account_kind_check CHECK ((account_kind = ANY (ARRAY['actor'::text, 'organization'::text]))),
    CONSTRAINT agent_verification_request_check CHECK ((route = ((get_byte(uuid_send(request_id), 10) * 256) + get_byte(uuid_send(request_id), 11)))),
    CONSTRAINT agent_verification_request_check1 CHECK (((state = ANY (ARRAY['approving'::text, 'approved'::text, 'rejected'::text, 'failed'::text])) = (decision_receipt_id IS NOT NULL))),
    CONSTRAINT agent_verification_request_check3 CHECK (((problem_type IS NULL) = (problem_detail IS NULL))),
    CONSTRAINT agent_verification_request_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT agent_verification_request_links_check CHECK (((jsonb_typeof(links) = 'array'::text) AND (jsonb_array_length(links) <= 5))),
    CONSTRAINT agent_verification_request_problem_detail_check CHECK (((problem_detail IS NULL) OR (char_length(problem_detail) <= 512))),
    CONSTRAINT agent_verification_request_problem_type_check CHECK (((problem_type IS NULL) OR ((char_length(problem_type) >= 1) AND (char_length(problem_type) <= 128)))),
    CONSTRAINT agent_verification_request_reason_check CHECK (((reason IS NULL) OR (char_length(reason) <= 500))),
    CONSTRAINT agent_verification_request_route_check CHECK ((route = 0)),
    CONSTRAINT agent_verification_request_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approving'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text, 'failed'::text]))),
    CONSTRAINT agent_verification_request_statement_check CHECK (((char_length(statement) >= 1) AND (char_length(statement) <= 2000))),
    CONSTRAINT agent_verification_request_updated_at_check CHECK (isfinite(updated_at))
);


--
-- Name: auth_erasure_cut; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_cut (
    cut_id uuid NOT NULL,
    participant text DEFAULT 'auth'::text NOT NULL,
    inventory_version integer DEFAULT 1 NOT NULL,
    producer_version integer DEFAULT 1 NOT NULL,
    sealed_partitions integer DEFAULT 0 NOT NULL,
    CONSTRAINT auth_erasure_cut_inventory_version_check CHECK ((inventory_version = 1)),
    CONSTRAINT auth_erasure_cut_participant_check CHECK ((participant = 'auth'::text)),
    CONSTRAINT auth_erasure_cut_producer_version_check CHECK ((producer_version = 1)),
    CONSTRAINT auth_erasure_cut_sealed_partitions_check CHECK (((sealed_partitions >= 0) AND (sealed_partitions <= 4096)))
);


--
-- Name: auth_erasure_cut_partition; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_cut_partition (
    cut_id uuid NOT NULL,
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_owner text NOT NULL,
    source_position bigint NOT NULL,
    high_water bigint NOT NULL,
    CONSTRAINT auth_erasure_cut_partition_high_water_check CHECK ((high_water >= 0)),
    CONSTRAINT auth_erasure_cut_partition_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: auth_erasure_live_partition; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_live_partition (
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_owner text NOT NULL,
    enrollment_floor bigint NOT NULL,
    enrolled_through bigint NOT NULL,
    lineage_valid boolean DEFAULT true NOT NULL,
    CONSTRAINT auth_erasure_live_partition_check CHECK ((enrolled_through >= enrollment_floor)),
    CONSTRAINT auth_erasure_live_partition_enrollment_floor_check CHECK ((enrollment_floor >= 0))
);


--
-- Name: auth_erasure_live_receiver; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_live_receiver (
    cut_id uuid NOT NULL,
    auth_generation text NOT NULL,
    database_identity text NOT NULL,
    inventory_entry text NOT NULL,
    inventory_version text NOT NULL,
    CONSTRAINT auth_erasure_live_receiver_auth_generation_check CHECK (((octet_length(auth_generation) >= 1) AND (octet_length(auth_generation) <= 1024))),
    CONSTRAINT auth_erasure_live_receiver_database_identity_check CHECK (((octet_length(database_identity) >= 1) AND (octet_length(database_identity) <= 1024))),
    CONSTRAINT auth_erasure_live_receiver_inventory_entry_check CHECK (((octet_length(inventory_entry) >= 1) AND (octet_length(inventory_entry) <= 1024))),
    CONSTRAINT auth_erasure_live_receiver_inventory_version_check CHECK (((octet_length(inventory_version) >= 1) AND (octet_length(inventory_version) <= 1024)))
);


--
-- Name: auth_erasure_live_subscription; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_live_subscription (
    cut_id uuid NOT NULL,
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_owner text NOT NULL,
    high_water bigint NOT NULL,
    arm_high_water bigint NOT NULL,
    CONSTRAINT auth_erasure_live_subscription_check CHECK ((arm_high_water >= high_water)),
    CONSTRAINT auth_erasure_live_subscription_high_water_check CHECK ((high_water >= 0))
);


--
-- Name: auth_erasure_obligation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_erasure_obligation (
    partition_no integer NOT NULL,
    ordinal bigint NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    minimum_authn_epoch bigint,
    receipt_id uuid,
    CONSTRAINT auth_erasure_obligation_check CHECK ((partition_no = (route / 16))),
    CONSTRAINT auth_erasure_obligation_check1 CHECK (((minimum_authn_epoch IS NULL) = (receipt_id IS NULL))),
    CONSTRAINT auth_erasure_obligation_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0)),
    CONSTRAINT auth_erasure_obligation_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT auth_erasure_obligation_version_check CHECK ((version > 0))
);


--
-- Name: auth_history_proof; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_history_proof (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    phase text NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    continuation_id uuid,
    receipt_id uuid,
    CONSTRAINT auth_history_proof_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT auth_history_proof_check1 CHECK ((((phase = 'native-consumed'::text) AND (continuation_id IS NOT NULL) AND (receipt_id IS NOT NULL)) OR ((phase = 'copies-erased'::text) AND (continuation_id IS NULL) AND (receipt_id IS NULL)))),
    CONSTRAINT auth_history_proof_phase_check CHECK ((phase = ANY (ARRAY['native-consumed'::text, 'copies-erased'::text]))),
    CONSTRAINT auth_history_proof_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT auth_history_proof_version_check CHECK ((version > 0))
);


--
-- Name: auth_receiving_closure; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_receiving_closure (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    control_revision bigint NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    native_obligation_id bigint NOT NULL,
    closure_receipt_id uuid NOT NULL,
    physical_closure text NOT NULL,
    receiving_closure text NOT NULL,
    published_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    continuation_id uuid,
    source_receipt_id uuid,
    CONSTRAINT auth_receiving_closure_native_obligation_id_check CHECK ((native_obligation_id > 0)),
    CONSTRAINT auth_receiving_closure_source_pair CHECK ((((continuation_id IS NULL) AND (source_receipt_id IS NULL)) OR ((continuation_id IS NOT NULL) AND (source_receipt_id IS NOT NULL))))
);


--
-- Name: auth_receiving_control; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_receiving_control (
    partition_no integer NOT NULL,
    source_generation uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_owner text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    state text DEFAULT 'owner-unavailable'::text NOT NULL,
    requested_restore text,
    database_identity text,
    receiving_incarnation text,
    restore_generation text,
    owner_installation text,
    writer_fence text,
    CONSTRAINT auth_receiving_control_check CHECK (((state <> 'active'::text) OR ((database_identity IS NOT NULL) AND (receiving_incarnation IS NOT NULL) AND (restore_generation IS NOT NULL) AND (owner_installation IS NOT NULL) AND (writer_fence IS NOT NULL) AND ((requested_restore IS NULL) OR (requested_restore = restore_generation))))),
    CONSTRAINT auth_receiving_control_database_identity_check CHECK (((octet_length(database_identity) >= 1) AND (octet_length(database_identity) <= 256))),
    CONSTRAINT auth_receiving_control_owner_installation_check CHECK (((octet_length(owner_installation) >= 1) AND (octet_length(owner_installation) <= 256))),
    CONSTRAINT auth_receiving_control_receiving_incarnation_check CHECK (((octet_length(receiving_incarnation) >= 1) AND (octet_length(receiving_incarnation) <= 256))),
    CONSTRAINT auth_receiving_control_requested_restore_check CHECK (((octet_length(requested_restore) >= 1) AND (octet_length(requested_restore) <= 1024))),
    CONSTRAINT auth_receiving_control_restore_generation_check CHECK (((octet_length(restore_generation) >= 1) AND (octet_length(restore_generation) <= 256))),
    CONSTRAINT auth_receiving_control_revision_check CHECK ((revision > 0)),
    CONSTRAINT auth_receiving_control_state_check CHECK ((state = ANY (ARRAY['owner-unavailable'::text, 'active'::text, 'quarantined'::text]))),
    CONSTRAINT auth_receiving_control_writer_fence_check CHECK (((octet_length(writer_fence) >= 1) AND (octet_length(writer_fence) <= 256)))
);


--
-- Name: auth_receiving_obligation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_receiving_obligation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    partition_no integer NOT NULL,
    custody_revision bigint,
    physical_closure text,
    receiving_closure text,
    CONSTRAINT auth_receiving_custody_complete CHECK ((((custody_revision IS NULL) AND (physical_closure IS NULL) AND (receiving_closure IS NULL)) OR ((custody_revision IS NOT NULL) AND (custody_revision > 0) AND (physical_closure IS NOT NULL) AND (receiving_closure IS NOT NULL)))),
    CONSTRAINT auth_receiving_obligation_check CHECK ((partition_no = (route / 16))),
    CONSTRAINT auth_receiving_obligation_check1 CHECK ((((custody_revision IS NULL) AND (physical_closure IS NULL) AND (receiving_closure IS NULL)) OR ((custody_revision > 0) AND (physical_closure IS NOT NULL) AND (receiving_closure IS NOT NULL)))),
    CONSTRAINT auth_receiving_obligation_physical_closure_check CHECK (((octet_length(physical_closure) >= 1) AND (octet_length(physical_closure) <= 256))),
    CONSTRAINT auth_receiving_obligation_receiving_closure_check CHECK (((octet_length(receiving_closure) >= 1) AND (octet_length(receiving_closure) <= 256))),
    CONSTRAINT auth_receiving_obligation_version_check CHECK ((version > 0))
);


--
-- Name: committed_continuation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.committed_continuation (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    operation_key text NOT NULL,
    operation_digest text NOT NULL,
    command_key_prefix text NOT NULL,
    barrier_receipt_id uuid NOT NULL,
    barrier_transaction_id uuid NOT NULL,
    minimum_authn_epoch bigint NOT NULL,
    prior_handle text,
    prior_operator_account_id uuid,
    prior_reservation_id uuid,
    allowlist jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    committed_expires_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completions jsonb DEFAULT '[]'::jsonb NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT committed_continuation_allowlist_check CHECK (access.committed_continuation_entries(allowlist, 1, 4, false)),
    CONSTRAINT committed_continuation_check CHECK ((route = ((get_byte(uuid_send(continuation_id), 10) * 256) + get_byte(uuid_send(continuation_id), 11)))),
    CONSTRAINT committed_continuation_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT committed_continuation_check2 CHECK ((((prior_operator_account_id IS NULL) AND (prior_reservation_id IS NULL)) OR ((prior_operator_account_id IS NOT NULL) AND (prior_reservation_id IS NOT NULL)))),
    CONSTRAINT committed_continuation_check4 CHECK ((expires_at >= committed_expires_at)),
    CONSTRAINT committed_continuation_command_key_prefix_check CHECK ((command_key_prefix ~ '^wf:[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_completions_check CHECK (access.committed_continuation_entries(completions, 0, 4, true)),
    CONSTRAINT committed_continuation_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_lifetime_check CHECK (((committed_expires_at > created_at) AND (committed_expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT committed_continuation_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0)),
    CONSTRAINT committed_continuation_operation_digest_check CHECK ((operation_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 128))),
    CONSTRAINT committed_continuation_prior_handle_check CHECK (((prior_handle IS NULL) OR (prior_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text))),
    CONSTRAINT committed_continuation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: committed_continuation_completion; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.committed_continuation_completion (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    step text NOT NULL,
    target text NOT NULL,
    key text NOT NULL,
    digest text NOT NULL,
    receipt_id uuid NOT NULL,
    receipt_key text,
    receipt_digest text,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT committed_continuation_business_receipt_check CHECK (((receipt_key IS NULL) = (receipt_digest IS NULL))),
    CONSTRAINT committed_continuation_completion_check CHECK ((route = ((get_byte(uuid_send(continuation_id), 10) * 256) + get_byte(uuid_send(continuation_id), 11)))),
    CONSTRAINT committed_continuation_completion_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_completion_key_check CHECK (((length(key) >= 1) AND (length(key) <= 240))),
    CONSTRAINT committed_continuation_completion_receipt_digest_check CHECK ((receipt_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_completion_receipt_key_check CHECK (((length(receipt_key) >= 1) AND (length(receipt_key) <= 256))),
    CONSTRAINT committed_continuation_completion_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT committed_continuation_completion_step_check CHECK ((step ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT committed_continuation_completion_target_check CHECK (((length(target) >= 1) AND (length(target) <= 128)))
);


--
-- Name: committed_continuation_entry; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.committed_continuation_entry (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    step text NOT NULL,
    target text NOT NULL,
    key text NOT NULL,
    digest text NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT committed_continuation_entry_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_entry_key_check CHECK (((length(key) >= 1) AND (length(key) <= 240))),
    CONSTRAINT committed_continuation_entry_step_check CHECK ((step ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT committed_continuation_entry_target_check CHECK (((length(target) >= 1) AND (length(target) <= 128)))
);


--
-- Name: credential_floor_receipt; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.credential_floor_receipt (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    opening_receipt_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    operation_key text NOT NULL,
    effect_reference text NOT NULL,
    effect_digest text NOT NULL,
    purpose text NOT NULL,
    previous_floor bigint NOT NULL,
    minimum_authn_epoch bigint NOT NULL,
    fenced boolean NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT credential_floor_receipt_check CHECK ((minimum_authn_epoch = (previous_floor + 1))),
    CONSTRAINT credential_floor_receipt_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT credential_floor_receipt_previous_floor_check CHECK ((previous_floor > 0)),
    CONSTRAINT credential_floor_receipt_purpose_check CHECK ((purpose = ANY (ARRAY['set-password'::text, 'remove-password'::text, 'remove-key'::text, 'remove-passkey'::text])))
);


--
-- Name: current_resource_role_due; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.current_resource_role_due (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    interval_key bigint NOT NULL
);


--
-- Name: current_resource_role_frontier; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.current_resource_role_frontier (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    processed_at timestamp with time zone NOT NULL
);


--
-- Name: current_resource_role_install; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.current_resource_role_install (
    singleton boolean DEFAULT true NOT NULL,
    cut bigint NOT NULL,
    after_key bigint DEFAULT 0 NOT NULL,
    initialized_at timestamp with time zone NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT current_resource_role_install_singleton_check CHECK (singleton)
);


--
-- Name: current_resource_role_key; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.current_resource_role_key (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    grant_role text NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text NOT NULL,
    interval_key bigint NOT NULL
);


--
-- Name: erasure; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    frontier jsonb,
    workflow_until bigint,
    auth_obligation_indexed boolean DEFAULT false NOT NULL,
    CONSTRAINT erasure_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT erasure_check1 CHECK (((completed_at IS NULL) OR (completed_at >= at))),
    CONSTRAINT erasure_frontier_check CHECK (((frontier IS NULL) OR (jsonb_typeof(frontier) = 'array'::text))),
    CONSTRAINT erasure_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT erasure_version_check CHECK ((version > 0))
);


--
-- Name: erasure_acknowledgement; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_acknowledgement (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    participant text NOT NULL,
    outcome text NOT NULL,
    retained jsonb DEFAULT '[]'::jsonb NOT NULL,
    resolutions jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT erasure_acknowledgement_outcome_check CHECK ((outcome = ANY (ARRAY['erased'::text, 'none'::text]))),
    CONSTRAINT erasure_acknowledgement_participant_check CHECK (((length(participant) >= 1) AND (length(participant) <= 64))),
    CONSTRAINT erasure_acknowledgement_resolutions_check CHECK ((jsonb_typeof(resolutions) = 'object'::text)),
    CONSTRAINT erasure_acknowledgement_retained_check CHECK (((jsonb_typeof(retained) = 'array'::text) AND (jsonb_array_length(retained) <= 16) AND ((outcome = 'erased'::text) OR (retained = '[]'::jsonb))))
);


--
-- Name: erasure_continuation_role; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_continuation_role (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    artifact text NOT NULL,
    row_id uuid NOT NULL,
    CONSTRAINT erasure_continuation_role_artifact_check CHECK ((artifact = ANY (ARRAY['root'::text, 'entry'::text, 'completion'::text, 'page'::text]))),
    CONSTRAINT erasure_continuation_role_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: erasure_late_item; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_late_item (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    participant text NOT NULL,
    locator text NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT erasure_late_item_locator_check CHECK (((locator COLLATE "C") ~ '^[ -~]{1,255}$'::text))
);


--
-- Name: erasure_locator_work; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_locator_work (
    workflow_id text NOT NULL,
    effect text NOT NULL,
    opened_at bigint NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    resolution_transaction_id uuid,
    CONSTRAINT erasure_locator_work_check CHECK (((state = 'resolved'::text) = (resolution_transaction_id IS NOT NULL))),
    CONSTRAINT erasure_locator_work_state_check CHECK ((state = ANY (ARRAY['open'::text, 'done'::text, 'resolved'::text])))
);


--
-- Name: erasure_native_blocked; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_blocked (
    progress_id uuid NOT NULL,
    phase integer NOT NULL,
    page integer NOT NULL,
    consumer_index integer DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    CONSTRAINT erasure_native_blocked_consumer_index_check CHECK (((consumer_index >= 0) AND (consumer_index < 100))),
    CONSTRAINT erasure_native_blocked_page_check CHECK ((page >= 0)),
    CONSTRAINT erasure_native_blocked_phase_check CHECK ((phase >= 0)),
    CONSTRAINT erasure_native_blocked_reason_check CHECK ((reason = ANY (ARRAY['handle-consumer'::text, 'membership-terminal-consumer'::text, 'organization-close-consumer'::text, 'verification-decision-consumer'::text, 'verification-reversal-consumer'::text, 'controller-transition-consumer'::text, 'rating-controller-projection-custody'::text, 'organization-cursor-cutover'::text, 'rate-binding-deployment-coverage'::text, 'auth-fence-release-witness-unavailable'::text, 'continuation-barrier-consumer'::text, 'deletion-local-consumer'::text, 'native-terminal-consumer'::text, 'approval-consumer-proof-unavailable'::text, 'opening-consumer-proof-unavailable'::text, 'credential-consumer-proof-unavailable'::text, 'continuation-child-consumer'::text, 'operator-page-consumer'::text, 'terminal-inventory'::text, 'account-discovery-consumer'::text, 'verification-source-custody'::text, 'realm-succession-source-custody'::text])))
);


--
-- Name: erasure_native_consumed_child; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_consumed_child (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    artifact text NOT NULL,
    entry_key bytea NOT NULL,
    progress_id uuid NOT NULL,
    CONSTRAINT erasure_native_consumed_child_artifact_check CHECK ((artifact = ANY (ARRAY['entry'::text, 'completion'::text, 'page'::text]))),
    CONSTRAINT erasure_native_consumed_child_entry_key_check CHECK ((octet_length(entry_key) = 32))
);


--
-- Name: erasure_native_coverage; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_coverage (
    name text NOT NULL,
    covered boolean NOT NULL,
    CONSTRAINT erasure_native_coverage_name_check CHECK ((name = 'rate-account-binding'::text))
);


--
-- Name: erasure_native_progress; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    progress_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    phase integer DEFAULT 0 NOT NULL,
    page integer DEFAULT 0 NOT NULL,
    pending text,
    retry_phase integer DEFAULT '-1'::integer NOT NULL,
    native_complete_at timestamp with time zone,
    CONSTRAINT erasure_native_progress_page_check CHECK ((page >= 0)),
    CONSTRAINT erasure_native_progress_pending_check CHECK ((pending = ANY (ARRAY['handle-consumer'::text, 'native-inventory'::text, 'shared-history-producer'::text]))),
    CONSTRAINT erasure_native_progress_phase_check CHECK ((phase >= 0)),
    CONSTRAINT erasure_native_progress_retry_phase_check CHECK ((retry_phase >= '-1'::integer)),
    CONSTRAINT erasure_native_progress_version_check CHECK ((version = 1))
);


--
-- Name: erasure_progress; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    store text NOT NULL,
    role text NOT NULL,
    partition_no integer NOT NULL,
    cursor text[],
    state text DEFAULT 'discovering'::text NOT NULL,
    last_page integer DEFAULT '-1'::integer NOT NULL,
    result jsonb,
    CONSTRAINT erasure_progress_last_page_check CHECK ((last_page >= '-1'::integer)),
    CONSTRAINT erasure_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT erasure_progress_result_check CHECK ((octet_length((result)::text) <= 65536)),
    CONSTRAINT erasure_progress_state_check CHECK ((state = ANY (ARRAY['discovering'::text, 'discovered'::text])))
);


--
-- Name: exposure_opening; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.exposure_opening (
    "group" text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    route integer DEFAULT 0 NOT NULL,
    CONSTRAINT exposure_opening_group_check CHECK (("group" ~ '^[a-z][a-z_-]{0,62}$'::text)),
    CONSTRAINT exposure_opening_route_check CHECK ((route = 0)),
    CONSTRAINT exposure_opening_valid_check CHECK (((NOT isempty(valid)) AND (NOT lower_inf(valid)) AND lower_inc(valid) AND (NOT upper_inc(valid))))
);


--
-- Name: governance_bootstrap; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.governance_bootstrap (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    account_id uuid,
    transaction_id uuid,
    CONSTRAINT governance_bootstrap_attribution_check CHECK (((account_id IS NULL) = (transaction_id IS NULL))),
    CONSTRAINT governance_bootstrap_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT governance_bootstrap_resource_id_check CHECK ((resource_id = '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT governance_bootstrap_route_check CHECK ((route = 0))
);


--
-- Name: governance_reach; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.governance_reach (
    route integer NOT NULL,
    transaction_id uuid NOT NULL,
    action text NOT NULL,
    resource_id uuid NOT NULL,
    actor_account_id uuid NOT NULL,
    CONSTRAINT governance_reach_action_check CHECK ((action = ANY (ARRAY['moderation:takedown'::text, 'moderation:read_reports'::text, 'post:erase'::text, 'media:erase'::text, 'access:grant'::text]))),
    CONSTRAINT governance_reach_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT governance_reach_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: handle_claim; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.handle_claim (
    route integer NOT NULL,
    normalized_handle text NOT NULL COLLATE pg_catalog."C",
    account_id uuid,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    transaction_id uuid,
    reservation_id uuid,
    hold_operation_id text,
    hold_expected_handle text,
    former_until timestamp with time zone,
    discovery_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT handle_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 1)))),
    CONSTRAINT handle_claim_disposition CHECK ((((state = 'retired'::text) AND (account_id IS NULL) AND (transaction_id IS NULL) AND (expires_at IS NULL) AND (reserved_until IS NULL) AND (reservation_id IS NULL) AND (hold_operation_id IS NULL) AND (hold_expected_handle IS NULL) AND (former_until IS NULL)) OR ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])) AND (account_id IS NOT NULL) AND (transaction_id IS NOT NULL) AND (((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))))),
    CONSTRAINT handle_claim_former_until_check CHECK (((former_until IS NULL) OR (state = ANY (ARRAY['pending'::text, 'reserved'::text])))),
    CONSTRAINT handle_claim_normalized_handle_check CHECK ((normalized_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT handle_claim_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: lifecycle_coordination; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_coordination (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    related_account_id uuid NOT NULL,
    purpose text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_coordination_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT lifecycle_coordination_purpose_check CHECK ((purpose = ANY (ARRAY['membership'::text, 'operator'::text, 'live-copy'::text])))
);


--
-- Name: lifecycle_fence_receipt; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_fence_receipt (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    minimum_authn_epoch bigint NOT NULL,
    kind text NOT NULL,
    prior_operator_account_id uuid,
    transaction_id uuid NOT NULL,
    operator_account_id uuid,
    operator_reservation_id uuid,
    operator_continuation_id uuid,
    CONSTRAINT lifecycle_fence_operator_origin CHECK ((((operator_account_id IS NULL) AND (operator_reservation_id IS NULL) AND (operator_continuation_id IS NULL)) OR ((operator_account_id IS NOT NULL) AND (operator_reservation_id IS NOT NULL) AND (operator_continuation_id IS NOT NULL)))),
    CONSTRAINT lifecycle_fence_receipt_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT lifecycle_fence_receipt_kind_check CHECK ((kind = ANY (ARRAY['fence'::text, 'tombstone'::text]))),
    CONSTRAINT lifecycle_fence_receipt_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0))
);


--
-- Name: lifecycle_handle_effect; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_handle_effect (
    route integer NOT NULL,
    normalized_handle text NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    operation_id text NOT NULL,
    effect text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_handle_effect_effect_check CHECK ((effect = ANY (ARRAY['active'::text, 'reserved'::text])))
);


--
-- Name: lifecycle_handle_operation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_handle_operation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    operation_id text NOT NULL,
    handle text NOT NULL,
    reservation_id uuid NOT NULL,
    expected_handle text,
    old_reservation_id uuid,
    state text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_handle_operation_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT lifecycle_handle_operation_state_check CHECK ((state = ANY (ARRAY['published'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: lifecycle_membership_slot; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_membership_slot (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    member_account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    terminal boolean DEFAULT false NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT lifecycle_membership_slot_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11))))
);


--
-- Name: lifecycle_registration_expiry; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_registration_expiry (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    handle text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_registration_expiry_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))))
);


--
-- Name: live_copy_bootstrap; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_bootstrap (
    partition_no integer NOT NULL,
    after_route integer NOT NULL,
    after_subject uuid NOT NULL,
    after_collection uuid NOT NULL,
    covered boolean DEFAULT false NOT NULL,
    sales_after_route integer NOT NULL,
    sales_after_creator uuid NOT NULL,
    sales_after_order uuid NOT NULL,
    sales_covered boolean DEFAULT false NOT NULL,
    work_after_route integer NOT NULL,
    work_after_order uuid NOT NULL,
    work_covered boolean DEFAULT false NOT NULL,
    receipt_after_position bigint DEFAULT 0 NOT NULL,
    receipt_after_event integer DEFAULT '-1'::integer NOT NULL,
    receipts_covered boolean DEFAULT false NOT NULL
);


--
-- Name: live_copy_business_inventory; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_business_inventory (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    locator jsonb NOT NULL,
    CONSTRAINT live_copy_business_inventory_kind_check CHECK ((kind = ANY (ARRAY['commerce-work'::text, 'commerce-receipt'::text]))),
    CONSTRAINT live_copy_business_inventory_locator_check CHECK ((octet_length((locator)::text) <= 1024))
);


--
-- Name: live_copy_domain; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_domain (
    partition_no integer NOT NULL,
    domain_id uuid DEFAULT gen_random_uuid() NOT NULL,
    node text NOT NULL,
    epoch integer NOT NULL,
    admitted_position bigint NOT NULL,
    state text NOT NULL,
    CONSTRAINT live_copy_domain_admitted_position_check CHECK ((admitted_position >= 0)),
    CONSTRAINT live_copy_domain_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT live_copy_domain_state_check CHECK ((state = ANY (ARRAY['active'::text, 'isolated'::text])))
);


--
-- Name: live_copy_gate; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_gate (
    route integer NOT NULL,
    source_domain uuid NOT NULL,
    transition_id uuid NOT NULL,
    receiver_domain uuid NOT NULL,
    receiver_epoch integer NOT NULL,
    module text NOT NULL,
    effect_key jsonb,
    payload jsonb,
    roles jsonb,
    outcome text NOT NULL,
    result_id uuid DEFAULT gen_random_uuid() NOT NULL,
    retired boolean DEFAULT false NOT NULL,
    applying_transaction xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT live_copy_gate_check CHECK ((retired OR ((effect_key IS NOT NULL) AND (payload IS NOT NULL) AND (roles IS NOT NULL)))),
    CONSTRAINT live_copy_gate_effect_key_check CHECK (((effect_key IS NULL) OR (octet_length((effect_key)::text) <= 1024))),
    CONSTRAINT live_copy_gate_module_check CHECK ((module = ANY (ARRAY['commerce.creator-sale'::text, 'library.subject-listing'::text]))),
    CONSTRAINT live_copy_gate_outcome_check CHECK ((outcome = ANY (ARRAY['applying'::text, 'applied'::text, 'cancelled'::text, 'superseded'::text]))),
    CONSTRAINT live_copy_gate_payload_check CHECK (((payload IS NULL) OR (octet_length((payload)::text) <= 8192))),
    CONSTRAINT live_copy_gate_roles_check CHECK (((roles IS NULL) OR ((jsonb_array_length(roles) <= 64) AND (octet_length((roles)::text) <= 8192))))
);


--
-- Name: live_copy_hold; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_hold (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    transition_id uuid NOT NULL,
    source_route integer NOT NULL,
    source_domain uuid NOT NULL,
    source_transaction_id uuid NOT NULL,
    receiver_route integer NOT NULL,
    receiver_domain uuid NOT NULL,
    receiver_epoch integer NOT NULL,
    account_domain uuid NOT NULL,
    roles integer NOT NULL,
    role_index integer NOT NULL,
    reservation_id uuid NOT NULL,
    result_id uuid,
    outcome text,
    CONSTRAINT live_copy_hold_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT live_copy_hold_check1 CHECK (((result_id IS NULL) = (outcome IS NULL))),
    CONSTRAINT live_copy_hold_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'cancelled'::text, 'superseded'::text]))),
    CONSTRAINT live_copy_hold_role_index_check CHECK (((role_index >= 0) AND (role_index <= 63))),
    CONSTRAINT live_copy_hold_roles_check CHECK (((roles >= 1) AND (roles <= 262143)))
);


--
-- Name: live_copy_inventory; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_inventory (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    item text NOT NULL,
    source_domain uuid NOT NULL,
    transition_id uuid NOT NULL,
    CONSTRAINT live_copy_inventory_item_check CHECK ((item = ANY (ARRAY['source'::text, 'hold'::text, 'receiver'::text])))
);


--
-- Name: live_copy_role_gate; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_role_gate (
    route integer NOT NULL,
    source_domain uuid NOT NULL,
    transition_id uuid NOT NULL,
    role_index integer NOT NULL,
    result_id uuid,
    outcome text,
    CONSTRAINT live_copy_role_gate_check CHECK (((result_id IS NULL) = (outcome IS NULL))),
    CONSTRAINT live_copy_role_gate_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'cancelled'::text, 'superseded'::text]))),
    CONSTRAINT live_copy_role_gate_role_index_check CHECK (((role_index >= 0) AND (role_index <= 63)))
);


--
-- Name: live_copy_seal; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_seal (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    sealed boolean DEFAULT false NOT NULL
);


--
-- Name: live_copy_transition; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.live_copy_transition (
    route integer NOT NULL,
    transition_id uuid NOT NULL,
    module text NOT NULL,
    source_domain uuid NOT NULL,
    source_epoch integer NOT NULL,
    effect_key jsonb NOT NULL,
    effect_digest bytea NOT NULL,
    receiver_route integer NOT NULL,
    receiver_domain uuid NOT NULL,
    receiver_epoch integer NOT NULL,
    payload jsonb,
    roles jsonb,
    state text DEFAULT 'pending'::text NOT NULL,
    result_id uuid,
    outcome text,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT live_copy_transition_check CHECK ((route = ((get_byte(uuid_send(transition_id), 10) * 256) + get_byte(uuid_send(transition_id), 11)))),
    CONSTRAINT live_copy_transition_check1 CHECK (((result_id IS NULL) = (outcome IS NULL))),
    CONSTRAINT live_copy_transition_check2 CHECK (((state = 'pending'::text) = (result_id IS NULL))),
    CONSTRAINT live_copy_transition_check3 CHECK (((state = 'retired'::text) OR ((payload IS NOT NULL) AND (roles IS NOT NULL)))),
    CONSTRAINT live_copy_transition_effect_digest_check CHECK ((octet_length(effect_digest) = 32)),
    CONSTRAINT live_copy_transition_effect_key_check CHECK ((octet_length((effect_key)::text) <= 1024)),
    CONSTRAINT live_copy_transition_module_check CHECK ((module = ANY (ARRAY['commerce.creator-sale'::text, 'library.subject-listing'::text]))),
    CONSTRAINT live_copy_transition_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'cancelled'::text, 'superseded'::text]))),
    CONSTRAINT live_copy_transition_payload_check CHECK (((payload IS NULL) OR (octet_length((payload)::text) <= 8192))),
    CONSTRAINT live_copy_transition_receiver_epoch_check CHECK ((receiver_epoch > 0)),
    CONSTRAINT live_copy_transition_receiver_route_check CHECK (((receiver_route >= 0) AND (receiver_route <= 65535))),
    CONSTRAINT live_copy_transition_roles_check CHECK (((roles IS NULL) OR ((jsonb_typeof(roles) = 'array'::text) AND (jsonb_array_length(roles) <= 64) AND (octet_length((roles)::text) <= 8192)))),
    CONSTRAINT live_copy_transition_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT live_copy_transition_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT live_copy_transition_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'complete'::text, 'retired'::text])))
);


--
-- Name: membership_inverse; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.membership_inverse (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    group_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    source_transaction_id uuid,
    CONSTRAINT membership_inverse_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT membership_inverse_kind_check CHECK ((kind = ANY (ARRAY['organization'::text, 'realm'::text]))),
    CONSTRAINT membership_inverse_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: membership_inverse_coverage; Type: VIEW; Schema: access; Owner: -
--

CREATE VIEW access.membership_inverse_coverage AS
 SELECT route,
    account_id,
    membership_inverse_complete AS complete
   FROM access.account;


--
-- Name: membership_inverse_terminal; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.membership_inverse_terminal (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    group_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    reservation_transaction_id uuid NOT NULL,
    proof_transaction_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT membership_inverse_terminal_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT membership_inverse_terminal_kind_check CHECK ((kind = ANY (ARRAY['organization'::text, 'realm'::text])))
);


--
-- Name: operator_fence_page; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.operator_fence_page (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    page_key text NOT NULL,
    cursor text,
    next_cursor text,
    allowlist jsonb NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT operator_fence_page_allowlist_check CHECK (access.committed_continuation_entries(allowlist, 0, 101, false)),
    CONSTRAINT operator_fence_page_page_key_check CHECK ((page_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: operator_opening_receipt; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.operator_opening_receipt (
    route integer NOT NULL,
    operator_account_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    subject_account_id uuid NOT NULL,
    acting_human_id uuid NOT NULL,
    purpose text NOT NULL,
    action text NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    requested_by text,
    human_authn_epoch bigint NOT NULL,
    human_epoch_floor bigint NOT NULL,
    operator_epoch_floor bigint NOT NULL,
    subject_epoch_floor bigint NOT NULL,
    relation_version bigint NOT NULL,
    reservation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    transaction_id uuid NOT NULL,
    consumed_transaction_id uuid,
    credential_purpose text,
    credential_operation_key text,
    credential_effect_reference text,
    credential_effect_digest text,
    erasure_principal_id uuid GENERATED ALWAYS AS (access.erasure_requested_principal(requested_by)) STORED,
    CONSTRAINT credential_binding_closed CHECK ((((credential_purpose IS NULL) AND (credential_operation_key IS NULL) AND (credential_effect_reference IS NULL) AND (credential_effect_digest IS NULL)) OR ((purpose = 'credential-management'::text) AND (credential_purpose IS NOT NULL) AND (credential_purpose = ANY (ARRAY['set-password'::text, 'remove-password'::text, 'add-key'::text, 'remove-key'::text])) AND (credential_operation_key IS NOT NULL) AND ((length(credential_operation_key) >= 1) AND (length(credential_operation_key) <= 255)) AND (credential_effect_reference IS NOT NULL) AND ((length(credential_effect_reference) >= 1) AND (length(credential_effect_reference) <= 4096)) AND (credential_effect_digest IS NOT NULL) AND (credential_effect_digest ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT operator_opening_receipt_check CHECK ((route = ((get_byte(uuid_send(operator_account_id), 10) * 256) + get_byte(uuid_send(operator_account_id), 11)))),
    CONSTRAINT operator_opening_receipt_check1 CHECK ((expires_at <= (created_at + '00:01:00'::interval))),
    CONSTRAINT operator_opening_receipt_human_authn_epoch_check CHECK ((human_authn_epoch > 0)),
    CONSTRAINT operator_opening_receipt_purpose_check CHECK ((purpose = ANY (ARRAY['session'::text, 'credential-management'::text])))
);


--
-- Name: operator_relation_slot; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.operator_relation_slot (
    route integer NOT NULL,
    subject_account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    operator_account_id uuid NOT NULL,
    terminal boolean NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT operator_relation_slot_check CHECK ((route = ((get_byte(uuid_send(subject_account_id), 10) * 256) + get_byte(uuid_send(subject_account_id), 11))))
);


--
-- Name: organization_close; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.organization_close (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    handle text,
    step integer DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    handle_key text NOT NULL,
    cursor_row_key uuid,
    CONSTRAINT organization_close_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11))))
);


--
-- Name: organization_member; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.organization_member (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    member_account_id uuid NOT NULL,
    role text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    row_key uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT organization_member_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11)))),
    CONSTRAINT organization_member_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT organization_member_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT organization_member_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: principal_assignment; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.principal_assignment (
    route integer NOT NULL,
    principal_id uuid NOT NULL,
    request_id uuid NOT NULL,
    assigned_actor_id uuid NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    creator_principal_id uuid,
    issued_valid tstzrange NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT principal_assignment_check CHECK ((route = ((get_byte(uuid_send(principal_id), 10) * 256) + get_byte(uuid_send(principal_id), 11)))),
    CONSTRAINT principal_assignment_check1 CHECK ((creator_principal_id = principal_id)),
    CONSTRAINT principal_assignment_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT principal_assignment_valid_check CHECK ((((revoked_at IS NOT NULL) AND isempty(valid)) OR ((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid)))))
);


--
-- Name: rating_counter_controller; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.rating_counter_controller (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    controller_id uuid NOT NULL,
    CONSTRAINT rating_counter_controller_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))))
);


--
-- Name: realm_erasure_succession; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.realm_erasure_succession (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    account_id uuid NOT NULL,
    source_route integer NOT NULL,
    source_version integer NOT NULL,
    source_at timestamp with time zone NOT NULL,
    frontier jsonb,
    cursor_role text,
    cursor_kind text,
    cursor_subject_id uuid,
    cursor_subject_role text,
    cursor_interval_key bigint,
    best_account_id uuid,
    best_role text,
    best_valid tstzrange,
    best_interval_key bigint,
    decision_state text,
    decision_operation_id uuid,
    decided_at timestamp with time zone,
    source_ownership_state text,
    source_orphaned_at timestamp with time zone,
    source_claim_eligible_at timestamp with time zone,
    result_orphaned_at timestamp with time zone,
    result_claim_eligible_at timestamp with time zone,
    CONSTRAINT realm_erasure_succession_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT realm_erasure_succession_check1 CHECK ((source_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT realm_erasure_succession_check2 CHECK (((decision_state IS NULL) = (decision_operation_id IS NULL))),
    CONSTRAINT realm_erasure_succession_check3 CHECK (((decision_state IS NULL) = (decided_at IS NULL))),
    CONSTRAINT realm_erasure_succession_check4 CHECK (((decision_state IS DISTINCT FROM 'owned'::text) OR (best_account_id IS NOT NULL))),
    CONSTRAINT realm_erasure_succession_check5 CHECK (((decision_state IS DISTINCT FROM 'orphaned'::text) OR (best_account_id IS NULL))),
    CONSTRAINT realm_erasure_succession_decision_state_check CHECK ((decision_state = ANY (ARRAY['owned'::text, 'orphaned'::text]))),
    CONSTRAINT realm_erasure_succession_result_episode CHECK (((source_ownership_state IS NULL) OR ((decision_state IS DISTINCT FROM 'orphaned'::text) AND (result_orphaned_at IS NULL) AND (result_claim_eligible_at IS NULL)) OR ((decision_state = 'orphaned'::text) AND (result_orphaned_at IS NOT NULL) AND (result_claim_eligible_at IS NOT NULL) AND (result_orphaned_at = COALESCE(source_orphaned_at, source_at)) AND (result_claim_eligible_at = (result_orphaned_at + '720:00:00'::interval))))),
    CONSTRAINT realm_erasure_succession_source_episode CHECK (((source_ownership_state IS NULL) OR ((source_ownership_state = 'owned'::text) AND (source_orphaned_at IS NULL) AND (source_claim_eligible_at IS NULL)) OR ((source_ownership_state = 'orphaned'::text) AND (source_orphaned_at IS NOT NULL) AND (source_claim_eligible_at IS NOT NULL) AND (source_claim_eligible_at = (source_orphaned_at + '720:00:00'::interval))))),
    CONSTRAINT realm_erasure_succession_source_ownership_state_check CHECK ((source_ownership_state = ANY (ARRAY['owned'::text, 'orphaned'::text]))),
    CONSTRAINT realm_erasure_succession_source_version_check CHECK ((source_version > 0))
);


--
-- Name: realm_membership_reconciliation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.realm_membership_reconciliation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id text NOT NULL,
    after_id uuid,
    completed boolean DEFAULT false NOT NULL
);


--
-- Name: realm_membership_reconciliation_item; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.realm_membership_reconciliation_item (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id text NOT NULL,
    reservation_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    hold_transaction_id uuid CONSTRAINT realm_membership_reconciliation_it_hold_transaction_id_not_null NOT NULL,
    state text NOT NULL,
    CONSTRAINT realm_membership_reconciliation_item_state_check CHECK ((state = ANY (ARRAY['published'::text, 'cancelled'::text, 'pending'::text, 'uncertain'::text])))
);


--
-- Name: realm_membership_transition; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.realm_membership_transition (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    operation_id text NOT NULL,
    hold_transaction_id uuid NOT NULL,
    legacy boolean DEFAULT false NOT NULL,
    proof_transaction_id uuid,
    outcome text,
    consumed_transaction_id uuid,
    CONSTRAINT realm_membership_transition_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT realm_membership_transition_check1 CHECK (((proof_transaction_id IS NULL) = (outcome IS NULL))),
    CONSTRAINT realm_membership_transition_check2 CHECK (((proof_transaction_id IS NULL) = (consumed_transaction_id IS NULL))),
    CONSTRAINT realm_membership_transition_operation_id_check CHECK (((length(operation_id) >= 1) AND (length(operation_id) <= 256))),
    CONSTRAINT realm_membership_transition_outcome_check CHECK ((outcome = ANY (ARRAY['published'::text, 'cancelled'::text]))),
    CONSTRAINT realm_membership_transition_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: resource_denial; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_denial (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT resource_denial_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_denial_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_denial_reason_check CHECK ((reason = ANY (ARRAY['resource'::text, 'suspension'::text, 'realm_ban'::text]))),
    CONSTRAINT resource_denial_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_denial_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_denial_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_denial_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_denial ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_denial_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: resource_grant; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_grant (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    subject_kind text DEFAULT 'identity'::text NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT resource_grant_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_grant_subject_check CHECK ((((subject_kind = 'identity'::text) AND (subject_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((subject_kind = 'active_accounts'::text) AND (subject_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (subject_role = ''::text)))),
    CONSTRAINT resource_grant_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['identity'::text, 'active_accounts'::text]))),
    CONSTRAINT resource_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_grant_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_grant ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_grant_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: resource_initialization; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_initialization (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    resource_type text NOT NULL,
    creator_id uuid,
    initialized_at timestamp with time zone,
    CONSTRAINT resource_initialization_attribution_check CHECK (((creator_id IS NULL) = (initialized_at IS NULL))),
    CONSTRAINT resource_initialization_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_initialization_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: resource_role_grant_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_role_grant ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_role_grant_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: resource_role_provenance_occurrence_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_role_provenance ALTER COLUMN occurrence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_role_provenance_occurrence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: standing_parent_installation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.standing_parent_installation (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    actions text[] NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT standing_parent_installation_actions_check CHECK ((cardinality(actions) > 0)),
    CONSTRAINT standing_parent_installation_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT standing_parent_installation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: standing_parent_installation_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.standing_parent_installation ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.standing_parent_installation_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflow_approval; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.workflow_approval (
    route integer NOT NULL,
    approval_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    requested_by text,
    authn_epoch bigint NOT NULL,
    operation_key text NOT NULL,
    operation jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    jwt_expires_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    consumed_at timestamp with time zone,
    consumed_transaction_id uuid,
    erasure_subject_id uuid GENERATED ALWAYS AS ((
CASE (operation ->> 'kind'::text)
    WHEN 'credential'::text THEN (operation ->> 'subjectAccountId'::text)
    WHEN 'membership'::text THEN (operation ->> 'organizationId'::text)
    WHEN 'opening'::text THEN (operation ->> 'subjectAccountId'::text)
    WHEN 'rename'::text THEN (operation ->> 'accountId'::text)
    WHEN 'delete'::text THEN (operation ->> 'accountId'::text)
    WHEN 'revoke'::text THEN (operation ->> 'accountId'::text)
    WHEN 'fence-operator'::text THEN (operation ->> 'accountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_operator_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = ANY (ARRAY['automated'::text, 'opening'::text, 'transfer'::text, 'transfer-acceptance'::text])) THEN (operation ->> 'operatorAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_member_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = 'membership'::text) THEN (operation ->> 'memberAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_previous_operator_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = ANY (ARRAY['transfer'::text, 'transfer-acceptance'::text])) THEN ((operation -> 'previous'::text) ->> 'operatorAccountId'::text)
    WHEN ((operation ->> 'kind'::text) = 'delete'::text) THEN ((operation -> 'responsibility'::text) ->> 'operatorAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_previous_subject_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = ANY (ARRAY['transfer'::text, 'transfer-acceptance'::text])) THEN ((operation -> 'previous'::text) ->> 'subjectAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_principal_id uuid GENERATED ALWAYS AS (access.erasure_requested_principal(requested_by)) STORED,
    CONSTRAINT credential_expiry CHECK ((((operation ->> 'kind'::text) <> 'credential'::text) OR (expires_at <= (created_at + '00:01:00'::interval)))),
    CONSTRAINT workflow_approval_authn_epoch_check CHECK (((authn_epoch > 0) AND (authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT workflow_approval_check CHECK ((route = ((get_byte(uuid_send(approval_id), 10) * 256) + get_byte(uuid_send(approval_id), 11)))),
    CONSTRAINT workflow_approval_check1 CHECK ((route = ((get_byte(uuid_send(actor_id), 10) * 256) + get_byte(uuid_send(actor_id), 11)))),
    CONSTRAINT workflow_approval_check2 CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)) AND (expires_at <= jwt_expires_at))),
    CONSTRAINT workflow_approval_client_id_check CHECK (((length(client_id) >= 1) AND (length(client_id) <= 1024))),
    CONSTRAINT workflow_approval_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_approval_operation_check CHECK (((jsonb_typeof(operation) = 'object'::text) AND (octet_length((operation)::text) <=
CASE
    WHEN ((operation ->> 'kind'::text) = 'client-reduction'::text) THEN 71167
    ELSE 16384
END))),
    CONSTRAINT workflow_approval_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 255))),
    CONSTRAINT workflow_approval_requested_by_check CHECK ((length(requested_by) <= 100)),
    CONSTRAINT workflow_approval_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT workflow_approval_scopes_check CHECK (((cardinality(scopes) <= 512) AND (octet_length(array_to_string(scopes, ' '::text)) <= 66047)))
);


--
-- Name: write_rate_chunk; Type: TABLE; Schema: access; Owner: -
--

CREATE UNLOGGED TABLE access.write_rate_chunk (
    route integer NOT NULL,
    identity_digest text NOT NULL,
    operation_id uuid NOT NULL,
    chunk_index bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    account_id uuid,
    CONSTRAINT write_rate_chunk_chunk_index_check CHECK (((chunk_index >= 0) AND (chunk_index <= '9007199254740991'::bigint))),
    CONSTRAINT write_rate_chunk_expires_at_check CHECK (isfinite(expires_at)),
    CONSTRAINT write_rate_chunk_identity_digest_check CHECK ((identity_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT write_rate_chunk_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: write_rate_counter; Type: TABLE; Schema: access; Owner: -
--

CREATE UNLOGGED TABLE access.write_rate_counter (
    identity_digest text NOT NULL,
    family text NOT NULL,
    count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    route integer NOT NULL,
    account_id uuid,
    CONSTRAINT write_rate_counter_count_check CHECK ((count >= 0)),
    CONSTRAINT write_rate_counter_expires_at_check CHECK (isfinite(expires_at)),
    CONSTRAINT write_rate_counter_family_check CHECK ((family ~ '^[a-z][a-z0-9_.:-]{0,63}$'::text)),
    CONSTRAINT write_rate_counter_identity_digest_check CHECK ((identity_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT write_rate_counter_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: account_discovery_claim_cursor account_discovery_claim_cursor_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_discovery_claim_cursor
    ADD CONSTRAINT account_discovery_claim_cursor_pkey PRIMARY KEY (route, account_id, claim_partition);


--
-- Name: account_discovery_claim_intent account_discovery_claim_intent_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_discovery_claim_intent
    ADD CONSTRAINT account_discovery_claim_intent_pkey PRIMARY KEY (route, account_id);


--
-- Name: account_discovery_intent account_discovery_intent_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_discovery_intent
    ADD CONSTRAINT account_discovery_intent_pkey PRIMARY KEY (route, account_id);


--
-- Name: account_discovery_population account_discovery_population_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_discovery_population
    ADD CONSTRAINT account_discovery_population_pkey PRIMARY KEY (partition_no);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (route, account_id);


--
-- Name: account_preferences account_preferences_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_preferences
    ADD CONSTRAINT account_preferences_pkey PRIMARY KEY (route, account_id);


--
-- Name: agent_identity_intent agent_identity_intent_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_intent
    ADD CONSTRAINT agent_identity_intent_pkey PRIMARY KEY (route, account_id, direction, receipt_id);


--
-- Name: agent_identity_recovery agent_identity_recovery_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_recovery
    ADD CONSTRAINT agent_identity_recovery_pkey PRIMARY KEY (route, account_id, direction, receipt_id);


--
-- Name: agent_identity_reversal_settlement agent_identity_reversal_settl_route_account_id_verification_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_reversal_settlement
    ADD CONSTRAINT agent_identity_reversal_settl_route_account_id_verification_key UNIQUE (route, account_id, verification_receipt_id);


--
-- Name: agent_identity_reversal_settlement agent_identity_reversal_settlement_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_reversal_settlement
    ADD CONSTRAINT agent_identity_reversal_settlement_pkey PRIMARY KEY (route, account_id, reversal_receipt_id);


--
-- Name: agent_identity_technical_role agent_identity_technical_role_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_technical_role
    ADD CONSTRAINT agent_identity_technical_role_pkey PRIMARY KEY (route, account_id, direction, receipt_id, role_account_id);


--
-- Name: agent_identity_technical_source agent_identity_technical_source_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_technical_source
    ADD CONSTRAINT agent_identity_technical_source_pkey PRIMARY KEY (route, account_id, direction, receipt_id);


--
-- Name: agent_page agent_page_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_page
    ADD CONSTRAINT agent_page_pkey PRIMARY KEY (route, subject_id);


--
-- Name: agent_verification_request agent_verification_request_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_verification_request
    ADD CONSTRAINT agent_verification_request_pkey PRIMARY KEY (route, request_id);


--
-- Name: auth_erasure_cut_partition auth_erasure_cut_partition_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_cut_partition
    ADD CONSTRAINT auth_erasure_cut_partition_pkey PRIMARY KEY (cut_id, partition_no);


--
-- Name: auth_erasure_cut auth_erasure_cut_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_cut
    ADD CONSTRAINT auth_erasure_cut_pkey PRIMARY KEY (cut_id);


--
-- Name: auth_erasure_live_partition auth_erasure_live_partition_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_partition
    ADD CONSTRAINT auth_erasure_live_partition_pkey PRIMARY KEY (partition_no);


--
-- Name: auth_erasure_live_receiver auth_erasure_live_receiver_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_receiver
    ADD CONSTRAINT auth_erasure_live_receiver_pkey PRIMARY KEY (cut_id);


--
-- Name: auth_erasure_live_subscription auth_erasure_live_subscription_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_subscription
    ADD CONSTRAINT auth_erasure_live_subscription_pkey PRIMARY KEY (cut_id, partition_no);


--
-- Name: auth_erasure_obligation auth_erasure_obligation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_obligation
    ADD CONSTRAINT auth_erasure_obligation_pkey PRIMARY KEY (partition_no, ordinal);


--
-- Name: auth_erasure_obligation auth_erasure_obligation_route_account_id_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_obligation
    ADD CONSTRAINT auth_erasure_obligation_route_account_id_key UNIQUE (route, account_id);


--
-- Name: auth_erasure_source auth_erasure_source_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_source
    ADD CONSTRAINT auth_erasure_source_pkey PRIMARY KEY (partition_no);


--
-- Name: auth_history_proof auth_history_proof_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_history_proof
    ADD CONSTRAINT auth_history_proof_pkey PRIMARY KEY (route, account_id, phase);


--
-- Name: auth_receiving_closure auth_receiving_closure_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_closure
    ADD CONSTRAINT auth_receiving_closure_pkey PRIMARY KEY (route, account_id, control_revision);


--
-- Name: auth_receiving_control auth_receiving_control_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_control
    ADD CONSTRAINT auth_receiving_control_pkey PRIMARY KEY (partition_no);


--
-- Name: auth_receiving_obligation auth_receiving_obligation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_obligation
    ADD CONSTRAINT auth_receiving_obligation_pkey PRIMARY KEY (route, account_id);


--
-- Name: committed_continuation_completion committed_continuation_completion_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation_completion
    ADD CONSTRAINT committed_continuation_completion_pkey PRIMARY KEY (route, continuation_id, step, target, key);


--
-- Name: committed_continuation_entry committed_continuation_entry_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation_entry
    ADD CONSTRAINT committed_continuation_entry_pkey PRIMARY KEY (route, continuation_id, step, target, key);


--
-- Name: committed_continuation committed_continuation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation
    ADD CONSTRAINT committed_continuation_pkey PRIMARY KEY (route, continuation_id);


--
-- Name: committed_continuation committed_continuation_route_operation_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation
    ADD CONSTRAINT committed_continuation_route_operation_key_key UNIQUE (route, operation_key);


--
-- Name: credential_floor_receipt credential_floor_receipt_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.credential_floor_receipt
    ADD CONSTRAINT credential_floor_receipt_pkey PRIMARY KEY (route, account_id, opening_receipt_id);


--
-- Name: current_resource_role_due current_resource_role_due_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.current_resource_role_due
    ADD CONSTRAINT current_resource_role_due_pkey PRIMARY KEY (route, resource_id, due_at, interval_key);


--
-- Name: current_resource_role_frontier current_resource_role_frontier_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.current_resource_role_frontier
    ADD CONSTRAINT current_resource_role_frontier_pkey PRIMARY KEY (route, resource_id);


--
-- Name: current_resource_role_install current_resource_role_install_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.current_resource_role_install
    ADD CONSTRAINT current_resource_role_install_pkey PRIMARY KEY (singleton);


--
-- Name: current_resource_role_key current_resource_role_key_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.current_resource_role_key
    ADD CONSTRAINT current_resource_role_key_pkey PRIMARY KEY (route, resource_id, grant_role, subject_kind, subject_id, subject_role, interval_key);


--
-- Name: erasure_acknowledgement erasure_acknowledgement_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_acknowledgement
    ADD CONSTRAINT erasure_acknowledgement_pkey PRIMARY KEY (route, account_id, participant);


--
-- Name: erasure_continuation_role erasure_continuation_role_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_continuation_role
    ADD CONSTRAINT erasure_continuation_role_pkey PRIMARY KEY (account_id, route, artifact, row_id);


--
-- Name: erasure_late_item erasure_late_item_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_late_item
    ADD CONSTRAINT erasure_late_item_pkey PRIMARY KEY (route, account_id, participant, locator);


--
-- Name: erasure_locator_work erasure_locator_work_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_locator_work
    ADD CONSTRAINT erasure_locator_work_pkey PRIMARY KEY (workflow_id);


--
-- Name: erasure_native_blocked erasure_native_blocked_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_blocked
    ADD CONSTRAINT erasure_native_blocked_pkey PRIMARY KEY (progress_id, phase);


--
-- Name: erasure_native_consumed_child erasure_native_consumed_child_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_consumed_child
    ADD CONSTRAINT erasure_native_consumed_child_pkey PRIMARY KEY (route, continuation_id, artifact, entry_key);


--
-- Name: erasure_native_coverage erasure_native_coverage_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_coverage
    ADD CONSTRAINT erasure_native_coverage_pkey PRIMARY KEY (name);


--
-- Name: erasure_native_progress erasure_native_progress_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_progress
    ADD CONSTRAINT erasure_native_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_native_progress erasure_native_progress_progress_id_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_progress
    ADD CONSTRAINT erasure_native_progress_progress_id_key UNIQUE (progress_id);


--
-- Name: erasure erasure_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure
    ADD CONSTRAINT erasure_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_progress erasure_progress_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_progress
    ADD CONSTRAINT erasure_progress_pkey PRIMARY KEY (route, account_id, store, role);


--
-- Name: exposure_opening exposure_opening_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.exposure_opening
    ADD CONSTRAINT exposure_opening_pkey PRIMARY KEY (route, "group", valid WITHOUT OVERLAPS);


--
-- Name: governance_bootstrap governance_bootstrap_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.governance_bootstrap
    ADD CONSTRAINT governance_bootstrap_pkey PRIMARY KEY (route, resource_id);


--
-- Name: governance_reach governance_reach_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.governance_reach
    ADD CONSTRAINT governance_reach_pkey PRIMARY KEY (route, transaction_id, action, resource_id);


--
-- Name: handle_claim handle_claim_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.handle_claim
    ADD CONSTRAINT handle_claim_pkey PRIMARY KEY (route, normalized_handle);


--
-- Name: lifecycle_coordination lifecycle_coordination_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_coordination
    ADD CONSTRAINT lifecycle_coordination_pkey PRIMARY KEY (route, account_id, reservation_id);


--
-- Name: lifecycle_fence_receipt lifecycle_fence_receipt_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_fence_receipt
    ADD CONSTRAINT lifecycle_fence_receipt_pkey PRIMARY KEY (route, account_id, receipt_id);


--
-- Name: lifecycle_handle_effect lifecycle_handle_effect_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_handle_effect
    ADD CONSTRAINT lifecycle_handle_effect_pkey PRIMARY KEY (route, normalized_handle, account_id, reservation_id, operation_id, effect);


--
-- Name: lifecycle_handle_operation lifecycle_handle_operation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_handle_operation
    ADD CONSTRAINT lifecycle_handle_operation_pkey PRIMARY KEY (route, account_id, operation_id);


--
-- Name: lifecycle_membership_slot lifecycle_membership_slot_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_membership_slot
    ADD CONSTRAINT lifecycle_membership_slot_pkey PRIMARY KEY (route, organization_id, member_account_id, reservation_id);


--
-- Name: lifecycle_registration_expiry lifecycle_registration_expiry_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_registration_expiry
    ADD CONSTRAINT lifecycle_registration_expiry_pkey PRIMARY KEY (route, account_id, reservation_id);


--
-- Name: live_copy_bootstrap live_copy_bootstrap_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_bootstrap
    ADD CONSTRAINT live_copy_bootstrap_pkey PRIMARY KEY (partition_no);


--
-- Name: live_copy_business_inventory live_copy_business_inventory_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_business_inventory
    ADD CONSTRAINT live_copy_business_inventory_pkey PRIMARY KEY (route, account_id, kind, locator);


--
-- Name: live_copy_domain live_copy_domain_domain_id_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_domain
    ADD CONSTRAINT live_copy_domain_domain_id_key UNIQUE (domain_id);


--
-- Name: live_copy_domain live_copy_domain_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_domain
    ADD CONSTRAINT live_copy_domain_pkey PRIMARY KEY (partition_no);


--
-- Name: live_copy_gate live_copy_gate_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_gate
    ADD CONSTRAINT live_copy_gate_pkey PRIMARY KEY (route, source_domain, transition_id);


--
-- Name: live_copy_hold live_copy_hold_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_hold
    ADD CONSTRAINT live_copy_hold_pkey PRIMARY KEY (route, account_id, source_domain, transition_id);


--
-- Name: live_copy_hold live_copy_hold_route_account_id_reservation_id_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_hold
    ADD CONSTRAINT live_copy_hold_route_account_id_reservation_id_key UNIQUE (route, account_id, reservation_id);


--
-- Name: live_copy_inventory live_copy_inventory_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_inventory
    ADD CONSTRAINT live_copy_inventory_pkey PRIMARY KEY (route, account_id, item, source_domain, transition_id);


--
-- Name: live_copy_role_gate live_copy_role_gate_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_role_gate
    ADD CONSTRAINT live_copy_role_gate_pkey PRIMARY KEY (route, source_domain, transition_id, role_index);


--
-- Name: live_copy_seal live_copy_seal_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_seal
    ADD CONSTRAINT live_copy_seal_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: live_copy_transition live_copy_transition_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_transition
    ADD CONSTRAINT live_copy_transition_pkey PRIMARY KEY (route, transition_id);


--
-- Name: live_copy_transition live_copy_transition_route_module_source_domain_effect_dige_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_transition
    ADD CONSTRAINT live_copy_transition_route_module_source_domain_effect_dige_key UNIQUE (route, module, source_domain, effect_digest);


--
-- Name: live_copy_transition live_copy_transition_route_module_source_domain_effect_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_transition
    ADD CONSTRAINT live_copy_transition_route_module_source_domain_effect_key_key UNIQUE (route, module, source_domain, effect_key);


--
-- Name: membership_inverse membership_inverse_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.membership_inverse
    ADD CONSTRAINT membership_inverse_pkey PRIMARY KEY (route, account_id, kind, group_id);


--
-- Name: membership_inverse_terminal membership_inverse_terminal_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.membership_inverse_terminal
    ADD CONSTRAINT membership_inverse_terminal_pkey PRIMARY KEY (route, account_id, kind, group_id, reservation_id);


--
-- Name: operator_fence_page operator_fence_page_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_fence_page
    ADD CONSTRAINT operator_fence_page_pkey PRIMARY KEY (route, continuation_id, page_key);


--
-- Name: operator_opening_receipt operator_opening_receipt_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_opening_receipt
    ADD CONSTRAINT operator_opening_receipt_pkey PRIMARY KEY (route, operator_account_id, receipt_id);


--
-- Name: operator_relation_slot operator_relation_slot_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_relation_slot
    ADD CONSTRAINT operator_relation_slot_pkey PRIMARY KEY (route, subject_account_id, reservation_id);


--
-- Name: organization_close organization_close_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.organization_close
    ADD CONSTRAINT organization_close_pkey PRIMARY KEY (route, organization_id);


--
-- Name: organization_member organization_member_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.organization_member
    ADD CONSTRAINT organization_member_pkey PRIMARY KEY (route, organization_id, member_account_id, valid WITHOUT OVERLAPS);


--
-- Name: principal_assignment principal_assignment_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.principal_assignment
    ADD CONSTRAINT principal_assignment_pkey PRIMARY KEY (route, principal_id, request_id);


--
-- Name: rating_counter_controller rating_counter_controller_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.rating_counter_controller
    ADD CONSTRAINT rating_counter_controller_pkey PRIMARY KEY (route, account_id, effective_at);


--
-- Name: realm_erasure_succession realm_erasure_succession_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.realm_erasure_succession
    ADD CONSTRAINT realm_erasure_succession_pkey PRIMARY KEY (route, resource_id, account_id);


--
-- Name: realm_membership_reconciliation_item realm_membership_reconciliation_item_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.realm_membership_reconciliation_item
    ADD CONSTRAINT realm_membership_reconciliation_item_pkey PRIMARY KEY (route, account_id, barrier_id, reservation_id);


--
-- Name: realm_membership_reconciliation realm_membership_reconciliation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.realm_membership_reconciliation
    ADD CONSTRAINT realm_membership_reconciliation_pkey PRIMARY KEY (route, account_id, barrier_id);


--
-- Name: realm_membership_transition realm_membership_transition_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.realm_membership_transition
    ADD CONSTRAINT realm_membership_transition_pkey PRIMARY KEY (route, account_id, generation_id);


--
-- Name: realm_membership_transition realm_membership_transition_route_account_id_realm_id_opera_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.realm_membership_transition
    ADD CONSTRAINT realm_membership_transition_route_account_id_realm_id_opera_key UNIQUE (route, account_id, realm_id, operation_id);


--
-- Name: resource_denial resource_denial_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_denial
    ADD CONSTRAINT resource_denial_erasure_key_key UNIQUE (erasure_key);


--
-- Name: resource_denial resource_denial_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_denial
    ADD CONSTRAINT resource_denial_pkey PRIMARY KEY (route, resource_id, subject_id, subject_role, action, reason, valid WITHOUT OVERLAPS);


--
-- Name: resource_grant resource_grant_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_grant
    ADD CONSTRAINT resource_grant_erasure_key_key UNIQUE (erasure_key);


--
-- Name: resource_grant resource_grant_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_grant
    ADD CONSTRAINT resource_grant_pkey PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, action, valid WITHOUT OVERLAPS);


--
-- Name: resource_initialization resource_initialization_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_initialization
    ADD CONSTRAINT resource_initialization_pkey PRIMARY KEY (route, resource_id);


--
-- Name: resource_role_grant resource_role_grant_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_role_grant
    ADD CONSTRAINT resource_role_grant_erasure_key_key UNIQUE (erasure_key);


--
-- Name: resource_role_grant resource_role_grant_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_role_grant
    ADD CONSTRAINT resource_role_grant_pkey PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid WITHOUT OVERLAPS);


--
-- Name: resource_role_provenance resource_role_provenance_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_role_provenance
    ADD CONSTRAINT resource_role_provenance_pkey PRIMARY KEY (route, occurrence);


--
-- Name: standing_parent_installation standing_parent_installation_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.standing_parent_installation
    ADD CONSTRAINT standing_parent_installation_erasure_key_key UNIQUE (erasure_key);


--
-- Name: standing_parent_installation standing_parent_installation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.standing_parent_installation
    ADD CONSTRAINT standing_parent_installation_pkey PRIMARY KEY (route, resource_id, actions);


--
-- Name: workflow_approval workflow_approval_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.workflow_approval
    ADD CONSTRAINT workflow_approval_pkey PRIMARY KEY (route, approval_id);


--
-- Name: write_rate_chunk write_rate_chunk_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.write_rate_chunk
    ADD CONSTRAINT write_rate_chunk_pkey PRIMARY KEY (route, identity_digest, operation_id, chunk_index);


--
-- Name: write_rate_counter write_rate_counter_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.write_rate_counter
    ADD CONSTRAINT write_rate_counter_pkey PRIMARY KEY (route, identity_digest, family);


--
-- Name: account_active_pages; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX account_active_pages ON access.account USING btree (route, account_id) WHERE ((state = 'active'::text) AND (NOT authn_fenced));


--
-- Name: account_agent_pages; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX account_agent_pages ON access.account USING btree (route, account_id) WHERE ((state = 'active'::text) AND (NOT authn_fenced) AND (handle IS NOT NULL));


--
-- Name: account_discovery_claim_intent_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX account_discovery_claim_intent_account ON access.account_discovery_claim_intent USING btree (account_id, route);


--
-- Name: account_discovery_intent_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX account_discovery_intent_account ON access.account_discovery_intent USING btree (account_id, route);


--
-- Name: agent_identity_decision_original; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX agent_identity_decision_original ON access.agent_verification_request USING btree (route, account_id, decision_receipt_id) WHERE (decision_receipt_id IS NOT NULL);


--
-- Name: agent_verification_account_latest_idx; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX agent_verification_account_latest_idx ON access.agent_verification_request USING btree (route, account_id, created_at DESC, request_id DESC);


--
-- Name: agent_verification_active_account_idx; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX agent_verification_active_account_idx ON access.agent_verification_request USING btree (route, account_id) WHERE (state = ANY (ARRAY['pending'::text, 'approving'::text]));


--
-- Name: agent_verification_pending_page_idx; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX agent_verification_pending_page_idx ON access.agent_verification_request USING btree (route, created_at, request_id) WHERE (state = 'pending'::text);


--
-- Name: auth_erasure_bootstrap; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX auth_erasure_bootstrap ON access.erasure USING btree (route, account_id) WHERE (NOT auth_obligation_indexed);


--
-- Name: auth_erasure_original_floor; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX auth_erasure_original_floor ON access.lifecycle_fence_receipt USING btree (route, account_id, kind) INCLUDE (receipt_id, minimum_authn_epoch, transaction_id) WHERE (kind = 'tombstone'::text);


--
-- Name: auth_erasure_pending; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX auth_erasure_pending ON access.auth_erasure_obligation USING btree (partition_no, ordinal) WHERE (minimum_authn_epoch IS NULL);


--
-- Name: committed_continuation_auth_source; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_auth_source ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id) WHERE (allowlist @> '[{"step": "erase-auth-owner"}]'::jsonb);


--
-- Name: committed_continuation_barrier; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_barrier ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id);


--
-- Name: committed_continuation_completion_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_completion_erasure_row ON access.committed_continuation_completion USING btree (route, erasure_row_id);


--
-- Name: committed_continuation_entry_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_entry_erasure_row ON access.committed_continuation_entry USING btree (route, erasure_row_id);


--
-- Name: committed_continuation_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_erasure_row ON access.committed_continuation USING btree (route, erasure_row_id);


--
-- Name: committed_continuation_operator_latest; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX committed_continuation_operator_latest ON access.committed_continuation USING btree (route, account_id, minimum_authn_epoch DESC) WHERE (allowlist @> '[{"step": "operator-responsibility-page"}]'::jsonb);


--
-- Name: current_resource_role_due_source; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX current_resource_role_due_source ON access.current_resource_role_due USING btree (interval_key);


--
-- Name: current_resource_role_due_work; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX current_resource_role_due_work ON access.current_resource_role_due USING btree (due_at, route, resource_id, interval_key);


--
-- Name: current_resource_role_key_source; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX current_resource_role_key_source ON access.current_resource_role_key USING btree (interval_key);


--
-- Name: erasure_account_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_account_id ON access.account USING btree (account_id, route);


--
-- Name: erasure_account_controller_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_controller_id ON access.account USING btree (controller_id, route, account_id);


--
-- Name: erasure_account_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_operator_account_id ON access.account USING btree (operator_account_id, route, account_id);


--
-- Name: erasure_account_preferences_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_preferences_account_id ON access.account_preferences USING btree (account_id, route);


--
-- Name: erasure_agent_identity_intent_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_intent_account_id ON access.agent_identity_intent USING btree (account_id, route, direction, receipt_id);


--
-- Name: erasure_agent_identity_intent_decided_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_intent_decided_by ON access.agent_identity_intent USING btree (decided_by, route, account_id, direction, receipt_id);


--
-- Name: erasure_agent_identity_intent_requested_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_intent_requested_by ON access.agent_identity_intent USING btree (requested_by, route, account_id, direction, receipt_id);


--
-- Name: erasure_agent_identity_recovery_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_recovery_account_id ON access.agent_identity_recovery USING btree (account_id, route, direction, receipt_id);


--
-- Name: erasure_agent_identity_recovery_decided_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_recovery_decided_by ON access.agent_identity_recovery USING btree (decided_by, route, account_id, direction, receipt_id);


--
-- Name: erasure_agent_identity_recovery_requested_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_recovery_requested_by ON access.agent_identity_recovery USING btree (requested_by, route, account_id, direction, receipt_id);


--
-- Name: erasure_agent_identity_reversal_settlement_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_reversal_settlement_account ON access.agent_identity_reversal_settlement USING btree (account_id, route, reversal_receipt_id);


--
-- Name: erasure_agent_identity_technical_role_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_technical_role_account ON access.agent_identity_technical_role USING btree (role_account_id, route, account_id, direction, receipt_id);


--
-- Name: erasure_agent_identity_technical_role_owner; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_technical_role_owner ON access.agent_identity_technical_role USING btree (account_id, route, direction, receipt_id, role_account_id);


--
-- Name: erasure_agent_identity_technical_source_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_identity_technical_source_account ON access.agent_identity_technical_source USING btree (account_id, route, direction, receipt_id);


--
-- Name: erasure_agent_page_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_page_account_id ON access.agent_page USING btree (account_id, route, subject_id);


--
-- Name: erasure_agent_verification_request_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_verification_request_account_id ON access.agent_verification_request USING btree (account_id, route, request_id);


--
-- Name: erasure_agent_verification_request_decided_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_verification_request_decided_by ON access.agent_verification_request USING btree (decided_by, route, request_id);


--
-- Name: erasure_agent_verification_request_requested_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_verification_request_requested_by ON access.agent_verification_request USING btree (requested_by, route, request_id);


--
-- Name: erasure_committed_continuation_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_committed_continuation_account_id ON access.committed_continuation USING btree (account_id, route, continuation_id);


--
-- Name: erasure_committed_continuation_prior_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_committed_continuation_prior_operator_account_id ON access.committed_continuation USING btree (prior_operator_account_id, route, continuation_id);


--
-- Name: erasure_continuation_barrier; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_continuation_barrier ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id);


--
-- Name: erasure_continuation_reservation; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_continuation_reservation ON access.committed_continuation USING btree (route, account_id, prior_reservation_id, prior_operator_account_id);


--
-- Name: erasure_credential_floor_receipt_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_credential_floor_receipt_account_id ON access.credential_floor_receipt USING btree (account_id, route, opening_receipt_id);


--
-- Name: erasure_erasure_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_erasure_account_id ON access.erasure USING btree (account_id, route);


--
-- Name: erasure_erasure_acknowledgement_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_erasure_acknowledgement_account_id ON access.erasure_acknowledgement USING btree (account_id, route, participant);


--
-- Name: erasure_governance_bootstrap_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_governance_bootstrap_account_id ON access.governance_bootstrap USING btree (account_id, route, resource_id);


--
-- Name: erasure_governance_reach_actor_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_governance_reach_actor_account_id ON access.governance_reach USING btree (actor_account_id, route, transaction_id, action, resource_id);


--
-- Name: erasure_governance_reach_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_governance_reach_resource_id ON access.governance_reach USING btree (resource_id, route, transaction_id, action);


--
-- Name: erasure_handle_claim_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_handle_claim_account_id ON access.handle_claim USING btree (account_id, route, normalized_handle);


--
-- Name: erasure_handle_unfinished; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_handle_unfinished ON access.lifecycle_handle_operation USING btree (account_id, route, operation_id) WHERE (state = 'published'::text);


--
-- Name: erasure_late_item_open; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_late_item_open ON access.erasure_late_item USING btree (route, account_id) WHERE (resolved_at IS NULL);


--
-- Name: erasure_lifecycle_coordination_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_coordination_account_id ON access.lifecycle_coordination USING btree (account_id, route, reservation_id);


--
-- Name: erasure_lifecycle_coordination_related_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_coordination_related_account_id ON access.lifecycle_coordination USING btree (related_account_id, route, account_id, reservation_id);


--
-- Name: erasure_lifecycle_fence_receipt_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_fence_receipt_account_id ON access.lifecycle_fence_receipt USING btree (account_id, route, receipt_id);


--
-- Name: erasure_lifecycle_fence_receipt_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_fence_receipt_operator_account_id ON access.lifecycle_fence_receipt USING btree (operator_account_id, route, account_id, receipt_id);


--
-- Name: erasure_lifecycle_fence_receipt_prior_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_fence_receipt_prior_operator_account_id ON access.lifecycle_fence_receipt USING btree (prior_operator_account_id, route, account_id, receipt_id);


--
-- Name: erasure_lifecycle_handle_effect_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_handle_effect_account_id ON access.lifecycle_handle_effect USING btree (account_id, route, normalized_handle, reservation_id, operation_id, effect);


--
-- Name: erasure_lifecycle_handle_operation_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_handle_operation_account_id ON access.lifecycle_handle_operation USING btree (account_id, route, operation_id);


--
-- Name: erasure_lifecycle_membership_slot_member_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_membership_slot_member_account_id ON access.lifecycle_membership_slot USING btree (member_account_id, route, organization_id, reservation_id);


--
-- Name: erasure_lifecycle_membership_slot_organization_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_membership_slot_organization_id ON access.lifecycle_membership_slot USING btree (organization_id, route, member_account_id, reservation_id);


--
-- Name: erasure_lifecycle_registration_expiry_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_registration_expiry_account_id ON access.lifecycle_registration_expiry USING btree (account_id, route, reservation_id);


--
-- Name: erasure_locator_work_open; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_locator_work_open ON access.erasure_locator_work USING btree (opened_at) WHERE ((state <> 'done'::text) AND (state <> 'resolved'::text));


--
-- Name: erasure_member_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_member_id_approval ON access.workflow_approval USING btree (erasure_member_id, route, approval_id);


--
-- Name: erasure_membership_inverse_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_account_id ON access.membership_inverse USING btree (account_id, route, kind, group_id);


--
-- Name: erasure_membership_inverse_group_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_group_id ON access.membership_inverse USING btree (group_id, route, account_id, kind);


--
-- Name: erasure_membership_inverse_terminal_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_terminal_account_id ON access.membership_inverse_terminal USING btree (account_id, route, kind, group_id, reservation_id);


--
-- Name: erasure_membership_inverse_terminal_group_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_terminal_group_id ON access.membership_inverse_terminal USING btree (group_id, route, account_id, kind, reservation_id);


--
-- Name: erasure_opening_principal; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_opening_principal ON access.operator_opening_receipt USING btree (erasure_principal_id, route, operator_account_id, receipt_id);


--
-- Name: erasure_operator_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_id_approval ON access.workflow_approval USING btree (erasure_operator_id, route, approval_id);


--
-- Name: erasure_operator_opening_receipt_acting_human_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_opening_receipt_acting_human_id ON access.operator_opening_receipt USING btree (acting_human_id, route, operator_account_id, receipt_id);


--
-- Name: erasure_operator_opening_receipt_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_opening_receipt_operator_account_id ON access.operator_opening_receipt USING btree (operator_account_id, route, receipt_id);


--
-- Name: erasure_operator_opening_receipt_subject_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_opening_receipt_subject_account_id ON access.operator_opening_receipt USING btree (subject_account_id, route, operator_account_id, receipt_id);


--
-- Name: erasure_operator_relation_slot_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_relation_slot_operator_account_id ON access.operator_relation_slot USING btree (operator_account_id, route, subject_account_id, reservation_id);


--
-- Name: erasure_operator_relation_slot_subject_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_relation_slot_subject_account_id ON access.operator_relation_slot USING btree (subject_account_id, route, reservation_id);


--
-- Name: erasure_organization_close_organization_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_organization_close_organization_id ON access.organization_close USING btree (organization_id, route);


--
-- Name: erasure_organization_member_member_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_organization_member_member_account_id ON access.organization_member USING btree (member_account_id, route, organization_id, valid);


--
-- Name: erasure_organization_member_organization_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_organization_member_organization_id ON access.organization_member USING btree (organization_id, route, member_account_id, valid);


--
-- Name: erasure_previous_operator_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_previous_operator_id_approval ON access.workflow_approval USING btree (erasure_previous_operator_id, route, approval_id);


--
-- Name: erasure_previous_subject_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_previous_subject_id_approval ON access.workflow_approval USING btree (erasure_previous_subject_id, route, approval_id);


--
-- Name: erasure_principal_assignment_assigned_actor_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_assignment_assigned_actor_id ON access.principal_assignment USING btree (assigned_actor_id, route, principal_id, request_id);


--
-- Name: erasure_principal_assignment_creator_principal_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_assignment_creator_principal_id ON access.principal_assignment USING btree (creator_principal_id, route, principal_id, request_id);


--
-- Name: erasure_principal_assignment_principal_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_assignment_principal_id ON access.principal_assignment USING btree (principal_id, route, request_id);


--
-- Name: erasure_principal_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_id_approval ON access.workflow_approval USING btree (erasure_principal_id, route, approval_id);


--
-- Name: erasure_rating_counter_controller_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_rating_counter_controller_account_id ON access.rating_counter_controller USING btree (account_id, route, effective_at);


--
-- Name: erasure_rating_counter_controller_controller_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_rating_counter_controller_controller_id ON access.rating_counter_controller USING btree (controller_id, route, account_id, effective_at);


--
-- Name: erasure_resource_denial_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_denial_resource_id ON access.resource_denial USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_resource_denial_subject_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_denial_subject_id ON access.resource_denial USING btree (subject_id, route, erasure_key);


--
-- Name: erasure_resource_grant_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_grant_resource_id ON access.resource_grant USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_resource_grant_subject_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_grant_subject_id ON access.resource_grant USING btree (subject_id, route, erasure_key) WHERE (subject_kind = 'identity'::text);


--
-- Name: erasure_resource_initialization_creator_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_initialization_creator_id ON access.resource_initialization USING btree (creator_id, route, resource_id);


--
-- Name: erasure_resource_initialization_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_initialization_resource_id ON access.resource_initialization USING btree (resource_id, route);


--
-- Name: erasure_resource_role_grant_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_role_grant_resource_id ON access.resource_role_grant USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_resource_role_grant_subject_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_role_grant_subject_id ON access.resource_role_grant USING btree (subject_id, route, erasure_key) WHERE (subject_kind = 'identity'::text);


--
-- Name: erasure_standing_parent_installation_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_standing_parent_installation_resource_id ON access.standing_parent_installation USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_subject_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_subject_id_approval ON access.workflow_approval USING btree (erasure_subject_id, route, approval_id);


--
-- Name: erasure_workflow_approval_actor_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_workflow_approval_actor_id ON access.workflow_approval USING btree (actor_id, route, approval_id);


--
-- Name: erasure_write_rate_chunk_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_write_rate_chunk_account ON access.write_rate_chunk USING btree (account_id, route, identity_digest, operation_id, chunk_index);


--
-- Name: erasure_write_rate_counter_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_write_rate_counter_account ON access.write_rate_counter USING btree (account_id, route, identity_digest, family);


--
-- Name: lifecycle_coordination_purpose_page; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX lifecycle_coordination_purpose_page ON access.lifecycle_coordination USING btree (route, account_id, purpose, reservation_id);


--
-- Name: lifecycle_membership_live; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX lifecycle_membership_live ON access.lifecycle_membership_slot USING btree (route, organization_id, member_account_id) WHERE (NOT terminal);


--
-- Name: live_copy_business_inventory_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX live_copy_business_inventory_account ON access.live_copy_business_inventory USING btree (account_id, route, kind, locator);


--
-- Name: live_copy_gate_applying; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX live_copy_gate_applying ON access.live_copy_gate USING btree (route, applying_transaction) WHERE (outcome = 'applying'::text);


--
-- Name: live_copy_hold_pending; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX live_copy_hold_pending ON access.live_copy_hold USING btree (route, account_id, reservation_id) WHERE (result_id IS NULL);


--
-- Name: live_copy_inventory_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX live_copy_inventory_account ON access.live_copy_inventory USING btree (account_id, route, item, source_domain, transition_id);


--
-- Name: live_copy_order_pending; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX live_copy_order_pending ON access.live_copy_transition USING btree (route, ((effect_key ->> 'orderId'::text))) WHERE ((module = 'commerce.creator-sale'::text) AND (state = 'pending'::text));


--
-- Name: live_copy_transition_pending; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX live_copy_transition_pending ON access.live_copy_transition USING btree (route, next_run, transition_id) WHERE (state = 'pending'::text);


--
-- Name: operator_fence_page_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX operator_fence_page_erasure_row ON access.operator_fence_page USING btree (route, erasure_row_id);


--
-- Name: organization_member_change; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_change ON access.organization_member USING btree (route, organization_id, member_account_id, transaction_id);


--
-- Name: organization_member_cleanup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_cleanup ON access.organization_member USING btree (route, organization_id, member_account_id, valid);


--
-- Name: organization_member_next_role; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_next_role ON access.organization_member USING btree (route, organization_id, member_account_id, role, lower(valid)) WHERE (NOT lower_inf(valid));


--
-- Name: organization_member_owner_probe; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_owner_probe ON access.organization_member USING gist (route, organization_id, valid) WHERE (role = 'owner'::text);


--
-- Name: organization_member_row_key; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX organization_member_row_key ON access.organization_member USING btree (route, organization_id, row_key);


--
-- Name: principal_assignment_speakers; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX principal_assignment_speakers ON access.principal_assignment USING btree (route, principal_id, assigned_actor_id, COALESCE(lower(valid), '-infinity'::timestamp with time zone)) INCLUDE (valid) WHERE (revoked_at IS NULL);


--
-- Name: realm_claim_current_owner; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX realm_claim_current_owner ON access.resource_role_grant USING gist (route, resource_id, valid) WHERE ((subject_kind = 'identity'::text) AND (subject_role = ''::text) AND (grant_role = 'community.realm.owner'::text));


--
-- Name: realm_erasure_succession_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX realm_erasure_succession_account ON access.realm_erasure_succession USING btree (account_id, route, resource_id);


--
-- Name: realm_erasure_succession_candidate; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX realm_erasure_succession_candidate ON access.realm_erasure_succession USING btree (best_account_id, route, resource_id, account_id) WHERE (best_account_id IS NOT NULL);


--
-- Name: realm_erasure_succession_cursor; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX realm_erasure_succession_cursor ON access.realm_erasure_succession USING btree (cursor_subject_id, route, resource_id, account_id) WHERE (cursor_subject_id IS NOT NULL);


--
-- Name: realm_membership_reconciliation_pending; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX realm_membership_reconciliation_pending ON access.realm_membership_reconciliation_item USING btree (route, account_id, barrier_id, reservation_id) WHERE (state = ANY (ARRAY['pending'::text, 'uncertain'::text]));


--
-- Name: realm_membership_transition_open; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX realm_membership_transition_open ON access.realm_membership_transition USING btree (route, account_id, realm_id) WHERE (proof_transaction_id IS NULL);


--
-- Name: realm_owner_continuity; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX realm_owner_continuity ON access.resource_role_grant USING gist (route, resource_id, valid) INCLUDE (subject_id) WHERE ((subject_kind = 'identity'::text) AND (subject_role = ''::text) AND (grant_role = 'community.realm.owner'::text) AND upper_inf(valid));


--
-- Name: resource_denial_open; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX resource_denial_open ON access.resource_denial USING btree (route, resource_id, subject_id, subject_role, action, reason) WHERE upper_inf(valid);


--
-- Name: resource_denial_permission; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_denial_permission ON access.resource_denial USING gist (route, resource_id, action, subject_id, subject_role, valid);


--
-- Name: resource_grant_pkey_lookup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_grant_pkey_lookup ON access.resource_grant USING btree (subject_kind, subject_id, subject_role, action, valid) INCLUDE (route, resource_id) WHERE ((route = 0) AND (resource_id = '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: resource_grant_point_lookup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_grant_point_lookup ON access.resource_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, action, valid);


--
-- Name: resource_role_grant_open; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX resource_role_grant_open ON access.resource_role_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, grant_role) WHERE upper_inf(valid);


--
-- Name: resource_role_grant_point_lookup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_role_grant_point_lookup ON access.resource_role_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid);


--
-- Name: resource_role_grant_predecessor; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_role_grant_predecessor ON access.resource_role_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, grant_role, COALESCE(lower(valid), '-infinity'::timestamp with time zone)) INCLUDE (valid);


--
-- Name: resource_role_provenance_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_role_provenance_account ON access.resource_role_provenance USING btree (route, account_id, occurrence);


--
-- Name: resource_role_provenance_delivery; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_role_provenance_delivery ON access.resource_role_provenance USING btree (route, occurrence) WHERE (delivery = 'pending'::text);


--
-- Name: workflow_approval_expiry; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX workflow_approval_expiry ON access.workflow_approval USING btree (route, expires_at, approval_id);


--
-- Name: write_rate_chunk_expiry; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX write_rate_chunk_expiry ON access.write_rate_chunk USING btree (route, expires_at, identity_digest, operation_id, chunk_index);


--
-- Name: write_rate_counter_expiry; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX write_rate_counter_expiry ON access.write_rate_counter USING btree (route, expires_at, identity_digest, family);


--
-- Name: account account_creation_time; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_creation_time BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_account_creation_time();


--
-- Name: account account_discovery_after; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_after AFTER INSERT OR DELETE OR UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.account_discovery_after();


--
-- Name: account account_discovery_before; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_before BEFORE INSERT OR DELETE OR UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.account_discovery_before();


--
-- Name: handle_claim account_discovery_claim_after; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_claim_after AFTER INSERT OR DELETE OR UPDATE ON access.handle_claim FOR EACH ROW EXECUTE FUNCTION access.account_discovery_claim_after();


--
-- Name: handle_claim account_discovery_claim_before; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_claim_before BEFORE INSERT OR DELETE OR UPDATE ON access.handle_claim FOR EACH ROW EXECUTE FUNCTION access.account_discovery_claim_before();


--
-- Name: handle_claim account_discovery_claim_truncate; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_claim_truncate AFTER TRUNCATE ON access.handle_claim FOR EACH STATEMENT EXECUTE FUNCTION access.account_discovery_truncate();


--
-- Name: account_preferences account_discovery_preferences; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_preferences AFTER INSERT OR DELETE OR UPDATE ON access.account_preferences FOR EACH ROW EXECUTE FUNCTION access.account_discovery_preferences();


--
-- Name: account account_discovery_truncate; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_discovery_truncate AFTER TRUNCATE ON access.account FOR EACH STATEMENT EXECUTE FUNCTION access.account_discovery_truncate();


--
-- Name: account account_identity; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_identity BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_account_identity();


--
-- Name: account account_membership_inverse; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_membership_inverse BEFORE INSERT ON access.account FOR EACH ROW EXECUTE FUNCTION access.initialize_membership_inverse();


--
-- Name: account account_public_change; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_public_change BEFORE INSERT OR UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.record_public_account_change();


--
-- Name: agent_identity_intent agent_identity_intent_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER agent_identity_intent_immutable BEFORE DELETE OR UPDATE ON access.agent_identity_intent FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_intent();

ALTER TABLE access.agent_identity_intent ENABLE ALWAYS TRIGGER agent_identity_intent_immutable;


--
-- Name: agent_identity_intent agent_identity_intent_native_commit; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_identity_intent_native_commit AFTER INSERT ON access.agent_identity_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_agent_identity_intent();


--
-- Name: agent_identity_recovery agent_identity_recovery_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER agent_identity_recovery_immutable BEFORE DELETE OR UPDATE ON access.agent_identity_recovery FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_intent();

ALTER TABLE access.agent_identity_recovery ENABLE ALWAYS TRIGGER agent_identity_recovery_immutable;


--
-- Name: agent_identity_recovery agent_identity_recovery_insert_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER agent_identity_recovery_insert_guard BEFORE INSERT ON access.agent_identity_recovery FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_recovery_insert();

ALTER TABLE access.agent_identity_recovery ENABLE ALWAYS TRIGGER agent_identity_recovery_insert_guard;


--
-- Name: agent_identity_recovery agent_identity_recovery_native_commit; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_identity_recovery_native_commit AFTER INSERT ON access.agent_identity_recovery DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_agent_identity_recovery();


--
-- Name: principal_assignment assignment_identity; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER assignment_identity BEFORE INSERT OR UPDATE ON access.principal_assignment FOR EACH ROW EXECUTE FUNCTION access.guard_assignment_identity();


--
-- Name: auth_erasure_cut auth_erasure_cut_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_cut_guard BEFORE DELETE OR UPDATE ON access.auth_erasure_cut FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_cut_guard();


--
-- Name: auth_erasure_cut_partition auth_erasure_cut_partition_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_cut_partition_immutable BEFORE DELETE OR UPDATE ON access.auth_erasure_cut_partition FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();


--
-- Name: erasure auth_erasure_index_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_index_guard BEFORE INSERT OR UPDATE ON access.erasure FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_index_guard();


--
-- Name: auth_erasure_obligation auth_erasure_live_enrollment; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_live_enrollment AFTER INSERT ON access.auth_erasure_obligation FOR EACH ROW EXECUTE FUNCTION access.enroll_auth_erasure_live();


--
-- Name: auth_erasure_live_partition auth_erasure_live_partition_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_live_partition_guard BEFORE INSERT OR DELETE OR UPDATE ON access.auth_erasure_live_partition FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_live_partition_guard();


--
-- Name: auth_erasure_live_receiver auth_erasure_live_receiver_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_live_receiver_immutable BEFORE DELETE OR UPDATE ON access.auth_erasure_live_receiver FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();


--
-- Name: auth_erasure_live_subscription auth_erasure_live_subscription_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_live_subscription_guard BEFORE INSERT ON access.auth_erasure_live_subscription FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_live_subscription_guard();


--
-- Name: auth_erasure_live_subscription auth_erasure_live_subscription_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_live_subscription_immutable BEFORE DELETE OR UPDATE ON access.auth_erasure_live_subscription FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();


--
-- Name: auth_erasure_obligation auth_erasure_obligation_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_obligation_immutable BEFORE DELETE OR UPDATE ON access.auth_erasure_obligation FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();


--
-- Name: erasure auth_erasure_producer; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER auth_erasure_producer AFTER INSERT ON access.erasure DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_producer();


--
-- Name: auth_erasure_source auth_erasure_source_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_erasure_source_guard BEFORE DELETE OR UPDATE ON access.auth_erasure_source FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_source_guard();


--
-- Name: auth_history_proof auth_history_proof_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_history_proof_immutable BEFORE DELETE OR UPDATE ON access.auth_history_proof FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();


--
-- Name: auth_receiving_closure auth_receiving_closure_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_closure_immutable BEFORE DELETE OR UPDATE ON access.auth_receiving_closure FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();


--
-- Name: auth_receiving_closure auth_receiving_closure_insert_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_closure_insert_guard BEFORE INSERT ON access.auth_receiving_closure FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_closure_insert_guard();


--
-- Name: auth_receiving_control auth_receiving_control_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_control_guard BEFORE INSERT OR DELETE OR UPDATE ON access.auth_receiving_control FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_control_guard();


--
-- Name: auth_receiving_control auth_receiving_control_source_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_control_source_guard BEFORE INSERT ON access.auth_receiving_control FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_control_source_guard();


--
-- Name: auth_receiving_obligation auth_receiving_obligation_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_obligation_guard BEFORE INSERT OR DELETE OR UPDATE ON access.auth_receiving_obligation FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_obligation_guard();


--
-- Name: auth_receiving_obligation auth_receiving_obligation_root_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_obligation_root_guard BEFORE INSERT ON access.auth_receiving_obligation FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_obligation_root_guard();


--
-- Name: lifecycle_fence_receipt auth_receiving_witness; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_receiving_witness BEFORE DELETE ON access.lifecycle_fence_receipt FOR EACH ROW EXECUTE FUNCTION access.guard_auth_receiving_witness();


--
-- Name: committed_continuation_completion committed_continuation_completion_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER committed_continuation_completion_immutable BEFORE DELETE OR UPDATE ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();


--
-- Name: committed_continuation_entry committed_continuation_entry_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER committed_continuation_entry_immutable BEFORE DELETE OR UPDATE ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();


--
-- Name: committed_continuation committed_continuation_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER committed_continuation_immutable BEFORE UPDATE ON access.committed_continuation FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_immutable();


--
-- Name: resource_role_grant context_directory_owner_dirty; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER context_directory_owner_dirty AFTER INSERT OR DELETE OR UPDATE ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_owner_dirty();


--
-- Name: resource_role_grant current_resource_role_writer; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER current_resource_role_writer AFTER INSERT OR DELETE OR UPDATE ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION access.capture_current_resource_role();


--
-- Name: erasure_acknowledgement erasure_acknowledgement_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER erasure_acknowledgement_guard BEFORE DELETE OR UPDATE ON access.erasure_acknowledgement FOR EACH ROW EXECUTE FUNCTION access.guard_erasure_acknowledgement();


--
-- Name: erasure erasure_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER erasure_guard BEFORE DELETE OR UPDATE ON access.erasure FOR EACH ROW EXECUTE FUNCTION access.guard_erasure();


--
-- Name: account follow_count_new_account; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER follow_count_new_account AFTER INSERT ON access.account FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_owner();


--
-- Name: handle_claim guard_retired_handle; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER guard_retired_handle BEFORE INSERT OR DELETE OR UPDATE ON access.handle_claim FOR EACH ROW EXECUTE FUNCTION access.guard_retired_handle();


--
-- Name: auth_history_proof history_auth_changed; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER history_auth_changed AFTER INSERT ON access.auth_history_proof FOR EACH ROW EXECUTE FUNCTION core.history_auth_changed();


--
-- Name: agent_identity_reversal_settlement identity_reversal_settlement_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER identity_reversal_settlement_immutable BEFORE DELETE OR UPDATE ON access.agent_identity_reversal_settlement FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();


--
-- Name: agent_identity_reversal_settlement identity_reversal_settlement_native_commit; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_reversal_settlement_native_commit AFTER INSERT ON access.agent_identity_reversal_settlement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_identity_reversal_settlement();


--
-- Name: agent_identity_reversal_settlement identity_reversal_settlement_no_truncate; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER identity_reversal_settlement_no_truncate BEFORE TRUNCATE ON access.agent_identity_reversal_settlement FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();


--
-- Name: agent_identity_technical_role identity_technical_role_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER identity_technical_role_immutable BEFORE DELETE OR UPDATE ON access.agent_identity_technical_role FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();


--
-- Name: agent_identity_technical_role identity_technical_role_no_truncate; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER identity_technical_role_no_truncate BEFORE TRUNCATE ON access.agent_identity_technical_role FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();


--
-- Name: agent_identity_technical_source identity_technical_source_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER identity_technical_source_immutable BEFORE DELETE OR UPDATE ON access.agent_identity_technical_source FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();


--
-- Name: agent_identity_technical_source identity_technical_source_native_commit; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_technical_source_native_commit AFTER INSERT ON access.agent_identity_technical_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_identity_technical_source();


--
-- Name: agent_identity_technical_source identity_technical_source_no_truncate; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER identity_technical_source_no_truncate BEFORE TRUNCATE ON access.agent_identity_technical_source FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();


--
-- Name: lifecycle_membership_slot lifecycle_membership_terminal_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER lifecycle_membership_terminal_guard BEFORE DELETE OR UPDATE ON access.lifecycle_membership_slot FOR EACH ROW WHEN (old.terminal) EXECUTE FUNCTION access.guard_membership_terminal();


--
-- Name: account lifecycle_responsibility; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER lifecycle_responsibility BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_lifecycle_responsibility();


--
-- Name: account live_copy_account_delete_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_account_delete_guard BEFORE DELETE ON access.account FOR EACH ROW EXECUTE FUNCTION access.live_copy_account_delete_guard();


--
-- Name: live_copy_business_inventory live_copy_business_inventory_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_business_inventory_guard BEFORE INSERT ON access.live_copy_business_inventory FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_inventory();


--
-- Name: lifecycle_coordination live_copy_coordination_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_coordination_guard BEFORE INSERT OR DELETE OR UPDATE ON access.lifecycle_coordination FOR EACH ROW EXECUTE FUNCTION access.live_copy_coordination_guard();


--
-- Name: live_copy_domain live_copy_domain_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_domain_guard BEFORE INSERT OR DELETE OR UPDATE ON access.live_copy_domain FOR EACH ROW EXECUTE FUNCTION access.preserve_live_copy_domain();


--
-- Name: live_copy_gate live_copy_gate_commit; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER live_copy_gate_commit AFTER INSERT OR UPDATE ON access.live_copy_gate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.live_copy_gate_commit();


--
-- Name: live_copy_gate live_copy_gate_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_gate_guard BEFORE DELETE OR UPDATE ON access.live_copy_gate FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_gate();


--
-- Name: live_copy_hold live_copy_hold_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_hold_guard BEFORE INSERT OR DELETE OR UPDATE ON access.live_copy_hold FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_hold();


--
-- Name: live_copy_inventory live_copy_inventory_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_inventory_guard BEFORE INSERT ON access.live_copy_inventory FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_inventory();


--
-- Name: live_copy_role_gate live_copy_role_gate_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_role_gate_guard BEFORE DELETE OR UPDATE ON access.live_copy_role_gate FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_role_gate();


--
-- Name: live_copy_seal live_copy_seal_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_seal_guard BEFORE DELETE OR UPDATE ON access.live_copy_seal FOR EACH ROW EXECUTE FUNCTION access.preserve_live_copy_seal();


--
-- Name: live_copy_transition live_copy_transition_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER live_copy_transition_guard BEFORE DELETE OR UPDATE ON access.live_copy_transition FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_transition();


--
-- Name: membership_inverse membership_inverse_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER membership_inverse_guard BEFORE DELETE OR UPDATE ON access.membership_inverse FOR EACH ROW EXECUTE FUNCTION access.guard_membership_inverse();


--
-- Name: membership_inverse_terminal membership_inverse_terminal_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER membership_inverse_terminal_guard BEFORE DELETE OR UPDATE ON access.membership_inverse_terminal FOR EACH ROW EXECUTE FUNCTION access.guard_membership_terminal();


--
-- Name: committed_continuation native_continuation_delete; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_continuation_delete BEFORE DELETE ON access.committed_continuation FOR EACH ROW EXECUTE FUNCTION access.guard_native_continuation_delete();


--
-- Name: committed_continuation_completion native_erasure_replay; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();


--
-- Name: committed_continuation_entry native_erasure_replay; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();


--
-- Name: operator_fence_page native_erasure_replay; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();


--
-- Name: committed_continuation native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: committed_continuation_completion native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: committed_continuation_entry native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: operator_fence_page native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: account native_source_account_writer; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_source_account_writer AFTER INSERT OR DELETE OR UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();


--
-- Name: operator_fence_page operator_fence_page_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER operator_fence_page_immutable BEFORE DELETE OR UPDATE ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.operator_fence_page_immutable();


--
-- Name: account operator_relation_version; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER operator_relation_version BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.advance_operator_relation();


--
-- Name: account rating_controller; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER rating_controller AFTER INSERT OR UPDATE OF operator_account_id ON access.account FOR EACH ROW EXECUTE FUNCTION access.record_rating_controller();


--
-- Name: realm_erasure_succession realm_erasure_succession_custody; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER realm_erasure_succession_custody BEFORE DELETE OR UPDATE ON access.realm_erasure_succession FOR EACH ROW EXECUTE FUNCTION access.guard_realm_erasure_succession();


--
-- Name: realm_membership_transition realm_membership_transition_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER realm_membership_transition_guard BEFORE DELETE OR UPDATE ON access.realm_membership_transition FOR EACH ROW EXECUTE FUNCTION access.guard_realm_membership_transition();


--
-- Name: resource_role_provenance resource_role_provenance_deliver; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER resource_role_provenance_deliver AFTER INSERT ON access.resource_role_provenance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.deliver_resource_role_provenance();


--
-- Name: resource_role_provenance resource_role_provenance_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER resource_role_provenance_immutable BEFORE UPDATE ON access.resource_role_provenance FOR EACH ROW EXECUTE FUNCTION access.guard_resource_role_provenance();


--
-- Name: resource_role_grant resource_role_provenance_new; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER resource_role_provenance_new AFTER INSERT ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION access.capture_resource_role_provenance();


--
-- Name: resource_role_grant resource_role_provenance_old; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER resource_role_provenance_old BEFORE DELETE ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION access.capture_resource_role_provenance();


--
-- Name: resource_role_grant semantic_resource_role_erasure; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER semantic_resource_role_erasure AFTER INSERT OR UPDATE ON access.resource_role_grant DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_resource_role_erasure();


--
-- Name: workflow_approval workflow_approval_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON access.workflow_approval FOR EACH ROW EXECUTE FUNCTION access.workflow_approval_immutable();


--
-- Name: account_discovery_claim_cursor account_discovery_claim_cursor_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_discovery_claim_cursor
    ADD CONSTRAINT account_discovery_claim_cursor_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id) ON DELETE CASCADE;


--
-- Name: agent_identity_recovery agent_identity_recovery_route_account_id_direction_receipt_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_recovery
    ADD CONSTRAINT agent_identity_recovery_route_account_id_direction_receipt_fkey FOREIGN KEY (route, account_id, direction, receipt_id) REFERENCES access.agent_identity_intent(route, account_id, direction, receipt_id);


--
-- Name: agent_identity_technical_role agent_identity_technical_role_route_account_id_direction_r_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_identity_technical_role
    ADD CONSTRAINT agent_identity_technical_role_route_account_id_direction_r_fkey FOREIGN KEY (route, account_id, direction, receipt_id) REFERENCES access.agent_identity_technical_source(route, account_id, direction, receipt_id);


--
-- Name: auth_erasure_cut_partition auth_erasure_cut_partition_cut_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_cut_partition
    ADD CONSTRAINT auth_erasure_cut_partition_cut_id_fkey FOREIGN KEY (cut_id) REFERENCES access.auth_erasure_cut(cut_id);


--
-- Name: auth_erasure_cut_partition auth_erasure_cut_partition_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_cut_partition
    ADD CONSTRAINT auth_erasure_cut_partition_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES access.auth_erasure_source(partition_no);


--
-- Name: auth_erasure_live_partition auth_erasure_live_partition_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_partition
    ADD CONSTRAINT auth_erasure_live_partition_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES access.auth_erasure_source(partition_no);


--
-- Name: auth_erasure_live_receiver auth_erasure_live_receiver_cut_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_receiver
    ADD CONSTRAINT auth_erasure_live_receiver_cut_id_fkey FOREIGN KEY (cut_id) REFERENCES access.auth_erasure_cut(cut_id);


--
-- Name: auth_erasure_live_subscription auth_erasure_live_subscription_cut_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_subscription
    ADD CONSTRAINT auth_erasure_live_subscription_cut_id_fkey FOREIGN KEY (cut_id) REFERENCES access.auth_erasure_live_receiver(cut_id);


--
-- Name: auth_erasure_live_subscription auth_erasure_live_subscription_cut_id_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_subscription
    ADD CONSTRAINT auth_erasure_live_subscription_cut_id_partition_no_fkey FOREIGN KEY (cut_id, partition_no) REFERENCES access.auth_erasure_cut_partition(cut_id, partition_no);


--
-- Name: auth_erasure_live_subscription auth_erasure_live_subscription_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_live_subscription
    ADD CONSTRAINT auth_erasure_live_subscription_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES access.auth_erasure_live_partition(partition_no);


--
-- Name: auth_erasure_obligation auth_erasure_obligation_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_erasure_obligation
    ADD CONSTRAINT auth_erasure_obligation_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: auth_history_proof auth_history_proof_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_history_proof
    ADD CONSTRAINT auth_history_proof_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: auth_receiving_closure auth_receiving_closure_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_closure
    ADD CONSTRAINT auth_receiving_closure_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.auth_receiving_obligation(route, account_id);


--
-- Name: auth_receiving_control auth_receiving_control_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_control
    ADD CONSTRAINT auth_receiving_control_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES access.auth_erasure_source(partition_no);


--
-- Name: auth_receiving_obligation auth_receiving_obligation_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_obligation
    ADD CONSTRAINT auth_receiving_obligation_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES access.auth_receiving_control(partition_no);


--
-- Name: auth_receiving_obligation auth_receiving_obligation_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_receiving_obligation
    ADD CONSTRAINT auth_receiving_obligation_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: committed_continuation committed_continuation_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation
    ADD CONSTRAINT committed_continuation_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id);


--
-- Name: current_resource_role_due current_resource_role_due_interval_key_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.current_resource_role_due
    ADD CONSTRAINT current_resource_role_due_interval_key_fkey FOREIGN KEY (interval_key) REFERENCES access.resource_role_grant(erasure_key) ON DELETE CASCADE;


--
-- Name: current_resource_role_key current_resource_role_key_interval_key_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.current_resource_role_key
    ADD CONSTRAINT current_resource_role_key_interval_key_fkey FOREIGN KEY (interval_key) REFERENCES access.resource_role_grant(erasure_key) ON DELETE CASCADE;


--
-- Name: erasure_acknowledgement erasure_acknowledgement_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_acknowledgement
    ADD CONSTRAINT erasure_acknowledgement_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure_late_item erasure_late_item_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_late_item
    ADD CONSTRAINT erasure_late_item_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure_native_blocked erasure_native_blocked_progress_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_blocked
    ADD CONSTRAINT erasure_native_blocked_progress_id_fkey FOREIGN KEY (progress_id) REFERENCES access.erasure_native_progress(progress_id);


--
-- Name: erasure_native_consumed_child erasure_native_consumed_child_progress_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_consumed_child
    ADD CONSTRAINT erasure_native_consumed_child_progress_id_fkey FOREIGN KEY (progress_id) REFERENCES access.erasure_native_progress(progress_id);


--
-- Name: erasure_native_progress erasure_native_progress_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_progress
    ADD CONSTRAINT erasure_native_progress_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure_progress erasure_progress_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_progress
    ADD CONSTRAINT erasure_progress_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure erasure_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure
    ADD CONSTRAINT erasure_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id);


--
-- Name: live_copy_bootstrap live_copy_bootstrap_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_bootstrap
    ADD CONSTRAINT live_copy_bootstrap_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: live_copy_domain live_copy_domain_partition_no_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.live_copy_domain
    ADD CONSTRAINT live_copy_domain_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: operator_fence_page operator_fence_page_route_continuation_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_fence_page
    ADD CONSTRAINT operator_fence_page_route_continuation_id_fkey FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation(route, continuation_id);


--
-- PostgreSQL database dump complete
--


