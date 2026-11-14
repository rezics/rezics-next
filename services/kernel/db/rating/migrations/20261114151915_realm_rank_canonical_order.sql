-- migrate:up
-- The existing figure publication remains the score writer. Semantic owns name selection.
LOCK TABLE rating.public_figure, rating.realm_rank IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rating.realm_rank ADD COLUMN canonical_name text COLLATE "C";

CREATE TABLE rating.realm_rank_canonical_state (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  canonical_generation bigint CHECK (canonical_generation > 0),
  building_generation bigint CHECK (building_generation > 0),
  after_question uuid,
  after_population uuid,
  after_subject uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((after_question IS NULL AND after_population IS NULL AND after_subject IS NULL)
      OR (after_question IS NOT NULL AND after_population IS NOT NULL AND after_subject IS NOT NULL))
);

CREATE FUNCTION rating.capture_realm_rank_canonical_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize with Semantic's committed generation, without writing Semantic or selecting labels.
  -- A stale repeatable-read/serializable snapshot must fail instead of certifying an old key.
  PERFORM 1 FROM semantic.partition_subjects WHERE partition_no=NEW.partition_no FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Realm rank canonical population is unavailable'; END IF;
  SELECT subject.canonical_name INTO NEW.canonical_name FROM semantic.subject AS subject
    WHERE subject.route=get_byte(uuid_send(NEW.subject_id),10)*256+get_byte(uuid_send(NEW.subject_id),11)
      AND subject.subject_id=NEW.subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Realm rank canonical Subject is unavailable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_rank_canonical_name BEFORE INSERT OR UPDATE ON rating.realm_rank
  FOR EACH ROW EXECUTE FUNCTION rating.capture_realm_rank_canonical_name();

-- All tuple directions are ascending, so a continuation is one strict composite B-tree seek.
CREATE INDEX realm_rank_scored_canonical_idx ON rating.realm_rank
  (partition_no,question_id,population_id,question_identity,prior_generation,prior_epoch,
   (-score),(canonical_name IS NULL),(COALESCE(canonical_name,'') COLLATE "C"),subject_id);

-- Background command only: one durable keyset page, never a request-time repair or a table walk.
-- The owner resumes until complete, including a terminal empty page for an exactly full batch.
CREATE FUNCTION rating.rebuild_realm_rank_canonical_order(p_partition integer, p_limit integer, p_restart boolean DEFAULT false)
RETURNS TABLE(complete boolean, consumed integer, canonical_generation bigint, revision bigint)
LANGUAGE plpgsql AS $$
DECLARE
  current_generation bigint;
  build rating.realm_rank_canonical_state%ROWTYPE;
  keys refcursor;
  candidate record;
  consumed_count integer := 0;
BEGIN
  IF p_partition IS NULL OR p_partition NOT BETWEEN 0 AND 4095 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
     OR p_restart IS NULL THEN
    RAISE EXCEPTION 'Invalid Realm rank canonical rebuild page';
  END IF;
  PERFORM 1 FROM core.partition WHERE partition_no=p_partition AND write_state='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Realm rank canonical home is unavailable'; END IF;
  SELECT population.canonical_generation INTO current_generation FROM semantic.partition_subjects AS population
    WHERE population.partition_no=p_partition FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Realm rank canonical population is unavailable'; END IF;
  INSERT INTO rating.realm_rank_canonical_state(partition_no) VALUES(p_partition) ON CONFLICT DO NOTHING;
  SELECT state.* INTO build FROM rating.realm_rank_canonical_state AS state
    WHERE state.partition_no=p_partition FOR UPDATE;
  IF NOT p_restart AND build.canonical_generation=current_generation THEN
    RETURN QUERY SELECT true,0,current_generation,build.revision;
    RETURN;
  END IF;
  IF p_restart OR build.building_generation IS DISTINCT FROM current_generation THEN
    UPDATE rating.realm_rank_canonical_state AS state
      SET canonical_generation=NULL,building_generation=current_generation,
          after_question=NULL,after_population=NULL,after_subject=NULL,revision=state.revision+1
      WHERE state.partition_no=p_partition RETURNING state.* INTO build;
  END IF;
  IF build.after_question IS NULL THEN
    OPEN keys FOR SELECT question_id,population_id,subject_id FROM rating.realm_rank
      WHERE partition_no=p_partition ORDER BY question_id,population_id,subject_id LIMIT p_limit FOR UPDATE;
  ELSE
    OPEN keys FOR SELECT question_id,population_id,subject_id FROM rating.realm_rank
      WHERE partition_no=p_partition
        AND (question_id,population_id,subject_id)>(build.after_question,build.after_population,build.after_subject)
      ORDER BY question_id,population_id,subject_id LIMIT p_limit FOR UPDATE;
  END IF;
  LOOP
    FETCH keys INTO candidate;
    EXIT WHEN NOT FOUND;
    -- The installed native capture trigger copies the current Semantic key for this exact row.
    UPDATE rating.realm_rank AS rank SET canonical_name=rank.canonical_name
      WHERE rank.partition_no=p_partition AND rank.question_id=candidate.question_id
        AND rank.population_id=candidate.population_id AND rank.subject_id=candidate.subject_id;
    consumed_count := consumed_count+1;
    build.after_question := candidate.question_id;
    build.after_population := candidate.population_id;
    build.after_subject := candidate.subject_id;
  END LOOP;
  CLOSE keys;
  UPDATE rating.realm_rank_canonical_state AS state
    SET canonical_generation=CASE WHEN consumed_count<p_limit THEN current_generation ELSE NULL END,
        building_generation=CASE WHEN consumed_count<p_limit THEN NULL ELSE current_generation END,
        after_question=CASE WHEN consumed_count<p_limit THEN NULL ELSE build.after_question END,
        after_population=CASE WHEN consumed_count<p_limit THEN NULL ELSE build.after_population END,
        after_subject=CASE WHEN consumed_count<p_limit THEN NULL ELSE build.after_subject END,
        revision=state.revision+1
    WHERE state.partition_no=p_partition RETURNING state.* INTO build;
  RETURN QUERY SELECT build.canonical_generation IS NOT DISTINCT FROM current_generation,
                      consumed_count,current_generation,build.revision;
END;
$$;

-- No unbounded data backfill. Missing state refuses scored-canonical reads until the native
-- command has completed the bounded rebuild. Rename/identity/security changes invalidate it
-- through Semantic's existing committed canonical_generation, including changes during rebuild.

-- migrate:down
-- Forward only: never reuse a published canonical coverage revision or continuation basis.
SELECT 1;
