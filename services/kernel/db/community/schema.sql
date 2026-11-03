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
-- Name: community; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA community;


--
-- Name: advance_publication_population(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.advance_publication_population() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE community.realm SET publication_generation = publication_generation + 1
    WHERE route = COALESCE(NEW.route, OLD.route)
      AND realm_id = COALESCE(NEW.realm_id, OLD.realm_id);
  RETURN NULL;
END;
$$;


--
-- Name: advance_realm_discovery_epoch(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.advance_realm_discovery_epoch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.discovery_epoch_started_at := NEW.created_at;
  ELSIF (NEW.visibility, NEW.state, NEW.space_id) IS DISTINCT FROM
        (OLD.visibility, OLD.state, OLD.space_id) THEN
    NEW.discovery_epoch := OLD.discovery_epoch + 1;
    IF NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id THEN
      -- Native visibility changes append this exact revision at command T.
      SELECT r.created_at INTO STRICT NEW.discovery_epoch_started_at
      FROM community.realm_revision r
      WHERE r.route = NEW.route AND r.realm_id = NEW.realm_id
        AND r.revision_id = NEW.head_revision_id;
    ELSE
      NEW.discovery_epoch_started_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: append_realm_discovery_change(integer, uuid, bigint, jsonb); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.append_realm_discovery_change(source_route integer, source_realm uuid, source_epoch bigint, change_value jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  prior bigint;
  native_transaction uuid;
BEGIN
  -- Installed only by bindRealmDiscoveryCommand's native executor callback.
  native_transaction := NULLIF(current_setting('rezics.discovery_transaction_id', true), '')::uuid;
  IF native_transaction IS NULL THEN
    RAISE EXCEPTION 'Realm discovery native command binding unavailable';
  END IF;
  SELECT discovery_generation INTO STRICT prior FROM community.realm
    WHERE route = source_route AND realm_id = source_realm FOR UPDATE;
  INSERT INTO community.realm_discovery_change
    (route,realm_id,realm_epoch,generation,previous_generation,transaction_id,value)
    VALUES (source_route,source_realm,source_epoch,prior+1,prior,native_transaction,change_value);
  UPDATE community.realm SET discovery_generation = prior+1
    WHERE route = source_route AND realm_id = source_realm;
END;
$$;


--
-- Name: change_realm_member_count(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.change_realm_member_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; id uuid; k bigint; delta integer:=0; h timestamptz:='-infinity'; c community.realm_member_count;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'member_count_key') IS NOT DISTINCT FROM
      (to_jsonb(OLD)-'member_count_key') THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN r:=OLD.route; id:=OLD.realm_id; k:=OLD.member_count_key;
  ELSE r:=NEW.route; id:=NEW.realm_id; k:=NEW.member_count_key; END IF;
  SELECT * INTO STRICT c FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  IF TG_OP<>'INSERT' THEN
    IF OLD.role='member' AND upper_inf(OLD.valid) THEN delta:=delta-1; END IF;
    h:=GREATEST(h,COALESCE(lower(OLD.valid),'-infinity'),COALESCE(upper(OLD.valid),'-infinity'));
  END IF;
  IF TG_OP<>'DELETE' THEN
    IF NEW.role='member' AND upper_inf(NEW.valid) THEN delta:=delta+1; END IF;
    h:=GREATEST(h,COALESCE(lower(NEW.valid),'-infinity'),COALESCE(upper(NEW.valid),'-infinity'));
  END IF;
  -- The unvisited part of the finite cut is read in its current state later.
  -- Already seeded keys and post-cut keys receive their actual delta exactly once.
  IF NOT c.keyed OR (NOT c.initialized AND k>c.cursor AND k<=c.frontier) THEN delta:=0; END IF;
  UPDATE community.realm_member_count SET count=count+delta,version=version+1,horizon=GREATEST(horizon,h)
  WHERE route=r AND realm_id=id;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


--
-- Name: change_space_discovery_dependencies(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.change_space_discovery_dependencies() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM community.refresh_space_discovery_dependencies(
    COALESCE(NEW.route,OLD.route),COALESCE(NEW.space_id,OLD.space_id));
  RETURN NULL;
END;
$$;


--
-- Name: create_realm_member_count(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.create_realm_member_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM community.ensure_realm_member_count(NEW.route,NEW.realm_id);
  UPDATE community.realm_member_count SET horizon=GREATEST(horizon,NEW.created_at)
  WHERE route=NEW.route AND realm_id=NEW.realm_id;
  RETURN NEW;
END;
$$;


--
-- Name: ensure_realm_member_count(integer, uuid); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.ensure_realm_member_count(r integer, id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE cut bigint; until_at timestamptz; has_unkeyed boolean;
BEGIN
  -- Exact indexed endpoints, including explicit infinite timestamps. Such an
  -- unsupported upper frontier stays unknown instead of pretending it elapsed.
  SELECT COALESCE((SELECT member_count_key FROM community.realm_member
    WHERE route=r AND realm_id=id AND upper_inf(valid) AND member_count_key IS NOT NULL
    ORDER BY member_count_key DESC LIMIT 1),0) INTO cut;
  SELECT COALESCE((SELECT upper(valid) FROM community.realm_member
    WHERE route=r AND realm_id=id AND NOT upper_inf(valid)
    ORDER BY upper(valid) DESC LIMIT 1),'-infinity'::timestamptz) INTO until_at;
  SELECT EXISTS(SELECT 1 FROM community.realm_member WHERE route=r AND realm_id=id
    AND upper_inf(valid) AND member_count_key IS NULL LIMIT 1) INTO has_unkeyed;
  INSERT INTO community.realm_member_count(route,realm_id,frontier,keyed,initialized,horizon)
  VALUES(r,id,cut,NOT has_unkeyed,cut=0 AND NOT has_unkeyed,until_at) ON CONFLICT(route,realm_id) DO NOTHING;
END;
$$;


--
-- Name: fence_realm_discovery_epoch(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.fence_realm_discovery_epoch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN NEW;
END;
$$;


--
-- Name: fence_space_realm_discovery(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.fence_space_realm_discovery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    UPDATE community.realm SET discovery_epoch = discovery_epoch + 1,
      discovery_epoch_started_at = clock_timestamp()
    WHERE route = NEW.route AND space_id = NEW.space_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_publication(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.actor IS NOT NULL AND NEW.actor IS NULL
     AND (to_jsonb(NEW) - 'actor') = (to_jsonb(OLD) - 'actor') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Publication records are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_publication_head(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_publication_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.subject_id)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.subject_id) THEN
    RAISE EXCEPTION 'Publication slot identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Realm identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm_member_count_truncate(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_member_count_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Membership removal requires covered row changes' USING ERRCODE='23514';
END;
$$;


--
-- Name: guard_realm_member_terminal(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_member_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('community.member_erasure_account', true) = OLD.account_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Realm membership terminal slots are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_realm_membership_operation(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_membership_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  attribution text[] := ARRAY['member_account_id', 'initiator_account_id', 'original_operator_account_id',
    'actor_client_id', 'actor_scopes', 'actor_requested_by', 'actor_authn_epoch',
    'original_minimum_authn_epoch', 'original_delegation_transaction_id', 'original_delegation_issued_valid'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - attribution) = (to_jsonb(OLD) - attribution)
     AND (NEW.member_account_id IS NULL OR NEW.member_account_id = OLD.member_account_id)
     AND (NEW.initiator_account_id IS NULL OR NEW.initiator_account_id = OLD.initiator_account_id)
     AND (NEW.original_operator_account_id IS NULL OR NEW.original_operator_account_id = OLD.original_operator_account_id)
     AND NEW.actor_client_id IS NULL AND NEW.actor_scopes IS NULL AND NEW.actor_requested_by IS NULL
     AND NEW.actor_authn_epoch IS NULL AND NEW.original_minimum_authn_epoch IS NULL
     AND NEW.original_delegation_transaction_id IS NULL AND NEW.original_delegation_issued_valid IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Realm membership operations are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_realm_orphan_deadline(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_orphan_deadline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.ownership_state = 'orphaned' AND NEW.ownership_state = 'orphaned'
     AND ROW(NEW.orphaned_at, NEW.claim_eligible_at) IS DISTINCT FROM ROW(OLD.orphaned_at, OLD.claim_eligible_at) THEN
    RAISE EXCEPTION 'An orphaned Realm retains its original claim deadline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm_revision(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('community.erasure_account', true) = OLD.author::text
       AND NEW.title = '' AND NEW.summary = ''
       AND (to_jsonb(NEW) - 'title' - 'summary') = (to_jsonb(OLD) - 'title' - 'summary')
       AND EXISTS (SELECT 1 FROM community.realm
                   WHERE route = OLD.route AND realm_id = OLD.realm_id
                     AND head_revision_id <> OLD.revision_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Realm revisions are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_space(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Space identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_space_revision(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_space_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('community.erasure_account', true) = OLD.author::text
       AND NEW.title = '' AND NEW.summary = ''
       AND (to_jsonb(NEW) - 'title' - 'summary') = (to_jsonb(OLD) - 'title' - 'summary')
       AND EXISTS (SELECT 1 FROM community.space
                   WHERE route = OLD.route AND space_id = OLD.space_id
                     AND head_revision_id <> OLD.revision_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Space revisions are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: immutable_realm_discovery_change(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.immutable_realm_discovery_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Realm discovery changes are append-only';
END;
$$;


--
-- Name: inherit_realm_board_scheme(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.inherit_realm_board_scheme() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT board_scheme_id INTO NEW.board_scheme_id
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;


--
-- Name: inherit_realm_votes(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.inherit_realm_votes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT votes INTO NEW.votes
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;


--
-- Name: lock_realm_member_count(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.lock_realm_member_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ((NEW.route,NEW.realm_id) IS DISTINCT FROM (OLD.route,OLD.realm_id)
      OR (OLD.member_count_key IS NOT NULL AND NEW.member_count_key IS DISTINCT FROM OLD.member_count_key)) THEN
    RAISE EXCEPTION 'Membership source key is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN r:=OLD.route; id:=OLD.realm_id;
  ELSE r:=NEW.route; id:=NEW.realm_id; END IF;
  -- Fast path avoids endpoint probes for every covered source change.
  PERFORM 1 FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM community.ensure_realm_member_count(r,id);
    PERFORM 1 FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.member_count_key IS NULL AND upper_inf(NEW.valid) THEN
    NEW.member_count_key:=nextval('community.realm_member_count_key');
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: log_realm_discovery_board(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.log_realm_discovery_board() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.realm_epoch,
    jsonb_build_object('kind','board','boardId',NEW.board_id,
      'sourceVersion',NEW.source_version::text,'published',NEW.published));
  RETURN NEW;
END;
$$;


--
-- Name: log_realm_discovery_epoch(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.log_realm_discovery_epoch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.discovery_epoch,
    jsonb_build_object('kind','epoch'));
  RETURN NEW;
END;
$$;


--
-- Name: log_realm_discovery_gate(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.log_realm_discovery_gate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_epoch bigint;
  settled boolean;
BEGIN
  SELECT discovery_epoch INTO STRICT current_epoch FROM community.realm
    WHERE route = NEW.route AND realm_id = NEW.realm_id FOR UPDATE;
  SELECT NOT EXISTS (SELECT 1 FROM community.realm_discovery_fence
    WHERE route = NEW.route AND realm_id = NEW.realm_id AND realm_epoch = current_epoch AND outcome IS NULL)
    INTO settled;
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, current_epoch,
    jsonb_build_object('kind','gate','settled',settled));
  RETURN NEW;
END;
$$;


--
-- Name: log_realm_discovery_thread(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.log_realm_discovery_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.space_id IS NULL THEN
    RAISE EXCEPTION 'Realm discovery original Space binding unavailable';
  END IF;
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.realm_epoch,
    jsonb_build_object('kind','thread','source',jsonb_build_object(
      'realmId',NEW.realm_id,'realmEpoch',NEW.realm_epoch::text,'spaceId',NEW.space_id,
      'boardId',NEW.board_id,'threadId',NEW.thread_id,'sourceRoute',NEW.source_route,
      'creationDay',to_char(NEW.creation_day,'YYYY-MM-DD'),'sourceVersion',NEW.source_version::text,
      'contributing',NEW.contributing)));
  RETURN NEW;
END;
$$;


--
-- Name: maintain_space_discovery_population(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.maintain_space_discovery_population() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE community.space_discovery_population SET population = population +
    CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END
    WHERE partition_no = (COALESCE(NEW.route, OLD.route) >> 4);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Space discovery census is unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: realm_presentation_allowed(jsonb); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_presentation_allowed(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE key text; ref jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR
     NOT value ?& ARRAY['avatarMediaId','bannerMediaId','rules'] OR
     (SELECT count(*) FROM jsonb_object_keys(value)) <> 3 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['avatarMediaId','bannerMediaId'] LOOP
    ref := value -> key;
    IF ref <> 'null'::jsonb AND (jsonb_typeof(ref) <> 'string' OR
      (ref #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  END LOOP;
  ref := value -> 'rules';
  IF ref = 'null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(ref) <> 'object' OR NOT ref ?& ARRAY['postId','revisionId'] OR
     (SELECT count(*) FROM jsonb_object_keys(ref)) <> 2 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['postId','revisionId'] LOOP
    IF jsonb_typeof(ref -> key) <> 'string' OR (ref ->> key) !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$_$;


--
-- Name: realm_revision_votes(integer, uuid, uuid); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_revision_votes(route integer, realm_id uuid, revision_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  found jsonb;
BEGIN
  SELECT revision.votes INTO found
  FROM community.realm_revision AS revision
  WHERE revision.route = realm_revision_votes.route
    AND revision.realm_id = realm_revision_votes.realm_id
    AND revision.revision_id = realm_revision_votes.revision_id;
  RETURN found;
END;
$$;


--
-- Name: realm_votes_allowed(jsonb); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_votes_allowed(votes jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN votes IS NULL OR jsonb_typeof(votes) <> 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(votes)) > 7 THEN false
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_each(votes) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'])
         OR jsonb_typeof(entry.value) <> 'number'
         OR (entry.value <> '1'::jsonb AND entry.value <> '-1'::jsonb)
    ) THEN false
    ELSE true
  END;
$$;


--
-- Name: record_member_locator_pending(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.record_member_locator_pending() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('community.member_erasure_account', true) IS DISTINCT FROM NEW.account_id::text THEN
    INSERT INTO community.member_locator_pending (account_id, route, realm_id, transaction_id)
    VALUES (NEW.account_id, NEW.route, NEW.realm_id, NEW.transaction_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: refresh_space_discovery_dependencies(integer, uuid); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.refresh_space_discovery_dependencies(r integer, id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE dependencies jsonb[] := ARRAY[
  '{"kind":"exposure","group":"search"}'::jsonb,
  '{"kind":"exposure","group":"search_advanced"}'::jsonb
]; carried record;
BEGIN
  -- Serialize initialization and native changes on the retained owner, including
  -- removed owners. An old seed cannot replace a concurrently committed head.
  PERFORM 1 FROM community.space WHERE route=r AND space_id=id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT h.context_id, v.presentation INTO carried
    FROM community.realm h JOIN community.realm_revision v
      ON v.route=h.route AND v.realm_id=h.realm_id AND v.revision_id=h.head_revision_id
    WHERE h.route=r AND h.space_id=id;
  IF FOUND THEN
    dependencies := array_append(dependencies,
      jsonb_build_object('kind','context','id',carried.context_id));
    IF carried.presentation->>'avatarMediaId' IS NOT NULL THEN
      dependencies := array_append(dependencies,
        jsonb_build_object('kind','media','id',carried.presentation->>'avatarMediaId'));
    END IF;
  END IF;
  DELETE FROM community.space_discovery_dependency
    WHERE route=r AND space_id=id AND NOT (dependency=ANY(dependencies));
  INSERT INTO community.space_discovery_dependency(dependency,route,space_id)
    SELECT d,r,id FROM unnest(dependencies) d ON CONFLICT DO NOTHING;
END;
$$;


--
-- Name: reset_space_discovery_population(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.reset_space_discovery_population() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE community.space_discovery_population SET population = 0;
  RETURN NULL;
END;
$$;


--
-- Name: seed_realm_member_count(integer, uuid); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.seed_realm_member_count(r integer, id uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE c community.realm_member_count; n integer; last_key bigint; added bigint; h timestamptz; source_key uuid;
BEGIN
  SELECT * INTO STRICT c FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  IF c.initialized THEN RETURN false; END IF;
  IF NOT c.keyed THEN
    -- Install positions only on fifty raw current source keys. Existing closed
    -- histories remain untouched. This stores no account-bearing seed cursor.
    n:=0;
    FOR source_key IN
      SELECT account_id FROM community.realm_member
      WHERE route=r AND realm_id=id AND upper_inf(valid) AND member_count_key IS NULL
      ORDER BY account_id LIMIT 50
    LOOP
      n:=n+1;
      UPDATE community.realm_member SET member_count_key=nextval('community.realm_member_count_key')
      WHERE route=r AND realm_id=id AND account_id=source_key AND upper_inf(valid) AND member_count_key IS NULL;
    END LOOP;
    IF n<50 THEN
      SELECT COALESCE((SELECT member_count_key FROM community.realm_member
        WHERE route=r AND realm_id=id AND upper_inf(valid) AND member_count_key IS NOT NULL
        ORDER BY member_count_key DESC LIMIT 1),0) INTO last_key;
      UPDATE community.realm_member_count SET keyed=true,frontier=last_key,initialized=last_key=0
      WHERE route=r AND realm_id=id;
    END IF;
    RETURN true;
  END IF;
  WITH raw AS MATERIALIZED (
    SELECT member_count_key,role,valid FROM community.realm_member
    WHERE route=r AND realm_id=id AND upper_inf(valid)
      AND member_count_key>c.cursor AND member_count_key<=c.frontier
    ORDER BY member_count_key LIMIT 50
  ) SELECT count(*)::integer, max(member_count_key),
      count(*) FILTER (WHERE role='member'),max(lower(valid))
    INTO n,last_key,added,h FROM raw;
  UPDATE community.realm_member_count SET count=count+added,
    cursor=CASE WHEN n<50 THEN frontier ELSE last_key END,
    initialized=n<50, horizon=GREATEST(horizon,COALESCE(h,'-infinity'))
  WHERE route=r AND realm_id=id;
  RETURN n=50;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_erasure_progress; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.account_erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    step bigint DEFAULT 0 NOT NULL,
    phase text NOT NULL,
    cursor jsonb,
    erased_at timestamp with time zone NOT NULL,
    community_found boolean DEFAULT false NOT NULL,
    phase_pending boolean DEFAULT false NOT NULL,
    reasons_kept_until timestamp with time zone,
    rating_had_votes boolean DEFAULT false NOT NULL,
    CONSTRAINT account_erasure_progress_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_erasure_progress_erased_at_check CHECK (isfinite(erased_at)),
    CONSTRAINT account_erasure_progress_phase_check CHECK ((phase = ANY (ARRAY['close'::text, 'memberships'::text, 'revisions'::text, 'records'::text, 'notices'::text, 'rating'::text, 'proof'::text, 'complete'::text]))),
    CONSTRAINT account_erasure_progress_reasons_kept_until_check CHECK (((reasons_kept_until IS NULL) OR isfinite(reasons_kept_until))),
    CONSTRAINT account_erasure_progress_step_check CHECK ((step >= 0))
);


--
-- Name: discovery_anchor; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_anchor (
    route integer NOT NULL,
    publication_epoch bigint DEFAULT 1 NOT NULL,
    CONSTRAINT discovery_anchor_publication_epoch_check CHECK ((publication_epoch > 0)),
    CONSTRAINT discovery_anchor_route_check CHECK ((route = 0))
);


--
-- Name: discovery_board; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_board (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch text NOT NULL,
    board_id uuid NOT NULL,
    source_version text NOT NULL,
    published boolean NOT NULL,
    CONSTRAINT discovery_board_route_check CHECK ((route = 0))
);


--
-- Name: discovery_bucket; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_bucket (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch text NOT NULL,
    board_id uuid NOT NULL,
    creation_day date NOT NULL,
    count bigint NOT NULL,
    CONSTRAINT discovery_bucket_count_check CHECK ((count >= 0)),
    CONSTRAINT discovery_bucket_route_check CHECK ((route = 0))
);


--
-- Name: discovery_day; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_day (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    creation_day date NOT NULL,
    count bigint NOT NULL,
    CONSTRAINT discovery_day_count_check CHECK ((count >= 0)),
    CONSTRAINT discovery_day_route_check CHECK ((route = 0))
);


--
-- Name: discovery_due; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_due (
    route integer NOT NULL,
    kind text NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch text NOT NULL,
    key uuid NOT NULL,
    day date NOT NULL,
    due_at timestamp with time zone NOT NULL,
    CONSTRAINT discovery_due_due_at_check CHECK (isfinite(due_at)),
    CONSTRAINT discovery_due_kind_check CHECK ((kind = ANY (ARRAY['realm'::text, 'bucket'::text, 'thread'::text, 'board'::text]))),
    CONSTRAINT discovery_due_route_check CHECK ((route = 0))
);


--
-- Name: discovery_realm; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_realm (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch text NOT NULL,
    applied_generation bigint NOT NULL,
    settled boolean DEFAULT false NOT NULL,
    cutoff date NOT NULL,
    popular bigint DEFAULT 0 NOT NULL,
    trending bigint DEFAULT 0 NOT NULL,
    CONSTRAINT discovery_realm_applied_generation_check CHECK ((applied_generation >= 0)),
    CONSTRAINT discovery_realm_popular_check CHECK ((popular >= 0)),
    CONSTRAINT discovery_realm_route_check CHECK ((route = 0)),
    CONSTRAINT discovery_realm_trending_check CHECK ((trending >= 0))
);


--
-- Name: discovery_thread; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.discovery_thread (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch text NOT NULL,
    thread_id uuid NOT NULL,
    board_id uuid NOT NULL,
    space_id uuid NOT NULL,
    source_route integer NOT NULL,
    creation_day date NOT NULL,
    source_version text NOT NULL,
    contributing boolean NOT NULL,
    CONSTRAINT discovery_thread_route_check CHECK ((route = 0))
);


--
-- Name: erasure_fence; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.erasure_fence (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT erasure_fence_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT erasure_fence_closed_at_check CHECK (((closed_at IS NULL) OR isfinite(closed_at)))
);


--
-- Name: member_locator; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.member_locator (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    realm_route integer NOT NULL,
    realm_id uuid NOT NULL,
    CONSTRAINT member_locator_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT member_locator_check1 CHECK ((realm_route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT member_locator_realm_route_check CHECK (((realm_route >= 0) AND (realm_route <= 65535))),
    CONSTRAINT member_locator_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: member_locator_pending; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.member_locator_pending (
    account_id uuid NOT NULL,
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT member_locator_pending_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT member_locator_pending_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: party_locator; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.party_locator (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    owner_route integer NOT NULL,
    owner_id uuid NOT NULL,
    key text NOT NULL,
    CONSTRAINT party_locator_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT party_locator_check1 CHECK ((owner_route = ((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)))),
    CONSTRAINT party_locator_due_at_check CHECK (isfinite(due_at)),
    CONSTRAINT party_locator_key_check CHECK (((char_length(key) >= 1) AND (char_length(key) <= 100))),
    CONSTRAINT party_locator_kind_check CHECK ((kind = ANY (ARRAY['ban_target'::text, 'ban_actor'::text, 'membership_operation'::text, 'verdict'::text, 'claim_request'::text, 'space_remover'::text, 'realm_remover'::text]))),
    CONSTRAINT party_locator_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT party_locator_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: publication; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.publication (
    route integer NOT NULL,
    publication_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    verdict text NOT NULL,
    predecessor uuid,
    subject_revision_id uuid,
    actor uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT publication_check CHECK ((predecessor <> publication_id)),
    CONSTRAINT publication_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT publication_check2 CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT publication_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT publication_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT publication_verdict_check CHECK ((verdict = ANY (ARRAY['adopt'::text, 'reject'::text, 'withdraw'::text])))
);


--
-- Name: publication_head; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.publication_head (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    verdict text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    CONSTRAINT publication_head_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT publication_head_check1 CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT publication_head_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT publication_head_verdict_check CHECK ((verdict = ANY (ARRAY['adopt'::text, 'reject'::text, 'withdraw'::text])))
);


--
-- Name: realm; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    state text NOT NULL,
    visibility text NOT NULL,
    context_id uuid NOT NULL,
    head_revision_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    creator uuid NOT NULL,
    board_scheme_id uuid,
    votes jsonb DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb NOT NULL,
    discovery_epoch bigint DEFAULT 1 NOT NULL,
    discovery_epoch_started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ownership_state text DEFAULT 'owned'::text NOT NULL,
    orphaned_at timestamp with time zone,
    claim_eligible_at timestamp with time zone,
    discovery_generation bigint DEFAULT 0 NOT NULL,
    lifecycle_version bigint DEFAULT 0 NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    remover_role text,
    removal_reason text,
    publication_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT realm_board_scheme_id_check CHECK (((board_scheme_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_check CHECK ((realm_id <> space_id)),
    CONSTRAINT realm_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT realm_check2 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_check3 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT realm_discovery_epoch_check CHECK ((discovery_epoch > 0)),
    CONSTRAINT realm_discovery_generation_check CHECK ((discovery_generation >= 0)),
    CONSTRAINT realm_lifecycle_version_check CHECK ((lifecycle_version >= 0)),
    CONSTRAINT realm_ownership_check CHECK ((((ownership_state = 'owned'::text) AND (orphaned_at IS NULL) AND (claim_eligible_at IS NULL)) OR ((ownership_state = 'orphaned'::text) AND (orphaned_at IS NOT NULL) AND (claim_eligible_at IS NOT NULL) AND isfinite(orphaned_at) AND (claim_eligible_at = (orphaned_at + '720:00:00'::interval))))),
    CONSTRAINT realm_publication_generation_check CHECK ((publication_generation >= 0)),
    CONSTRAINT realm_removal_check CHECK ((((removed_at IS NULL) AND (removed_by IS NULL) AND (remover_role IS NULL) AND (removal_reason IS NULL) AND (state = 'active'::text)) OR ((removed_at IS NOT NULL) AND (remover_role IS NOT NULL)))),
    CONSTRAINT realm_removal_reason_check CHECK (((char_length(removal_reason) >= 1) AND (char_length(removal_reason) <= 1024))),
    CONSTRAINT realm_remover_role_check CHECK ((remover_role = ANY (ARRAY['owner'::text, 'moderator'::text]))),
    CONSTRAINT realm_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_state_check CHECK ((state = ANY (ARRAY['active'::text, 'removed'::text]))),
    CONSTRAINT realm_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'protected'::text]))),
    CONSTRAINT realm_votes_check CHECK (community.realm_votes_allowed(votes))
);


--
-- Name: realm_ban; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_ban (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    valid tstzrange NOT NULL,
    reason text NOT NULL,
    actor uuid,
    transaction_id uuid NOT NULL,
    CONSTRAINT realm_ban_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_ban_reason_check CHECK ((char_length(reason) <= 1024)),
    CONSTRAINT realm_ban_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_ban_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: realm_claim_request; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_claim_request (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    request_id uuid NOT NULL,
    account_id uuid NOT NULL,
    orphaned_at timestamp with time zone NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    approved_at timestamp with time zone,
    CONSTRAINT realm_claim_request_approval_check CHECK ((((state = 'pending'::text) AND (approved_at IS NULL)) OR ((state = 'approved'::text) AND (approved_at IS NOT NULL) AND isfinite(approved_at) AND (approved_at >= requested_at)))),
    CONSTRAINT realm_claim_request_check CHECK ((route = ((get_byte(uuid_send(request_id), 10) * 256) + get_byte(uuid_send(request_id), 11)))),
    CONSTRAINT realm_claim_request_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text])))
);


--
-- Name: realm_discovery_board; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_discovery_board (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch bigint NOT NULL,
    board_id uuid NOT NULL,
    source_version bigint NOT NULL,
    published boolean NOT NULL,
    CONSTRAINT realm_discovery_board_source_version_check CHECK ((source_version > 0))
);


--
-- Name: realm_discovery_change; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_discovery_change (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch bigint NOT NULL,
    generation bigint NOT NULL,
    previous_generation bigint NOT NULL,
    transaction_id uuid NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT realm_discovery_change_check CHECK ((generation = (previous_generation + 1))),
    CONSTRAINT realm_discovery_change_generation_check CHECK ((generation > 0)),
    CONSTRAINT realm_discovery_change_previous_generation_check CHECK ((previous_generation >= 0)),
    CONSTRAINT realm_discovery_change_realm_epoch_check CHECK ((realm_epoch > 0)),
    CONSTRAINT realm_discovery_change_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_discovery_change_value_check CHECK (((jsonb_typeof(value) = 'object'::text) AND ((value ->> 'kind'::text) = ANY (ARRAY['thread'::text, 'board'::text, 'epoch'::text, 'gate'::text]))))
);


--
-- Name: realm_discovery_fence; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_discovery_fence (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch bigint NOT NULL,
    source_route integer NOT NULL,
    intent text NOT NULL,
    generation bigint NOT NULL,
    fence_generation bigint NOT NULL,
    outcome text,
    outcome_transaction_id uuid,
    CONSTRAINT realm_discovery_fence_check CHECK (((outcome IS NULL) = (outcome_transaction_id IS NULL))),
    CONSTRAINT realm_discovery_fence_fence_generation_check CHECK ((fence_generation > 0)),
    CONSTRAINT realm_discovery_fence_generation_check CHECK ((generation > 0)),
    CONSTRAINT realm_discovery_fence_intent_check CHECK ((intent ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT realm_discovery_fence_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'aborted'::text]))),
    CONSTRAINT realm_discovery_fence_realm_epoch_check CHECK ((realm_epoch > 0)),
    CONSTRAINT realm_discovery_fence_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_discovery_fence_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535)))
);


--
-- Name: realm_discovery_source; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_discovery_source (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    realm_epoch bigint NOT NULL,
    source_route integer NOT NULL,
    thread_id uuid NOT NULL,
    board_id uuid NOT NULL,
    creation_day date NOT NULL,
    source_version bigint NOT NULL,
    contributing boolean NOT NULL,
    space_id uuid,
    CONSTRAINT realm_discovery_source_source_version_check CHECK ((source_version > 0))
);


--
-- Name: realm_member; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL,
    valid tstzrange NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    member_count_key bigint,
    CONSTRAINT realm_member_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_role_check CHECK ((role = 'member'::text)),
    CONSTRAINT realm_member_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_member_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: realm_member_count; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member_count (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    keyed boolean DEFAULT true NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    removal_coverage boolean DEFAULT true NOT NULL,
    cursor bigint DEFAULT 0 NOT NULL,
    frontier bigint NOT NULL,
    horizon timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    CONSTRAINT realm_member_count_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_count_check1 CHECK ((cursor <= frontier)),
    CONSTRAINT realm_member_count_check2 CHECK (((NOT initialized) OR keyed)),
    CONSTRAINT realm_member_count_count_check CHECK (((count >= 0) AND (count <= '9007199254740991'::bigint))),
    CONSTRAINT realm_member_count_cursor_check CHECK ((cursor >= 0)),
    CONSTRAINT realm_member_count_frontier_check CHECK ((frontier >= 0)),
    CONSTRAINT realm_member_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_member_count_version_check CHECK ((version >= 0))
);


--
-- Name: realm_member_count_install; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member_count_install (
    partition_no integer NOT NULL,
    cursor_route integer NOT NULL,
    cursor_id uuid NOT NULL,
    frontier_route integer NOT NULL,
    frontier_id uuid NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT realm_member_count_install_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: realm_member_count_key; Type: SEQUENCE; Schema: community; Owner: -
--

CREATE SEQUENCE community.realm_member_count_key
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: realm_member_count_key; Type: SEQUENCE OWNED BY; Schema: community; Owner: -
--

ALTER SEQUENCE community.realm_member_count_key OWNED BY community.realm_member.member_count_key;


--
-- Name: realm_member_terminal; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member_terminal (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT realm_member_terminal_at_check CHECK (isfinite(at)),
    CONSTRAINT realm_member_terminal_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_terminal_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: realm_membership_operation; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_membership_operation (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    member_account_id uuid,
    reservation_id uuid,
    ban_id uuid,
    initiator_account_id uuid,
    actor_client_id text,
    actor_scopes text[],
    actor_requested_by text,
    actor_authn_epoch bigint,
    requested_at timestamp with time zone NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    source_digest text NOT NULL,
    original_minimum_authn_epoch text,
    original_operator_account_id uuid,
    original_delegation_transaction_id uuid,
    original_delegation_issued_valid text,
    creation_command_kind text NOT NULL,
    creation_idempotency_key text NOT NULL,
    creation_request_digest text NOT NULL,
    creation_target_route integer NOT NULL,
    creation_target_id uuid NOT NULL,
    CONSTRAINT realm_membership_operation_actor_authn_epoch_check CHECK (((actor_authn_epoch >= 1) AND (actor_authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT realm_membership_operation_actor_client_id_check CHECK (((char_length(actor_client_id) >= 1) AND (char_length(actor_client_id) <= 1024))),
    CONSTRAINT realm_membership_operation_actor_requested_by_check CHECK ((actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_membership_operation_actor_scopes_check CHECK (((cardinality(actor_scopes) <= 512) AND ((cardinality(actor_scopes) = 0) OR (array_ndims(actor_scopes) = 1)))),
    CONSTRAINT realm_membership_operation_check CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT realm_membership_operation_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_membership_operation_check2 CHECK ((((kind = 'join'::text) AND (reservation_id IS NULL) AND (ban_id IS NULL)) OR ((kind = 'leave'::text) AND (reservation_id IS NOT NULL) AND (ban_id IS NULL) AND (member_account_id = initiator_account_id)) OR ((kind = 'removal'::text) AND (reservation_id IS NOT NULL) AND (ban_id IS NOT NULL)))),
    CONSTRAINT realm_membership_operation_check3 CHECK (((actor_requested_by IS NULL) = (original_delegation_transaction_id IS NULL))),
    CONSTRAINT realm_membership_operation_check4 CHECK (((original_delegation_transaction_id IS NULL) = (original_delegation_issued_valid IS NULL))),
    CONSTRAINT realm_membership_operation_creation_command_kind_check CHECK ((creation_command_kind ~ '^[!-~]{1,255}$'::text)),
    CONSTRAINT realm_membership_operation_creation_idempotency_key_check CHECK ((creation_idempotency_key ~ '^[!-~]{1,255}$'::text)),
    CONSTRAINT realm_membership_operation_creation_request_digest_check CHECK ((creation_request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT realm_membership_operation_creation_target_route_check CHECK (((creation_target_route >= 0) AND (creation_target_route <= 65535))),
    CONSTRAINT realm_membership_operation_kind_check CHECK ((kind = ANY (ARRAY['join'::text, 'leave'::text, 'removal'::text]))),
    CONSTRAINT realm_membership_operation_original_delegation_issued_val_check CHECK ((char_length(original_delegation_issued_valid) <= 256)),
    CONSTRAINT realm_membership_operation_original_minimum_authn_epoch_check CHECK ((original_minimum_authn_epoch ~ '^[1-9][0-9]{0,18}$'::text)),
    CONSTRAINT realm_membership_operation_requested_at_check CHECK (isfinite(requested_at)),
    CONSTRAINT realm_membership_operation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_membership_operation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: realm_membership_proof; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_membership_proof (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    operation_id text NOT NULL,
    outcome text NOT NULL,
    transaction_id uuid NOT NULL,
    publication_transaction_id uuid,
    principal_id uuid NOT NULL,
    command_kind text NOT NULL,
    command_key text NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT realm_membership_proof_at_check CHECK (isfinite(at)),
    CONSTRAINT realm_membership_proof_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_membership_proof_outcome_check CHECK ((outcome = ANY (ARRAY['published'::text, 'cancelled'::text])))
);


--
-- Name: realm_revision; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_revision (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    predecessor uuid,
    title text NOT NULL,
    summary text NOT NULL,
    visibility text NOT NULL,
    context_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    author uuid NOT NULL,
    board_scheme_id uuid,
    votes jsonb DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb NOT NULL,
    presentation jsonb DEFAULT '{"rules": null, "avatarMediaId": null, "bannerMediaId": null}'::jsonb NOT NULL,
    CONSTRAINT realm_revision_board_scheme_id_check CHECK (((board_scheme_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT realm_revision_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT realm_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT realm_revision_presentation_check CHECK (community.realm_presentation_allowed(presentation)),
    CONSTRAINT realm_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT realm_revision_title_check CHECK (((char_length(title) >= 0) AND (char_length(title) <= 1024))),
    CONSTRAINT realm_revision_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'protected'::text]))),
    CONSTRAINT realm_revision_votes_check CHECK (community.realm_votes_allowed(votes))
)
WITH (fillfactor='50');


--
-- Name: revision_locator; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.revision_locator (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL COLLATE pg_catalog."C",
    owner_route integer NOT NULL,
    owner_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    CONSTRAINT revision_locator_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT revision_locator_check1 CHECK ((owner_route = ((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)))),
    CONSTRAINT revision_locator_check2 CHECK ((owner_route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT revision_locator_kind_check CHECK ((kind = ANY (ARRAY['realm'::text, 'space'::text]))),
    CONSTRAINT revision_locator_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT revision_locator_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: space; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    state text NOT NULL,
    head_revision_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    creator uuid NOT NULL,
    lifecycle_version bigint DEFAULT 0 NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    remover_role text,
    removal_reason text,
    CONSTRAINT space_check CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_check1 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT space_lifecycle_version_check CHECK ((lifecycle_version >= 0)),
    CONSTRAINT space_removal_check CHECK ((((removed_at IS NULL) AND (removed_by IS NULL) AND (remover_role IS NULL) AND (removal_reason IS NULL) AND (state = 'active'::text)) OR ((removed_at IS NOT NULL) AND (remover_role IS NOT NULL)))),
    CONSTRAINT space_removal_reason_check CHECK (((char_length(removal_reason) >= 1) AND (char_length(removal_reason) <= 1024))),
    CONSTRAINT space_remover_role_check CHECK ((remover_role = ANY (ARRAY['owner'::text, 'moderator'::text]))),
    CONSTRAINT space_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_state_check CHECK ((state = ANY (ARRAY['active'::text, 'removed'::text])))
);


--
-- Name: space_address_claim; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_address_claim (
    route integer NOT NULL,
    normalized_address text NOT NULL COLLATE pg_catalog."C",
    space_id uuid NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    reservation_id uuid,
    transaction_id uuid NOT NULL,
    CONSTRAINT space_address_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_address, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_address, 'UTF8'::name)), 1)))),
    CONSTRAINT space_address_claim_check1 CHECK ((((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))),
    CONSTRAINT space_address_claim_normalized_address_check CHECK ((normalized_address ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT space_address_claim_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_address_claim_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])))
);


--
-- Name: space_discovery_dependency_key; Type: SEQUENCE; Schema: community; Owner: -
--

CREATE SEQUENCE community.space_discovery_dependency_key
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: space_discovery_dependency; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_discovery_dependency (
    dependency jsonb NOT NULL,
    route integer NOT NULL,
    space_id uuid NOT NULL,
    ordinal bigint DEFAULT nextval('community.space_discovery_dependency_key'::regclass) NOT NULL,
    CONSTRAINT space_discovery_dependency_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT space_discovery_dependency_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: space_discovery_dependency_install; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_discovery_dependency_install (
    partition_no integer NOT NULL,
    cursor_route integer NOT NULL,
    cursor_id uuid NOT NULL,
    cut_route integer NOT NULL,
    cut_id uuid NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT space_discovery_dependency_install_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: space_discovery_frontier; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_discovery_frontier (
    partition_no integer NOT NULL,
    obligation text NOT NULL,
    invalidation jsonb NOT NULL,
    state text DEFAULT 'preparing'::text NOT NULL,
    cut bigint,
    cursor bigint DEFAULT 0 NOT NULL,
    examined bigint DEFAULT 0 NOT NULL,
    CONSTRAINT space_discovery_frontier_check CHECK (((cursor >= 0) AND (examined >= 0) AND ((cut IS NULL) OR (cursor <= cut)))),
    CONSTRAINT space_discovery_frontier_check1 CHECK (((state <> ALL (ARRAY['draining'::text, 'settled'::text])) OR (cut IS NOT NULL))),
    CONSTRAINT space_discovery_frontier_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT space_discovery_frontier_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'unavailable'::text, 'draining'::text, 'settled'::text])))
);


--
-- Name: space_discovery_frontier_wake; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_discovery_frontier_wake (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    obligation text NOT NULL
);


--
-- Name: space_discovery_population; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_discovery_population (
    partition_no integer NOT NULL,
    population bigint NOT NULL,
    CONSTRAINT space_discovery_population_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT space_discovery_population_population_check CHECK ((population >= 0))
);


--
-- Name: space_revision; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_revision (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    predecessor uuid,
    title text NOT NULL,
    summary text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    author uuid NOT NULL,
    address text,
    CONSTRAINT space_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT space_revision_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT space_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT space_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT space_revision_title_check CHECK (((char_length(title) >= 0) AND (char_length(title) <= 1024)))
)
WITH (fillfactor='50');


--
-- Name: realm_member member_count_key; Type: DEFAULT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member ALTER COLUMN member_count_key SET DEFAULT nextval('community.realm_member_count_key'::regclass);


--
-- Name: account_erasure_progress account_erasure_progress_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.account_erasure_progress
    ADD CONSTRAINT account_erasure_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: discovery_anchor discovery_anchor_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_anchor
    ADD CONSTRAINT discovery_anchor_pkey PRIMARY KEY (route);


--
-- Name: discovery_board discovery_board_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_board
    ADD CONSTRAINT discovery_board_pkey PRIMARY KEY (route, realm_id, realm_epoch, board_id);


--
-- Name: discovery_bucket discovery_bucket_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_bucket
    ADD CONSTRAINT discovery_bucket_pkey PRIMARY KEY (route, realm_id, realm_epoch, board_id, creation_day);


--
-- Name: discovery_day discovery_day_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_day
    ADD CONSTRAINT discovery_day_pkey PRIMARY KEY (route, realm_id, creation_day);


--
-- Name: discovery_due discovery_due_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_due
    ADD CONSTRAINT discovery_due_pkey PRIMARY KEY (route, kind, realm_id, realm_epoch, key, day);


--
-- Name: discovery_realm discovery_realm_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_realm
    ADD CONSTRAINT discovery_realm_pkey PRIMARY KEY (route, realm_id);


--
-- Name: discovery_thread discovery_thread_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.discovery_thread
    ADD CONSTRAINT discovery_thread_pkey PRIMARY KEY (route, realm_id, realm_epoch, thread_id);


--
-- Name: erasure_fence erasure_fence_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.erasure_fence
    ADD CONSTRAINT erasure_fence_pkey PRIMARY KEY (route, account_id);


--
-- Name: member_locator_pending member_locator_pending_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.member_locator_pending
    ADD CONSTRAINT member_locator_pending_pkey PRIMARY KEY (account_id, route, realm_id, transaction_id);


--
-- Name: member_locator member_locator_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.member_locator
    ADD CONSTRAINT member_locator_pkey PRIMARY KEY (route, account_id, realm_id);


--
-- Name: party_locator party_locator_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.party_locator
    ADD CONSTRAINT party_locator_pkey PRIMARY KEY (route, account_id, kind, due_at, owner_route, owner_id, key);


--
-- Name: publication_head publication_head_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_pkey PRIMARY KEY (route, realm_id, subject_id);


--
-- Name: publication publication_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_pkey PRIMARY KEY (route, publication_id);


--
-- Name: publication publication_route_realm_id_publication_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_publication_id_key UNIQUE (route, realm_id, publication_id);


--
-- Name: realm_ban realm_ban_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_ban
    ADD CONSTRAINT realm_ban_pkey PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS);


--
-- Name: realm_claim_request realm_claim_request_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_claim_request
    ADD CONSTRAINT realm_claim_request_pkey PRIMARY KEY (route, realm_id, request_id);


--
-- Name: realm_claim_request realm_claim_request_route_realm_id_orphaned_at_account_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_claim_request
    ADD CONSTRAINT realm_claim_request_route_realm_id_orphaned_at_account_id_key UNIQUE (route, realm_id, orphaned_at, account_id);


--
-- Name: realm_discovery_board realm_discovery_board_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_discovery_board
    ADD CONSTRAINT realm_discovery_board_pkey PRIMARY KEY (route, realm_id, realm_epoch, board_id);


--
-- Name: realm_discovery_change realm_discovery_change_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_discovery_change
    ADD CONSTRAINT realm_discovery_change_pkey PRIMARY KEY (route, realm_id, generation);


--
-- Name: realm_discovery_fence realm_discovery_fence_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_discovery_fence
    ADD CONSTRAINT realm_discovery_fence_pkey PRIMARY KEY (route, realm_id, realm_epoch, source_route, intent, generation);


--
-- Name: realm_discovery_source realm_discovery_source_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_discovery_source
    ADD CONSTRAINT realm_discovery_source_pkey PRIMARY KEY (route, realm_id, realm_epoch, source_route, thread_id);


--
-- Name: realm_member_count_install realm_member_count_install_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member_count_install
    ADD CONSTRAINT realm_member_count_install_pkey PRIMARY KEY (partition_no);


--
-- Name: realm_member_count realm_member_count_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member_count
    ADD CONSTRAINT realm_member_count_pkey PRIMARY KEY (route, realm_id);


--
-- Name: realm_member realm_member_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member
    ADD CONSTRAINT realm_member_pkey PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS);


--
-- Name: realm_member_terminal realm_member_terminal_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member_terminal
    ADD CONSTRAINT realm_member_terminal_pkey PRIMARY KEY (route, realm_id, account_id, reservation_id);


--
-- Name: realm_membership_operation realm_membership_operation_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_membership_operation
    ADD CONSTRAINT realm_membership_operation_pkey PRIMARY KEY (route, operation_id);


--
-- Name: realm_membership_proof realm_membership_proof_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_membership_proof
    ADD CONSTRAINT realm_membership_proof_pkey PRIMARY KEY (route, realm_id, account_id, generation_id);


--
-- Name: realm_membership_proof realm_membership_proof_route_realm_id_account_id_operation__key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_membership_proof
    ADD CONSTRAINT realm_membership_proof_route_realm_id_account_id_operation__key UNIQUE (route, realm_id, account_id, operation_id);


--
-- Name: realm realm_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_pkey PRIMARY KEY (route, realm_id);


--
-- Name: realm_revision realm_revision_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: realm_revision realm_revision_route_realm_id_revision_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_revision_id_key UNIQUE (route, realm_id, revision_id);


--
-- Name: realm_revision realm_revision_route_realm_id_revision_id_visibility_contex_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_revision_id_visibility_contex_key UNIQUE (route, realm_id, revision_id, visibility, context_id);


--
-- Name: realm realm_route_space_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_route_space_id_key UNIQUE (route, space_id);


--
-- Name: revision_locator revision_locator_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.revision_locator
    ADD CONSTRAINT revision_locator_pkey PRIMARY KEY (route, account_id, kind, owner_route, owner_id, revision_id);


--
-- Name: space_address_claim space_address_claim_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_address_claim
    ADD CONSTRAINT space_address_claim_pkey PRIMARY KEY (route, normalized_address);


--
-- Name: space_discovery_dependency_install space_discovery_dependency_install_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_dependency_install
    ADD CONSTRAINT space_discovery_dependency_install_pkey PRIMARY KEY (partition_no);


--
-- Name: space_discovery_dependency space_discovery_dependency_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_dependency
    ADD CONSTRAINT space_discovery_dependency_pkey PRIMARY KEY (dependency, route, space_id);


--
-- Name: space_discovery_frontier space_discovery_frontier_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_frontier
    ADD CONSTRAINT space_discovery_frontier_pkey PRIMARY KEY (partition_no, obligation);


--
-- Name: space_discovery_frontier_wake space_discovery_frontier_wake_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_frontier_wake
    ADD CONSTRAINT space_discovery_frontier_wake_pkey PRIMARY KEY (route, space_id, obligation);


--
-- Name: space_discovery_population space_discovery_population_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_population
    ADD CONSTRAINT space_discovery_population_pkey PRIMARY KEY (partition_no);


--
-- Name: space space_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space
    ADD CONSTRAINT space_pkey PRIMARY KEY (route, space_id);


--
-- Name: space_revision space_revision_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: space_revision space_revision_route_space_id_revision_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_revision_id_key UNIQUE (route, space_id, revision_id);


--
-- Name: discovery_due_frontier; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX discovery_due_frontier ON community.discovery_due USING btree (route, due_at, kind, realm_id, realm_epoch, key, day);


--
-- Name: discovery_popular; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX discovery_popular ON community.discovery_realm USING btree (route, ((- popular)), realm_id) WHERE (popular > 0);


--
-- Name: discovery_trending; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX discovery_trending ON community.discovery_realm USING btree (route, ((- trending)), realm_id) WHERE (trending > 0);


--
-- Name: publication_head_adopted_page; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX publication_head_adopted_page ON community.publication_head USING btree (route, realm_id, published_at DESC, subject_id DESC) WHERE (verdict = 'adopt'::text);


--
-- Name: publication_head_adopted_subject; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX publication_head_adopted_subject ON community.publication_head USING btree (route, realm_id, subject_id) WHERE (verdict = 'adopt'::text);


--
-- Name: realm_ban_current; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_ban_current ON community.realm_ban USING btree (route, realm_id, account_id) INCLUDE (valid) WHERE upper_inf(valid);


--
-- Name: realm_claim_request_pending_review; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_claim_request_pending_review ON community.realm_claim_request USING btree (route, realm_id, orphaned_at, request_id) INCLUDE (account_id, requested_at) WHERE (state = 'pending'::text);


--
-- Name: realm_discovery_fence_pending; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_discovery_fence_pending ON community.realm_discovery_fence USING btree (route, realm_id, realm_epoch) WHERE (outcome IS NULL);


--
-- Name: realm_member_change; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_member_change ON community.realm_member USING btree (route, realm_id, account_id, transaction_id);


--
-- Name: realm_member_count_end; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_count_end ON community.realm_member USING btree (route, realm_id, upper(valid) DESC) WHERE (NOT upper_inf(valid));


--
-- Name: realm_member_count_open; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_count_open ON community.realm_member USING btree (route, realm_id, member_count_key) WHERE upper_inf(valid);


--
-- Name: realm_member_count_pending; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_count_pending ON community.realm_member_count USING btree (route, realm_id) WHERE (NOT initialized);


--
-- Name: realm_member_count_unkeyed; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_count_unkeyed ON community.realm_member USING btree (route, realm_id, account_id) WHERE (upper_inf(valid) AND (member_count_key IS NULL));


--
-- Name: realm_member_next; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_next ON community.realm_member USING btree (route, realm_id, account_id, lower(valid)) WHERE (NOT lower_inf(valid));


--
-- Name: realm_member_open; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_member_open ON community.realm_member USING btree (route, realm_id, account_id) WHERE upper_inf(valid);


--
-- Name: realm_member_reservation; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_reservation ON community.realm_member USING btree (route, realm_id, account_id, reservation_id);


--
-- Name: space_discovery_dependency_install_pending; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX space_discovery_dependency_install_pending ON community.space_discovery_dependency_install USING btree (partition_no) WHERE (NOT complete);


--
-- Name: space_discovery_dependency_owner; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX space_discovery_dependency_owner ON community.space_discovery_dependency USING btree (route, space_id);


--
-- Name: space_discovery_dependency_page; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX space_discovery_dependency_page ON community.space_discovery_dependency USING btree (dependency, ordinal) INCLUDE (route, space_id);


--
-- Name: space_discovery_frontier_pending; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX space_discovery_frontier_pending ON community.space_discovery_frontier USING btree (partition_no, obligation) WHERE (state = ANY (ARRAY['preparing'::text, 'draining'::text]));


--
-- Name: realm_member_key_mcv; Type: STATISTICS; Schema: community; Owner: -
--

CREATE STATISTICS community.realm_member_key_mcv (mcv) ON route, realm_id, account_id FROM community.realm_member;


--
-- Name: space follow_count_new_space; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER follow_count_new_space AFTER INSERT ON community.space FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_total();


--
-- Name: realm_member member_locator_pending; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER member_locator_pending AFTER INSERT OR UPDATE OF valid ON community.realm_member FOR EACH ROW EXECUTE FUNCTION community.record_member_locator_pending();


--
-- Name: realm_member_terminal member_locator_terminal_pending; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER member_locator_terminal_pending AFTER INSERT ON community.realm_member_terminal FOR EACH ROW EXECUTE FUNCTION community.record_member_locator_pending();


--
-- Name: publication_head publication_head_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_head_identity BEFORE UPDATE ON community.publication_head FOR EACH ROW EXECUTE FUNCTION community.guard_publication_head();


--
-- Name: publication publication_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_immutable BEFORE DELETE OR UPDATE ON community.publication FOR EACH ROW EXECUTE FUNCTION community.guard_publication();


--
-- Name: publication_head publication_population; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_population AFTER INSERT OR DELETE OR UPDATE ON community.publication_head FOR EACH ROW EXECUTE FUNCTION community.advance_publication_population();


--
-- Name: realm_discovery_board realm_discovery_board_log; Type: TRIGGER; Schema: community; Owner: -
--

CREATE CONSTRAINT TRIGGER realm_discovery_board_log AFTER INSERT OR UPDATE ON community.realm_discovery_board DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_board();


--
-- Name: realm_discovery_change realm_discovery_change_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_discovery_change_immutable BEFORE DELETE OR UPDATE ON community.realm_discovery_change FOR EACH ROW EXECUTE FUNCTION community.immutable_realm_discovery_change();


--
-- Name: realm realm_discovery_epoch; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_discovery_epoch BEFORE INSERT OR UPDATE ON community.realm FOR EACH ROW EXECUTE FUNCTION community.advance_realm_discovery_epoch();


--
-- Name: realm realm_discovery_epoch_log; Type: TRIGGER; Schema: community; Owner: -
--

CREATE CONSTRAINT TRIGGER realm_discovery_epoch_log AFTER UPDATE ON community.realm DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((old.discovery_epoch IS DISTINCT FROM new.discovery_epoch)) EXECUTE FUNCTION community.log_realm_discovery_epoch();


--
-- Name: realm_discovery_fence realm_discovery_gate_log; Type: TRIGGER; Schema: community; Owner: -
--

CREATE CONSTRAINT TRIGGER realm_discovery_gate_log AFTER INSERT OR UPDATE ON community.realm_discovery_fence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_gate();


--
-- Name: realm realm_discovery_generation; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_discovery_generation BEFORE UPDATE ON community.realm FOR EACH ROW EXECUTE FUNCTION community.fence_realm_discovery_epoch();


--
-- Name: realm_discovery_source realm_discovery_thread_log; Type: TRIGGER; Schema: community; Owner: -
--

CREATE CONSTRAINT TRIGGER realm_discovery_thread_log AFTER INSERT OR UPDATE ON community.realm_discovery_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_thread();


--
-- Name: realm realm_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_identity BEFORE UPDATE ON community.realm FOR EACH ROW EXECUTE FUNCTION community.guard_realm();


--
-- Name: realm_member realm_member_count_change; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_count_change AFTER INSERT OR DELETE OR UPDATE ON community.realm_member FOR EACH ROW EXECUTE FUNCTION community.change_realm_member_count();


--
-- Name: realm realm_member_count_create; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_count_create AFTER INSERT ON community.realm FOR EACH ROW EXECUTE FUNCTION community.create_realm_member_count();


--
-- Name: realm_member realm_member_count_lock; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_count_lock BEFORE INSERT OR DELETE OR UPDATE ON community.realm_member FOR EACH ROW EXECUTE FUNCTION community.lock_realm_member_count();


--
-- Name: realm_member realm_member_count_no_truncate; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_count_no_truncate BEFORE TRUNCATE ON community.realm_member FOR EACH STATEMENT EXECUTE FUNCTION community.guard_realm_member_count_truncate();


--
-- Name: realm_member_terminal realm_member_terminal_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_terminal_immutable BEFORE DELETE OR UPDATE ON community.realm_member_terminal FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();


--
-- Name: realm_membership_operation realm_membership_operation_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_membership_operation_immutable BEFORE DELETE OR UPDATE ON community.realm_membership_operation FOR EACH ROW EXECUTE FUNCTION community.guard_realm_membership_operation();


--
-- Name: realm_membership_proof realm_membership_proof_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_membership_proof_immutable BEFORE DELETE OR UPDATE ON community.realm_membership_proof FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();


--
-- Name: realm realm_orphan_deadline; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_orphan_deadline BEFORE UPDATE ON community.realm FOR EACH ROW EXECUTE FUNCTION community.guard_realm_orphan_deadline();


--
-- Name: realm_revision realm_revision_board_scheme; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_board_scheme BEFORE INSERT ON community.realm_revision FOR EACH ROW WHEN (((new.board_scheme_id IS NULL) AND (new.predecessor IS NOT NULL))) EXECUTE FUNCTION community.inherit_realm_board_scheme();


--
-- Name: realm_revision realm_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_immutable BEFORE DELETE OR UPDATE ON community.realm_revision FOR EACH ROW EXECUTE FUNCTION community.guard_realm_revision();


--
-- Name: realm_revision realm_revision_votes; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_votes BEFORE INSERT ON community.realm_revision FOR EACH ROW WHEN (((new.predecessor IS NOT NULL) AND (new.votes = '{"upvote": 1, "downvote": -1}'::jsonb))) EXECUTE FUNCTION community.inherit_realm_votes();


--
-- Name: realm realm_space_discovery_dependencies; Type: TRIGGER; Schema: community; Owner: -
--

CREATE CONSTRAINT TRIGGER realm_space_discovery_dependencies AFTER INSERT OR DELETE OR UPDATE ON community.realm DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.change_space_discovery_dependencies();


--
-- Name: space space_discovery_dependencies; Type: TRIGGER; Schema: community; Owner: -
--

CREATE CONSTRAINT TRIGGER space_discovery_dependencies AFTER INSERT OR UPDATE ON community.space DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.change_space_discovery_dependencies();


--
-- Name: space space_discovery_population; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_discovery_population AFTER INSERT OR DELETE ON community.space FOR EACH ROW EXECUTE FUNCTION community.maintain_space_discovery_population();


--
-- Name: space space_discovery_population_truncate; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_discovery_population_truncate AFTER TRUNCATE ON community.space FOR EACH STATEMENT EXECUTE FUNCTION community.reset_space_discovery_population();


--
-- Name: space space_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_identity BEFORE UPDATE ON community.space FOR EACH ROW EXECUTE FUNCTION community.guard_space();


--
-- Name: space space_realm_discovery_generation; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_realm_discovery_generation AFTER UPDATE ON community.space FOR EACH ROW EXECUTE FUNCTION community.fence_space_realm_discovery();


--
-- Name: space_revision space_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_revision_immutable BEFORE DELETE OR UPDATE ON community.space_revision FOR EACH ROW EXECUTE FUNCTION community.guard_space_revision();


--
-- Name: publication_head publication_head_route_publication_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_route_publication_id_fkey FOREIGN KEY (route, publication_id) REFERENCES community.publication(route, publication_id);


--
-- Name: publication_head publication_head_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: publication publication_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: publication publication_route_realm_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_predecessor_fkey FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.publication(route, realm_id, publication_id);


--
-- Name: realm_claim_request realm_claim_request_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_claim_request
    ADD CONSTRAINT realm_claim_request_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: realm_discovery_change realm_discovery_change_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_discovery_change
    ADD CONSTRAINT realm_discovery_change_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: realm_discovery_fence realm_discovery_fence_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_discovery_fence
    ADD CONSTRAINT realm_discovery_fence_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: realm realm_head_revision_fk; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_head_revision_fk FOREIGN KEY (route, realm_id, head_revision_id, visibility, context_id) REFERENCES community.realm_revision(route, realm_id, revision_id, visibility, context_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: realm_revision realm_revision_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: realm_revision realm_revision_route_realm_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_predecessor_fkey FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.realm_revision(route, realm_id, revision_id);


--
-- Name: realm realm_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id);


--
-- Name: space_discovery_dependency space_discovery_dependency_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_dependency
    ADD CONSTRAINT space_discovery_dependency_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id) ON DELETE CASCADE;


--
-- Name: space_discovery_frontier_wake space_discovery_frontier_wake_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_discovery_frontier_wake
    ADD CONSTRAINT space_discovery_frontier_wake_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id) ON DELETE CASCADE;


--
-- Name: space space_head_revision_fk; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space
    ADD CONSTRAINT space_head_revision_fk FOREIGN KEY (route, space_id, head_revision_id) REFERENCES community.space_revision(route, space_id, revision_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: space_revision space_revision_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id);


--
-- Name: space_revision space_revision_route_space_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_predecessor_fkey FOREIGN KEY (route, space_id, predecessor) REFERENCES community.space_revision(route, space_id, revision_id);


--
-- PostgreSQL database dump complete
--


