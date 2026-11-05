-- migrate:up
-- A page is an extension of the original observation and Source start, not a
-- second permission ledger. Its immutable plan is closed before Source start.
CREATE TABLE search.public_filter_coverage_page (
  partition_no integer NOT NULL,
  id uuid NOT NULL,
  observation text NOT NULL,
  registration text NOT NULL,
  definition text NOT NULL CHECK (octet_length(definition)<=1048576),
  consumer text NOT NULL CHECK (octet_length(consumer)<=65536),
  deadline bigint NOT NULL,
  boundary text,
  boundary_consumed integer NOT NULL CHECK (boundary_consumed BETWEEN 0 AND 200),
  boundary_window text CHECK (octet_length(boundary_window)<=1048576),
  ceiling integer NOT NULL CHECK (ceiling BETWEEN 1 AND 600),
  state text NOT NULL CHECK (state IN ('planned','open','sealed','finished','failed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  rounds integer NOT NULL DEFAULT 0 CHECK (rounds BETWEEN 0 AND 3),
  charged integer NOT NULL DEFAULT 0 CHECK (charged>=0 AND charged<=ceiling),
  tail text,
  tail_consumed integer CHECK (tail_consumed BETWEEN 0 AND 200),
  pending text,
  work text NOT NULL CHECK (octet_length(work)<=65536),
  PRIMARY KEY (partition_no,id),
  FOREIGN KEY (partition_no,observation) REFERENCES search.public_filter_observation(partition_no,observation),
  FOREIGN KEY (partition_no,registration) REFERENCES search.public_filter_registration(partition_no,id),
  CHECK ((boundary IS NULL AND boundary_window IS NULL AND boundary_consumed=0)
    OR (boundary IS NOT NULL AND boundary_window IS NOT NULL))
);
CREATE INDEX public_filter_coverage_page_observation ON search.public_filter_coverage_page(partition_no,observation,id);
CREATE INDEX public_filter_coverage_page_active ON search.public_filter_coverage_page(partition_no,observation)
  WHERE state IN ('planned','open','sealed') OR pending IS NOT NULL;
ALTER TABLE search.public_filter_execution
  ADD COLUMN page_id uuid,
  ADD COLUMN page_ordinal integer CHECK (page_ordinal BETWEEN 1 AND 3),
  ADD COLUMN page_parent text,
  ADD COLUMN page_consumed integer CHECK (page_consumed BETWEEN 0 AND 200),
  ADD COLUMN page_size integer CHECK (page_size BETWEEN 1 AND 200),
  ADD COLUMN page_raw integer CHECK (page_raw BETWEEN 0 AND 200),
  ADD COLUMN page_status text CHECK (page_status IN ('dispatched','complete')),
  ADD CONSTRAINT public_filter_execution_page_shape CHECK
    ((page_id IS NULL AND page_ordinal IS NULL AND page_parent IS NULL AND page_consumed IS NULL
      AND page_size IS NULL AND page_raw IS NULL AND page_status IS NULL)
     OR (page_id IS NOT NULL AND page_ordinal IS NOT NULL AND page_consumed IS NOT NULL
      AND page_size IS NOT NULL AND page_status IS NOT NULL AND ((page_status='dispatched' AND page_raw IS NULL)
        OR (page_status='complete' AND page_raw IS NOT NULL AND page_raw<=page_size)))),
  ADD CONSTRAINT public_filter_execution_page_fkey FOREIGN KEY (partition_no,page_id)
    REFERENCES search.public_filter_coverage_page(partition_no,id);
CREATE UNIQUE INDEX public_filter_execution_page ON search.public_filter_execution(partition_no,page_id,page_ordinal)
  WHERE page_id IS NOT NULL;

CREATE FUNCTION search.guard_public_filter_coverage_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'planned' OR NEW.revision<>1 OR NEW.rounds<>0 OR NEW.charged<>0
      OR NEW.tail IS NOT NULL OR NEW.tail_consumed IS NOT NULL OR NEW.pending IS NOT NULL THEN
      RAISE EXCEPTION 'Native page must begin with a closed plan' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM search.public_filter_observation WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation)
      AND state IN ('closing','closed') FOR UPDATE;
    IF NOT FOUND OR OLD.pending IS NOT NULL
      OR EXISTS (SELECT 1 FROM search.public_filter_execution WHERE partition_no=OLD.partition_no AND page_id=OLD.id)
      OR EXISTS (SELECT 1 FROM search.public_filter_reference WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
      OR EXISTS (SELECT 1 FROM search.public_filter_pit WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
    THEN RAISE EXCEPTION 'Native page obligations have not drained' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.partition_no,NEW.id,NEW.observation,NEW.registration,NEW.definition,NEW.consumer,NEW.deadline,
      NEW.boundary,NEW.boundary_consumed,NEW.boundary_window,NEW.ceiling)
    IS DISTINCT FROM (OLD.partition_no,OLD.id,OLD.observation,OLD.registration,OLD.definition,OLD.consumer,OLD.deadline,
      OLD.boundary,OLD.boundary_consumed,OLD.boundary_window,OLD.ceiling)
    OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.state='planned' AND NEW.state IN ('open','failed'))
      OR (OLD.state='open' AND NEW.state IN ('open','sealed','failed'))
      OR (OLD.state='sealed' AND NEW.state IN ('finished','failed')))
    OR ((OLD.state<>'open' OR NEW.state<>'open') AND
      (NEW.rounds,NEW.charged,NEW.tail,NEW.tail_consumed,NEW.pending)
        IS DISTINCT FROM (OLD.rounds,OLD.charged,OLD.tail,OLD.tail_consumed,OLD.pending))
    OR (OLD.state='open' AND NEW.state='open' AND NOT (
      (OLD.pending IS NULL AND NEW.pending IS NOT NULL AND NEW.rounds=OLD.rounds+1 AND NEW.tail IS NOT DISTINCT FROM OLD.tail
        AND NEW.charged>OLD.charged AND NEW.tail_consumed IS NOT DISTINCT FROM OLD.tail_consumed)
      OR (OLD.pending IS NOT NULL AND NEW.pending IS NULL AND NEW.rounds=OLD.rounds AND NEW.tail=OLD.pending
        AND NEW.charged<=OLD.charged AND NEW.tail_consumed IS NULL)
      OR (OLD.pending IS NULL AND NEW.pending IS NULL AND NEW.tail IS NOT DISTINCT FROM OLD.tail
        AND OLD.tail IS NOT NULL
        AND NEW.rounds=OLD.rounds AND NEW.charged=OLD.charged
        AND OLD.tail_consumed IS NULL AND NEW.tail_consumed IS NOT NULL)))
    OR (NEW.state IN ('sealed','finished') AND (NEW.pending IS NOT NULL OR NEW.tail IS NULL
      OR NEW.tail_consumed IS NULL OR NEW.rounds=0))
  THEN RAISE EXCEPTION 'Invalid native page transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_coverage_page_guard BEFORE INSERT OR UPDATE OR DELETE ON search.public_filter_coverage_page
  FOR EACH ROW EXECUTE FUNCTION search.guard_public_filter_coverage_page();

CREATE FUNCTION search.guard_public_filter_page_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.page_id IS NOT NULL AND OLD.page_status<>'complete' THEN
      RAISE EXCEPTION 'Native dispatched child has not settled' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.page_id IS NOT NULL THEN
      PERFORM 1 FROM search.public_filter_coverage_page WHERE (partition_no,id)=(NEW.partition_no,NEW.page_id)
        AND observation=NEW.observation AND state='open' AND pending=NEW.id AND rounds=NEW.page_ordinal FOR UPDATE;
      IF NOT FOUND OR NEW.page_status<>'dispatched' OR NEW.consumer_window IS NOT NULL THEN
        RAISE EXCEPTION 'Native child was not reserved' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.page_id IS DISTINCT FROM NEW.page_id OR (OLD.page_id IS NOT NULL AND (
      (NEW.partition_no,NEW.observation,NEW.id,NEW.page_ordinal,NEW.page_parent,NEW.page_consumed,NEW.page_size)
       IS DISTINCT FROM (OLD.partition_no,OLD.observation,OLD.id,OLD.page_ordinal,OLD.page_parent,OLD.page_consumed,OLD.page_size))) THEN
    RAISE EXCEPTION 'Native page execution identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.page_id IS NOT NULL AND (NEW.execution IS DISTINCT FROM OLD.execution OR NEW.consumer_window IS DISTINCT FROM OLD.consumer_window
      OR NEW.page_status IS DISTINCT FROM OLD.page_status OR NEW.page_raw IS DISTINCT FROM OLD.page_raw) THEN
    IF OLD.page_id IS NULL OR OLD.page_status<>'dispatched' OR NEW.page_status<>'complete'
      OR OLD.consumer_window IS NOT NULL OR NEW.consumer_window IS NULL THEN
      RAISE EXCEPTION 'Native page execution is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM search.public_filter_coverage_page WHERE (partition_no,id)=(OLD.partition_no,OLD.page_id)
      AND state='open' AND pending=OLD.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native page is sealed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_page_execution_guard BEFORE INSERT OR UPDATE OR DELETE ON search.public_filter_execution
  FOR EACH ROW EXECUTE FUNCTION search.guard_public_filter_page_execution();

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native response pages require original observation retirement';
END $$;
