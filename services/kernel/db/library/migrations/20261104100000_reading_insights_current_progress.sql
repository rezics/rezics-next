-- migrate:up
-- Exact private current-progress receiving. Existing rows are admitted through the retained sessions phase.
CREATE TABLE library.reading_insights_current_progress_installation (
  singleton boolean PRIMARY KEY CHECK (singleton),
  version integer NOT NULL CHECK (version=1)
);
CREATE TABLE library.reading_insights_current_progress_owner (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  initialized_sessions bigint NOT NULL DEFAULT 0 CHECK (initialized_sessions >= 0),
  current_sessions bigint NOT NULL DEFAULT 0 CHECK (current_sessions >= 0),
  covered_sessions bigint NOT NULL DEFAULT 0 CHECK (covered_sessions >= 0),
  active_sessions bigint NOT NULL DEFAULT 0 CHECK (active_sessions >= 0),
  backlog_sessions bigint NOT NULL DEFAULT 0 CHECK (backlog_sessions >= 0),
  revision uuid NOT NULL,
  PRIMARY KEY(route,account_id)
);
CREATE TABLE library.reading_insights_current_progress_scope (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('active','backlog')),
  session_count bigint NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  covered_sessions bigint NOT NULL DEFAULT 0 CHECK (covered_sessions >= 0),
  group_count bigint NOT NULL DEFAULT 0 CHECK (group_count >= 0),
  occurrences bigint NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  current_known bigint NOT NULL DEFAULT 0 CHECK (current_known >= 0),
  total_known bigint NOT NULL DEFAULT 0 CHECK (total_known >= 0),
  PRIMARY KEY(route,account_id,scope)
);
CREATE TABLE library.reading_insights_current_progress_group (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('active','backlog')),
  meaning jsonb NOT NULL CHECK (jsonb_typeof(meaning)='object'),
  occurrences bigint NOT NULL CHECK (occurrences > 0),
  current_known bigint NOT NULL CHECK (current_known >= 0),
  current_sum numeric NOT NULL,
  total_known bigint NOT NULL CHECK (total_known >= 0),
  total_sum numeric NOT NULL,
  PRIMARY KEY(route,account_id,scope,meaning)
);
CREATE INDEX reading_insights_current_progress_group_top
  ON library.reading_insights_current_progress_group(route,account_id,scope,occurrences DESC,meaning);
CREATE TABLE library.reading_insights_current_progress_session (
  route integer NOT NULL,
  session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active','completed','abandoned')),
  scope text CHECK (scope IS NULL OR scope IN ('active','backlog')),
  covered boolean NOT NULL,
  PRIMARY KEY(route,session_id)
);
CREATE TABLE library.reading_insights_current_progress_value (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('active','backlog')),
  meaning jsonb NOT NULL CHECK (jsonb_typeof(meaning)='object'),
  current_value numeric,
  total_value numeric,
  PRIMARY KEY(route,session_id,scope,meaning)
);

CREATE FUNCTION library.reading_insights_current_progress_apply(
  p_route integer,p_account_id uuid,p_scope text,p_meaning jsonb,p_current numeric,p_total numeric,p_delta integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE present boolean; remaining bigint;
BEGIN
  IF p_delta NOT IN (-1,1) THEN RAISE EXCEPTION 'Invalid current-progress delta'; END IF;
  IF p_delta=1 THEN
    SELECT EXISTS(SELECT 1 FROM library.reading_insights_current_progress_group
      WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning) INTO present;
    IF present THEN
      UPDATE library.reading_insights_current_progress_group SET
        occurrences=occurrences+1,
        current_known=current_known+(p_current IS NOT NULL)::integer,
        current_sum=current_sum+COALESCE(p_current,0),
        total_known=total_known+(p_total IS NOT NULL)::integer,
        total_sum=total_sum+COALESCE(p_total,0)
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning;
    ELSE
      INSERT INTO library.reading_insights_current_progress_group
        (route,account_id,scope,meaning,occurrences,current_known,current_sum,total_known,total_sum)
        VALUES(p_route,p_account_id,p_scope,p_meaning,1,(p_current IS NOT NULL)::integer,
          COALESCE(p_current,0),(p_total IS NOT NULL)::integer,COALESCE(p_total,0));
      UPDATE library.reading_insights_current_progress_scope SET group_count=group_count+1
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope;
    END IF;
  ELSE
    UPDATE library.reading_insights_current_progress_group SET
      occurrences=occurrences-1,
      current_known=current_known-(p_current IS NOT NULL)::integer,
      current_sum=current_sum-COALESCE(p_current,0),
      total_known=total_known-(p_total IS NOT NULL)::integer,
      total_sum=total_sum-COALESCE(p_total,0)
      WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning
      RETURNING occurrences INTO remaining;
    IF remaining IS NULL THEN RAISE EXCEPTION 'Missing current-progress receiver group'; END IF;
    IF remaining=0 THEN
      DELETE FROM library.reading_insights_current_progress_group
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning;
      UPDATE library.reading_insights_current_progress_scope SET group_count=group_count-1
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope;
    END IF;
  END IF;
  UPDATE library.reading_insights_current_progress_scope SET
    occurrences=occurrences+p_delta,
    current_known=current_known+p_delta*(p_current IS NOT NULL)::integer,
    total_known=total_known+p_delta*(p_total IS NOT NULL)::integer
    WHERE route=p_route AND account_id=p_account_id AND scope=p_scope;
END $$;

CREATE FUNCTION library.reading_insights_current_progress_refresh(p_route integer,p_session_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE prior library.reading_insights_current_progress_session%ROWTYPE;
        source library.progress_session%ROWTYPE;
        projected record;
        next_scope text;
        next_covered boolean := false;
BEGIN
  SELECT * INTO prior FROM library.reading_insights_current_progress_session
    WHERE route=p_route AND session_id=p_session_id FOR UPDATE;
  IF FOUND THEN
    PERFORM 1 FROM library.reading_insights_current_progress_owner
      WHERE route=prior.route AND account_id=prior.account_id FOR UPDATE;
    FOR projected IN
      DELETE FROM library.reading_insights_current_progress_value
        WHERE route=prior.route AND session_id=prior.session_id
        RETURNING account_id,scope,meaning,current_value,total_value
    LOOP
      PERFORM library.reading_insights_current_progress_apply(
        prior.route,projected.account_id,projected.scope,projected.meaning,
        projected.current_value,projected.total_value,-1);
    END LOOP;
    IF prior.scope IS NOT NULL THEN
      UPDATE library.reading_insights_current_progress_scope SET
        session_count=session_count-1,
        covered_sessions=covered_sessions-prior.covered::integer
        WHERE route=prior.route AND account_id=prior.account_id AND scope=prior.scope;
      DELETE FROM library.reading_insights_current_progress_scope
        WHERE route=prior.route AND account_id=prior.account_id AND scope=prior.scope
          AND session_count=0 AND group_count=0;
    END IF;
    UPDATE library.reading_insights_current_progress_owner SET
      initialized_sessions=initialized_sessions-1,
      current_sessions=current_sessions-(prior.scope IS NOT NULL)::integer,
      covered_sessions=covered_sessions-(prior.scope IS NOT NULL AND prior.covered)::integer,
      active_sessions=active_sessions-COALESCE((prior.scope='active')::integer,0),
      backlog_sessions=backlog_sessions-COALESCE((prior.scope='backlog')::integer,0),
      revision=gen_random_uuid()
      WHERE route=prior.route AND account_id=prior.account_id;
    DELETE FROM library.reading_insights_current_progress_session
      WHERE route=prior.route AND session_id=prior.session_id;
    DELETE FROM library.reading_insights_current_progress_owner
      WHERE route=prior.route AND account_id=prior.account_id AND initialized_sessions=0
        AND current_sessions=0 AND covered_sessions=0 AND active_sessions=0 AND backlog_sessions=0;
  END IF;

  SELECT * INTO source FROM library.progress_session WHERE route=p_route AND session_id=p_session_id;
  IF NOT FOUND OR source.state='retired' THEN RETURN; END IF;
  INSERT INTO library.reading_insights_current_progress_owner
    (route,account_id,initialized_sessions,current_sessions,covered_sessions,
     active_sessions,backlog_sessions,revision)
    VALUES(source.route,source.account_id,0,0,0,0,0,gen_random_uuid())
    ON CONFLICT(route,account_id) DO NOTHING;
  PERFORM 1 FROM library.reading_insights_current_progress_owner
    WHERE route=source.route AND account_id=source.account_id FOR UPDATE;

  next_scope := CASE source.state WHEN 'active' THEN 'active' WHEN 'abandoned' THEN 'backlog' ELSE NULL END;
  INSERT INTO library.reading_insights_current_progress_session(route,session_id,account_id,state,scope,covered)
    VALUES(source.route,source.session_id,source.account_id,source.state,next_scope,false);
  IF next_scope IS NOT NULL THEN
    INSERT INTO library.reading_insights_current_progress_scope(route,account_id,scope)
      VALUES(source.route,source.account_id,next_scope) ON CONFLICT(route,account_id,scope) DO NOTHING;
    FOR projected IN
      WITH operands AS (
        SELECT source.unit AS unit,source.amount AS current_value,source.total AS total_value,NULL::text AS locator
          WHERE source.mode='scalar_amount'
        UNION ALL
        SELECT item->>'unit',NULLIF(item->>'amount','')::numeric,NULLIF(item->>'total','')::numeric,NULL::text
          FROM jsonb_array_elements(source.additional_measures) item WHERE source.mode='scalar_amount'
        UNION ALL
        SELECT source.unit,source.position,NULL::numeric,source.locator WHERE source.mode='cursor_position'
        UNION ALL
        SELECT source.unit,source.completed_unit_count::numeric,NULL::numeric,NULL::text WHERE source.mode='completed_units'
      )
      SELECT jsonb_build_object(
          'profilePin',m.profile_pin,
          'unitId',m.unit_id,
          'meaningRevision',m.meaning_revision,
          'mode',m.mode,
          'unit',operands.unit,
          'dimension',m.dimension,
          'precision',m.precision,
          'minimum',m.minimum::text,
          'maximum',m.maximum::text,
          'totalPolicy',m.total_policy,
          'identityKind',m.identity_kind,
          'structureKind',m.structure_kind,
          'locator',operands.locator
        ) AS meaning,operands.current_value,operands.total_value
      FROM operands JOIN library.reading_insights_progress_meaning m
        ON m.route=source.route AND m.session_id=source.session_id AND m.unit_id=operands.unit AND m.mode=source.mode
    LOOP
      next_covered := true;
      INSERT INTO library.reading_insights_current_progress_value
        (route,account_id,session_id,scope,meaning,current_value,total_value)
        VALUES(source.route,source.account_id,source.session_id,next_scope,projected.meaning,
          projected.current_value,projected.total_value);
      PERFORM library.reading_insights_current_progress_apply(
        source.route,source.account_id,next_scope,projected.meaning,
        projected.current_value,projected.total_value,1);
    END LOOP;
    UPDATE library.reading_insights_current_progress_session SET covered=next_covered
      WHERE route=source.route AND session_id=source.session_id;
    UPDATE library.reading_insights_current_progress_scope SET
      session_count=session_count+1,covered_sessions=covered_sessions+next_covered::integer
      WHERE route=source.route AND account_id=source.account_id AND scope=next_scope;
  END IF;
  UPDATE library.reading_insights_current_progress_owner SET
    initialized_sessions=initialized_sessions+1,
    current_sessions=current_sessions+(next_scope IS NOT NULL)::integer,
    covered_sessions=covered_sessions+(next_scope IS NOT NULL AND next_covered)::integer,
    active_sessions=active_sessions+COALESCE((next_scope='active')::integer,0),
    backlog_sessions=backlog_sessions+COALESCE((next_scope='backlog')::integer,0),
    revision=gen_random_uuid()
    WHERE route=source.route AND account_id=source.account_id;
END $$;

CREATE FUNCTION library.reading_insights_current_progress_receive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM library.reading_insights_current_progress_refresh(OLD.route,OLD.session_id);
    RETURN OLD;
  END IF;
  PERFORM library.reading_insights_current_progress_refresh(NEW.route,NEW.session_id);
  RETURN NEW;
END $$;
CREATE TRIGGER reading_insights_current_progress_receive AFTER INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.reading_insights_current_progress_receive();

CREATE FUNCTION library.reading_insights_current_progress_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE library.reading_insights_current_progress_owner,library.reading_insights_current_progress_scope,
    library.reading_insights_current_progress_group,library.reading_insights_current_progress_session,
    library.reading_insights_current_progress_value;
  RETURN NULL;
END $$;
CREATE TRIGGER reading_insights_current_progress_truncate AFTER TRUNCATE ON library.progress_session
  FOR EACH STATEMENT EXECUTE FUNCTION library.reading_insights_current_progress_truncate();

INSERT INTO library.reading_insights_current_progress_installation VALUES(true,1);

-- migrate:down
-- Forward only: exact progress meaning cannot be reconstructed from current profiles.
