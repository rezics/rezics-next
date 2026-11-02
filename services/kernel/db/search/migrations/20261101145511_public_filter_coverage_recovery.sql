-- migrate:up
-- Existing ambiguous children retain NULL; only new native reservations begin false.
ALTER TABLE search.public_filter_execution
  ADD COLUMN page_engine_started boolean,
  DROP CONSTRAINT public_filter_execution_page_shape,
  ADD CONSTRAINT public_filter_execution_page_shape CHECK
    ((page_id IS NULL AND page_ordinal IS NULL AND page_parent IS NULL AND page_consumed IS NULL
      AND page_size IS NULL AND page_raw IS NULL AND page_status IS NULL AND page_engine_started IS NULL)
     OR (page_id IS NOT NULL AND page_ordinal IS NOT NULL AND page_consumed IS NOT NULL
      AND page_size IS NOT NULL AND page_status IS NOT NULL AND ((page_status='dispatched' AND page_raw IS NULL)
        OR (page_status='complete' AND page_raw IS NOT NULL AND page_raw<=page_size))));

CREATE INDEX public_filter_coverage_page_drain ON search.public_filter_coverage_page(partition_no,observation,id)
  WHERE state IN ('planned','open','sealed');

CREATE OR REPLACE FUNCTION search.guard_public_filter_coverage_page() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- A failed reservation is retired only with its drained original observation.
    -- Never clear or refund it to make an uncertain execution appear completed.
    IF NOT FOUND OR (OLD.pending IS NOT NULL AND OLD.state<>'failed')
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

CREATE OR REPLACE FUNCTION search.guard_public_filter_page_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.page_id IS NOT NULL AND OLD.page_status<>'complete' THEN
      -- Only a false dispatch fence excludes unknown engine successors. Older
      -- children and lost engine receipts retain their original obligations.
      -- Known locators must also have left native custody through actual drain.
      PERFORM 1 FROM search.public_filter_observation o
      JOIN search.public_filter_coverage_page p ON (p.partition_no,p.id)=(OLD.partition_no,OLD.page_id)
        AND p.observation=o.observation AND p.state='failed' AND p.pending=OLD.id
        AND p.rounds=OLD.page_ordinal AND p.charged>=OLD.page_size
      WHERE (o.partition_no,o.observation)=(OLD.partition_no,OLD.observation)
        AND OLD.page_engine_started IS FALSE
        AND o.state IN ('closing','closed')
        AND NOT EXISTS (SELECT 1 FROM search.public_filter_reference f
          WHERE (f.partition_no,f.observation)=(o.partition_no,o.observation))
        AND NOT EXISTS (SELECT 1 FROM search.public_filter_pit t
          WHERE (t.partition_no,t.observation)=(o.partition_no,o.observation))
      FOR UPDATE OF o,p;
      IF NOT FOUND THEN RAISE EXCEPTION 'Native dispatched child has not drained' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.page_id IS NOT NULL THEN
      PERFORM 1 FROM search.public_filter_coverage_page WHERE (partition_no,id)=(NEW.partition_no,NEW.page_id)
        AND observation=NEW.observation AND state='open' AND pending=NEW.id AND rounds=NEW.page_ordinal FOR UPDATE;
      IF NOT FOUND OR NEW.page_status<>'dispatched' OR NEW.consumer_window IS NOT NULL
        OR NEW.page_engine_started IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'Native child was not reserved' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.page_engine_started IS DISTINCT FROM NEW.page_engine_started THEN
    IF OLD.page_id IS NULL OR OLD.page_engine_started IS DISTINCT FROM false
      OR NEW.page_engine_started IS DISTINCT FROM true OR OLD.page_status<>'dispatched'
      OR NEW.page_status<>'dispatched' OR NEW.execution IS DISTINCT FROM OLD.execution
      OR NEW.consumer_window IS NOT NULL OR NEW.page_raw IS NOT NULL THEN
      RAISE EXCEPTION 'Native engine dispatch is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM search.public_filter_coverage_page p
    JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(p.partition_no,p.observation)
    WHERE (p.partition_no,p.id)=(OLD.partition_no,OLD.page_id) AND p.observation=OLD.observation
      AND p.state='open' AND p.pending=OLD.id AND o.state='open'
      AND p.deadline>floor(extract(epoch FROM clock_timestamp())*1000)
      AND EXISTS (SELECT 1 FROM search.public_filter_reference f
        WHERE (f.partition_no,f.observation)=(o.partition_no,o.observation)
          AND f.expires_at>floor(extract(epoch FROM clock_timestamp())*1000))
    FOR UPDATE OF p FOR SHARE OF o;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native engine dispatch is not admitted' USING ERRCODE='23514'; END IF;
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

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native failed-page retirement requires original observation drain';
END $$;
