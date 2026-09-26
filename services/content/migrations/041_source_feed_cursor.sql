-- A dump/change feed consumer is a strict chain of immutable checkpoints. Each
-- checkpoint references its run capture, so progress resumes only from durable
-- observations. The head and open-gap rows are lookup aids maintained by triggers.
CREATE TABLE source.feed (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 100),
  feed_key text NOT NULL CHECK (feed_key ~ '^[a-z0-9][a-z0-9._:/-]{0,99}$'),
  position_scheme text NOT NULL CHECK (position_scheme IN ('provider-sequence', 'provider-time-us')),
  max_page_items integer NOT NULL CHECK (max_page_items BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, provider, namespace, feed_key)
);
CREATE TRIGGER source_feed_immutable BEFORE UPDATE OR DELETE ON source.feed
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Positions are inclusive provider positions. Continuity is derived by the owner:
-- `overlap` re-reads already covered positions and is deduplicated below the head;
-- `gap` leaves an open range until a covering reconciliation or a new baseline.
CREATE TABLE source.feed_checkpoint (
  id uuid PRIMARY KEY,
  feed_id uuid NOT NULL REFERENCES source.feed(id),
  seq integer NOT NULL CHECK (seq >= 1),
  predecessor_id uuid UNIQUE REFERENCES source.feed_checkpoint(id),
  kind text NOT NULL CHECK (kind IN ('baseline', 'change', 'reconciliation')),
  run_id uuid NOT NULL REFERENCES source.acquisition_run(id),
  capture_id uuid UNIQUE REFERENCES source.run_capture(id),
  from_position numeric(38,0) NOT NULL CHECK (from_position >= 0),
  to_position numeric(38,0) NOT NULL,
  resume_token text CHECK (length(resume_token) BETWEEN 1 AND 1000 AND resume_token !~ '[[:cntrl:]]'),
  item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 10000),
  continuity text NOT NULL CHECK (continuity IN ('baseline', 'contiguous', 'overlap', 'gap', 'reconciled')),
  closes_gap_id uuid REFERENCES source.feed_checkpoint(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feed_id, seq),
  CHECK (to_position >= from_position),
  CHECK ((seq = 1) = (predecessor_id IS NULL)),
  CHECK (seq > 1 OR kind = 'baseline'),
  CHECK ((kind = 'baseline') = (continuity = 'baseline')),
  CHECK ((kind = 'reconciliation') = (continuity = 'reconciled')),
  CHECK ((kind = 'reconciliation') = (closes_gap_id IS NOT NULL)),
  CHECK ((kind = 'baseline') = (capture_id IS NULL))
);
CREATE INDEX feed_checkpoint_run_idx ON source.feed_checkpoint (run_id, id);
CREATE TRIGGER source_feed_checkpoint_immutable BEFORE UPDATE OR DELETE ON source.feed_checkpoint
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.feed_head (
  feed_id uuid PRIMARY KEY REFERENCES source.feed(id),
  checkpoint_id uuid UNIQUE REFERENCES source.feed_checkpoint(id),
  seq integer NOT NULL DEFAULT 0 CHECK (seq >= 0),
  position numeric(38,0),
  CHECK ((seq = 0) = (checkpoint_id IS NULL AND position IS NULL))
);

CREATE TABLE source.feed_open_gap (
  checkpoint_id uuid PRIMARY KEY REFERENCES source.feed_checkpoint(id),
  feed_id uuid NOT NULL REFERENCES source.feed(id),
  gap_from numeric(38,0) NOT NULL,
  gap_to numeric(38,0) NOT NULL,
  CHECK (gap_to >= gap_from)
);
CREATE INDEX feed_open_gap_feed_idx ON source.feed_open_gap (feed_id, gap_from);

CREATE FUNCTION source.initialize_feed_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source.feed_head (feed_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER source_feed_head_initialize AFTER INSERT ON source.feed
  FOR EACH ROW EXECUTE FUNCTION source.initialize_feed_head();

CREATE FUNCTION source.check_feed_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head source.feed_head; feed_row source.feed; derived text; gap source.feed_open_gap;
BEGIN
  SELECT * INTO head FROM source.feed_head WHERE feed_id = NEW.feed_id FOR UPDATE;
  IF NOT FOUND OR NEW.seq <> head.seq + 1 OR NEW.predecessor_id IS DISTINCT FROM head.checkpoint_id THEN
    RAISE EXCEPTION 'feed checkpoint must extend the current head'
      USING ERRCODE = '23514', CONSTRAINT = 'feed_checkpoint_head';
  END IF;
  SELECT * INTO feed_row FROM source.feed WHERE id = NEW.feed_id;
  IF NEW.item_count > feed_row.max_page_items OR NOT EXISTS (SELECT 1 FROM source.acquisition_run
      WHERE id = NEW.run_id AND principal_id = feed_row.principal_id AND provider = feed_row.provider) THEN
    RAISE EXCEPTION 'feed checkpoint run or page differs from the feed'
      USING ERRCODE = '23514', CONSTRAINT = 'feed_checkpoint_run';
  END IF;
  IF NEW.kind = 'baseline' THEN
    -- Only a completed run is a complete baseline; a partial dump never is (LIVE02).
    IF NOT EXISTS (SELECT 1 FROM source.acquisition_run_completion
        WHERE run_id = NEW.run_id AND outcome = 'completed') THEN
      RAISE EXCEPTION 'feed baseline needs a completed acquisition run'
        USING ERRCODE = '23514', CONSTRAINT = 'feed_checkpoint_baseline';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM source.run_capture WHERE id = NEW.capture_id AND run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'feed checkpoint page is not a capture of its run'
      USING ERRCODE = '23514', CONSTRAINT = 'feed_checkpoint_run';
  END IF;
  IF NEW.kind = 'reconciliation' THEN
    SELECT * INTO gap FROM source.feed_open_gap WHERE checkpoint_id = NEW.closes_gap_id AND feed_id = NEW.feed_id;
    IF NOT FOUND OR NEW.from_position > gap.gap_from OR NEW.to_position < gap.gap_to THEN
      RAISE EXCEPTION 'reconciliation must cover one open gap'
        USING ERRCODE = '23514', CONSTRAINT = 'feed_checkpoint_reconciliation';
    END IF;
    RETURN NEW;
  END IF;
  derived := CASE WHEN NEW.from_position <= head.position THEN 'overlap'
    WHEN NEW.from_position = head.position + 1 THEN 'contiguous' ELSE 'gap' END;
  IF NEW.continuity <> derived THEN
    RAISE EXCEPTION 'feed checkpoint continuity differs from the head position'
      USING ERRCODE = '23514', CONSTRAINT = 'feed_checkpoint_continuity';
  END IF;
  IF derived = 'gap' AND (SELECT count(*) FROM source.feed_open_gap WHERE feed_id = NEW.feed_id) >= 64 THEN
    RAISE EXCEPTION 'feed has too many open gaps; take a new baseline'
      USING ERRCODE = '23514', CONSTRAINT = 'feed_open_gap_limit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_feed_checkpoint_check BEFORE INSERT ON source.feed_checkpoint
  FOR EACH ROW EXECUTE FUNCTION source.check_feed_checkpoint();

CREATE FUNCTION source.advance_feed_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'baseline' THEN
    DELETE FROM source.feed_open_gap WHERE feed_id = NEW.feed_id;
    UPDATE source.feed_head SET checkpoint_id = NEW.id, seq = NEW.seq, position = NEW.to_position
      WHERE feed_id = NEW.feed_id;
  ELSIF NEW.kind = 'reconciliation' THEN
    DELETE FROM source.feed_open_gap WHERE checkpoint_id = NEW.closes_gap_id;
    UPDATE source.feed_head SET checkpoint_id = NEW.id, seq = NEW.seq WHERE feed_id = NEW.feed_id;
  ELSE
    IF NEW.continuity = 'gap' THEN
      INSERT INTO source.feed_open_gap (checkpoint_id, feed_id, gap_from, gap_to)
      SELECT NEW.id, NEW.feed_id, position + 1, NEW.from_position - 1
        FROM source.feed_head WHERE feed_id = NEW.feed_id;
    END IF;
    UPDATE source.feed_head SET checkpoint_id = NEW.id, seq = NEW.seq,
      position = GREATEST(position, NEW.to_position) WHERE feed_id = NEW.feed_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_feed_head_advance AFTER INSERT ON source.feed_checkpoint
  FOR EACH ROW EXECUTE FUNCTION source.advance_feed_head();
