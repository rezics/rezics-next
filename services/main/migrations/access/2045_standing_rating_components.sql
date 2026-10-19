-- Standing uses the same sealed additive-state rule as target ratings. Values
-- are recorded only after their admitted request digest has been checked. A
-- pre-component head is unknown, never a withdrawn vote or an invented zero.
ALTER TABLE access.rating_aggregate_head
  ADD COLUMN value numeric CHECK (value BETWEEN 0 AND 1000000 AND scale(value) <= 6),
  ADD COLUMN value_known boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT rating_aggregate_head_value_known CHECK (value IS NULL OR value_known);

CREATE FUNCTION access.rating_standing_slot(person uuid, context text, main text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'urn:rezics:rating-slot:' || encode(sha256(convert_to(
    '{"principalId":' || to_json(person::text)::text || ',"context":' || to_json(context)::text
    || ',"mainVersion":' || to_json(main)::text
    || ',"cadence":"https://rezics.com/definition/rating-standing-v1"}', 'UTF8')), 'hex')
$$;

-- One effective person slot, with native precedence over a merge selection.
-- Keeping this private ledger makes merge/unmerge and a later source revision
-- subtract the contribution actually recorded, rather than guessing a mean.
CREATE TABLE access.rating_standing_contribution (
  context text NOT NULL REFERENCES access.rating_aggregate_context(context),
  main_version text NOT NULL,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  effective_slot text NOT NULL,
  origin_main_version text,
  origin_slot text,
  value numeric,
  value_known boolean NOT NULL,
  admission_id uuid REFERENCES access.admission(id),
  PRIMARY KEY (context, main_version, principal_id),
  UNIQUE (context, main_version, effective_slot)
);
CREATE INDEX rating_merge_selection_origin ON access.rating_merge_selection(context, origin_main_version, origin_slot);
CREATE INDEX rating_standing_unvalued ON access.rating_standing_contribution(context,main_version,effective_slot)
  WHERE NOT value_known;

CREATE TABLE access.rating_standing_component (
  context text NOT NULL REFERENCES access.rating_aggregate_context(context),
  main_version text NOT NULL,
  slots integer NOT NULL CHECK (slots >= 0),
  unvalued integer NOT NULL CHECK (unvalued BETWEEN 0 AND slots),
  -- Sparse exact decimal bins; their scale is validated against the immutable
  -- Context before use. There are at most 1001 values on any admitted scale.
  histogram jsonb NOT NULL CHECK (jsonb_typeof(histogram) = 'object'),
  last_admission_id uuid REFERENCES access.admission(id),
  PRIMARY KEY (context, main_version)
);
CREATE INDEX rating_standing_component_unvalued ON access.rating_standing_component(context,main_version) WHERE unvalued > 0;

INSERT INTO access.rating_standing_contribution
  (context,main_version,principal_id,effective_slot,origin_main_version,origin_slot,value,value_known,admission_id)
SELECT h.context,h.main_version,h.principal_id,h.slot,h.main_version,h.slot,NULL::numeric,false,h.admission_id
FROM access.rating_aggregate_head h
WHERE h.target_release IS NULL AND h.slot = access.rating_standing_slot(h.principal_id,h.context,h.main_version)
UNION ALL
SELECT s.context,s.main_version,s.principal_id,access.rating_standing_slot(s.principal_id,s.context,s.main_version),
  s.origin_main_version,s.origin_slot,NULL::numeric,false,h.admission_id
FROM access.rating_merge_selection s
LEFT JOIN access.rating_aggregate_head h ON (h.context,h.main_version,h.slot) = (s.context,s.origin_main_version,s.origin_slot)
WHERE NOT EXISTS (SELECT 1 FROM access.rating_aggregate_head n
  WHERE n.context=s.context AND n.main_version=s.main_version AND n.principal_id=s.principal_id AND n.target_release IS NULL);

INSERT INTO access.rating_standing_component(context,main_version,slots,unvalued,histogram,last_admission_id)
SELECT context,main_version,count(*),count(*),'{}'::jsonb,(array_agg(admission_id ORDER BY admission_id))[1]
FROM access.rating_standing_contribution GROUP BY context,main_version;

CREATE FUNCTION access.rating_standing_bin(bins jsonb, value numeric, delta integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; amount integer;
BEGIN
  IF value IS NULL OR delta = 0 THEN RETURN bins; END IF;
  key := trim_scale(value)::text;
  amount := COALESCE((bins->>key)::integer,0) + delta;
  IF amount < 0 THEN RAISE EXCEPTION 'Standing rating bin underflow' USING ERRCODE='23514'; END IF;
  IF amount = 0 THEN RETURN bins - key; END IF;
  RETURN jsonb_set(bins,ARRAY[key],to_jsonb(amount));
END $$;

CREATE FUNCTION access.rating_standing_contribution_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c text := COALESCE(NEW.context,OLD.context); m text := COALESCE(NEW.main_version,OLD.main_version);
BEGIN
  INSERT INTO access.rating_standing_component(context,main_version,slots,unvalued,histogram)
    VALUES (c,m,0,0,'{}') ON CONFLICT DO NOTHING;
  UPDATE access.rating_standing_component SET
    slots = slots + CASE WHEN TG_OP='INSERT' THEN 1 WHEN TG_OP='DELETE' THEN -1 ELSE 0 END,
    unvalued = unvalued + CASE WHEN TG_OP<>'DELETE' AND NOT NEW.value_known THEN 1 ELSE 0 END
      - CASE WHEN TG_OP<>'INSERT' AND NOT OLD.value_known THEN 1 ELSE 0 END,
    histogram = access.rating_standing_bin(access.rating_standing_bin(histogram,
      CASE WHEN TG_OP<>'INSERT' AND OLD.value_known THEN OLD.value END,-1),
      CASE WHEN TG_OP<>'DELETE' AND NEW.value_known THEN NEW.value END,1),
    last_admission_id = COALESCE(NEW.admission_id,OLD.admission_id,last_admission_id)
    WHERE context=c AND main_version=m;
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_contribution_delta AFTER INSERT OR UPDATE OR DELETE ON access.rating_standing_contribution
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_contribution_delta();

CREATE FUNCTION access.refresh_rating_standing_slot(c text,m text,person uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE; s access.rating_merge_selection%ROWTYPE; present boolean;
BEGIN
  INSERT INTO access.rating_observation_gate(context,target) VALUES(c,m) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM access.rating_observation_gate WHERE context=c AND target=m FOR UPDATE;
  SELECT * INTO h FROM access.rating_aggregate_head
    WHERE context=c AND main_version=m AND slot=access.rating_standing_slot(person,c,m) AND target_release IS NULL FOR SHARE;
  present := FOUND;
  IF NOT present THEN
    SELECT * INTO s FROM access.rating_merge_selection WHERE context=c AND main_version=m AND principal_id=person;
    present := FOUND;
    IF present THEN
      SELECT * INTO h FROM access.rating_aggregate_head WHERE context=c AND main_version=s.origin_main_version
        AND slot=s.origin_slot AND principal_id=person AND target_release IS NULL FOR SHARE;
    END IF;
  END IF;
  IF NOT present THEN
    DELETE FROM access.rating_standing_contribution WHERE context=c AND main_version=m AND principal_id=person;
    RETURN;
  END IF;
  INSERT INTO access.rating_standing_contribution
    (context,main_version,principal_id,effective_slot,origin_main_version,origin_slot,value,value_known,admission_id)
    VALUES (c,m,person,access.rating_standing_slot(person,c,m),COALESCE(h.main_version,s.origin_main_version),
      COALESCE(h.slot,s.origin_slot),h.value,COALESCE(h.value_known,false),h.admission_id)
    ON CONFLICT (context,main_version,principal_id) DO UPDATE SET
      origin_main_version=EXCLUDED.origin_main_version,origin_slot=EXCLUDED.origin_slot,
      value=EXCLUDED.value,value_known=EXCLUDED.value_known,admission_id=EXCLUDED.admission_id
    WHERE (rating_standing_contribution.origin_main_version,rating_standing_contribution.origin_slot,
      rating_standing_contribution.value,rating_standing_contribution.value_known,rating_standing_contribution.admission_id)
      IS DISTINCT FROM (EXCLUDED.origin_main_version,EXCLUDED.origin_slot,EXCLUDED.value,EXCLUDED.value_known,EXCLUDED.admission_id);
END $$;

-- Exact indexed probes after each changed head or merge grain, never a scan of
-- the raters. Source revisions also refresh their retained merge projections.
CREATE FUNCTION access.rating_standing_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE := COALESCE(NEW,OLD); target text;
BEGIN
  IF h.target_release IS NOT NULL OR h.slot<>access.rating_standing_slot(h.principal_id,h.context,h.main_version) THEN RETURN NULL; END IF;
  FOR target IN SELECT h.main_version UNION SELECT s.main_version FROM access.rating_merge_selection s
    WHERE s.context=h.context AND s.origin_main_version=h.main_version AND s.origin_slot=h.slot ORDER BY 1
  LOOP
    PERFORM access.refresh_rating_standing_slot(h.context,target,h.principal_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_head_changed AFTER INSERT OR UPDATE OR DELETE ON access.rating_aggregate_head
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_head_changed();
CREATE FUNCTION access.rating_standing_selection_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s access.rating_merge_selection%ROWTYPE := COALESCE(NEW,OLD);
BEGIN
  PERFORM access.refresh_rating_standing_slot(s.context,s.main_version,s.principal_id);
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_selection_changed AFTER INSERT OR UPDATE OR DELETE ON access.rating_merge_selection
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_selection_changed();
