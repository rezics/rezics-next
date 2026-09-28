INSERT INTO access.derived_generation_family (family, max_retained, retain_for)
VALUES ('also-enjoyed', 3, interval '1 hour');
CREATE INDEX rating_aggregate_context_also_enjoyed ON access.rating_aggregate_context (realm, context);

-- Public-library and admitted-rating changes invalidate the derived snapshot
-- in the same transaction as their owner rows. Content has a separate fence.
CREATE TABLE access.also_enjoyed_source_fence (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO access.also_enjoyed_source_fence DEFAULT VALUES;
CREATE FUNCTION access.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  UPDATE access.also_enjoyed_source_fence SET revision = revision + 1 WHERE id;
  RETURN NULL;
END $$;
DO $$ DECLARE source text; BEGIN
  FOREACH source IN ARRAY ARRAY['agent_library_visibility', 'agent_provision',
    'principal', 'authority_subject', 'rating_aggregate_head', 'rating_aggregate_context',
    'recovery_fence'] LOOP
    EXECUTE format('CREATE TRIGGER also_enjoyed_source_changed AFTER INSERT OR UPDATE OR DELETE
      ON access.%I FOR EACH ROW EXECUTE FUNCTION access.advance_also_enjoyed_source_fence()', source);
    EXECUTE format('CREATE TRIGGER also_enjoyed_source_truncated AFTER TRUNCATE
      ON access.%I FOR EACH STATEMENT EXECUTE FUNCTION access.advance_also_enjoyed_source_fence()', source);
  END LOOP;
END $$;

CREATE TABLE access.also_enjoyed_generation (
  generation_id uuid PRIMARY KEY,
  family text NOT NULL DEFAULT 'also-enjoyed' CHECK (family = 'also-enjoyed'),
  graph_epoch text NOT NULL,
  graph_sequence numeric NOT NULL CHECK (graph_sequence >= 0),
  access_revision bigint NOT NULL CHECK (access_revision >= 0),
  content_revision bigint NOT NULL CHECK (content_revision >= 0),
  phase text NOT NULL DEFAULT 'ratings' CHECK (phase IN ('ratings', 'shelves', 'pairs', 'complete')),
  after_key text NOT NULL DEFAULT '',
  signal_count bigint NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
  pair_count bigint NOT NULL DEFAULT 0 CHECK (pair_count >= 0),
  FOREIGN KEY (generation_id, family) REFERENCES access.derived_generation(id, family)
);
CREATE FUNCTION access.also_enjoyed_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.derived_generation WHERE id = NEW.generation_id
    AND family = 'also-enjoyed' AND state = 'building') THEN
    RAISE EXCEPTION 'co-reader generation changes only while building' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (NEW.generation_id, NEW.family, NEW.graph_epoch, NEW.graph_sequence,
      NEW.access_revision, NEW.content_revision) IS DISTINCT FROM
    (OLD.generation_id, OLD.family, OLD.graph_epoch, OLD.graph_sequence,
      OLD.access_revision, OLD.content_revision)
    OR (OLD.phase = 'complete' AND (NEW.phase, NEW.after_key) IS DISTINCT FROM
      (OLD.phase, OLD.after_key)) OR NEW.signal_count < OLD.signal_count
    OR NEW.pair_count < OLD.pair_count) THEN
    RAISE EXCEPTION 'co-reader generation basis or progress changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER also_enjoyed_generation_guard BEFORE INSERT OR UPDATE
  ON access.also_enjoyed_generation FOR EACH ROW
  EXECUTE FUNCTION access.also_enjoyed_generation_guard();

-- A person Agent is the disclosed identity; its private principal remains in
-- Access and never enters an HTTP response. Both sources fold into one slot.
CREATE TABLE access.also_enjoyed_signal (
  generation_id uuid NOT NULL REFERENCES access.also_enjoyed_generation(generation_id),
  reader_agent text NOT NULL,
  work text NOT NULL,
  source_eligible boolean NOT NULL,
  candidate_eligible boolean NOT NULL,
  PRIMARY KEY (generation_id, reader_agent, work)
);
CREATE INDEX also_enjoyed_signal_work ON access.also_enjoyed_signal
  (generation_id, work, reader_agent) WHERE source_eligible;
CREATE INDEX also_enjoyed_signal_candidate ON access.also_enjoyed_signal
  (generation_id, work) WHERE candidate_eligible;

CREATE TABLE access.also_enjoyed_pair (
  generation_id uuid NOT NULL REFERENCES access.also_enjoyed_generation(generation_id),
  source_work text NOT NULL,
  candidate_work text NOT NULL,
  shared_readers integer NOT NULL CHECK (shared_readers > 0),
  candidate_readers integer NOT NULL CHECK (candidate_readers >= shared_readers),
  -- Common Works are discounted: shared / sqrt(candidate population).
  score numeric NOT NULL CHECK (score > 0),
  PRIMARY KEY (generation_id, source_work, candidate_work),
  CHECK (source_work <> candidate_work)
);
CREATE INDEX also_enjoyed_pair_page ON access.also_enjoyed_pair
  (generation_id, source_work, score DESC, candidate_work COLLATE "C");

CREATE TRIGGER also_enjoyed_signal_insert_guard AFTER INSERT ON access.also_enjoyed_signal
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER also_enjoyed_signal_update_guard AFTER UPDATE ON access.also_enjoyed_signal
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER also_enjoyed_signal_delete_guard AFTER DELETE ON access.also_enjoyed_signal
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER also_enjoyed_pair_insert_guard AFTER INSERT ON access.also_enjoyed_pair
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER also_enjoyed_pair_update_guard AFTER UPDATE ON access.also_enjoyed_pair
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER also_enjoyed_pair_delete_guard AFTER DELETE ON access.also_enjoyed_pair
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
