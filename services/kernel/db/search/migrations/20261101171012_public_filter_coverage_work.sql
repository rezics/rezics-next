-- migrate:up
-- Native work snapshots are reservations on the existing root, not authority.
-- Every counter survives command replay, uncertain dispatch and abandonment.
CREATE FUNCTION search.public_filter_coverage_work_advances(before_encoded text,after_encoded text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  before_work jsonb := semantic.public_filter_native_json(before_encoded::jsonb);
  after_work jsonb := semantic.public_filter_native_json(after_encoded::jsonb);
  counter record;
  before_value numeric;
  after_value numeric;
BEGIN
  IF jsonb_typeof(before_work) IS DISTINCT FROM 'object'
    OR jsonb_typeof(after_work) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(before_work) key)
      IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(after_work) key)
    OR NOT before_work ?& ARRAY['inputKeys','candidates','accessPoints','dependencyPoints',
      'engineSearches','engineIteratorSteps','outputSlots','resultWrites','frontierWrites',
      'statements','rows','bytes','engineRequests'] THEN
    RETURN false;
  END IF;
  FOR counter IN SELECT key,value FROM jsonb_each(before_work) LOOP
    IF jsonb_typeof(counter.value) IS DISTINCT FROM 'number'
      OR jsonb_typeof(after_work->counter.key) IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    before_value := counter.value::text::numeric;
    after_value := (after_work->counter.key)::text::numeric;
    IF before_value<0 OR before_value<>trunc(before_value)
      OR after_value<before_value OR after_value<>trunc(after_value)
      OR after_value>9007199254740991 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

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
  IF NEW.work IS DISTINCT FROM OLD.work
    AND NOT search.public_filter_coverage_work_advances(OLD.work,NEW.work) THEN
    RAISE EXCEPTION 'Native page work cannot refund reservations' USING ERRCODE='23514';
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
        AND OLD.tail_consumed IS NULL AND NEW.tail_consumed IS NOT NULL)
      -- Persist a funded command without changing its pending custody. This is
      -- used by the same atomic engine-fence statement, before external I/O.
      OR (OLD.pending IS NOT NULL AND NEW.pending=OLD.pending
        AND (NEW.rounds,NEW.charged,NEW.tail,NEW.tail_consumed)
          IS NOT DISTINCT FROM (OLD.rounds,OLD.charged,OLD.tail,OLD.tail_consumed)
        AND NEW.work IS DISTINCT FROM OLD.work
        AND (semantic.public_filter_native_json(NEW.work::jsonb)->>'statements')::numeric
          >(semantic.public_filter_native_json(OLD.work::jsonb)->>'statements')::numeric
        AND (semantic.public_filter_native_json(NEW.work::jsonb)->>'frontierWrites')::numeric
          >(semantic.public_filter_native_json(OLD.work::jsonb)->>'frontierWrites')::numeric)))
    OR (NEW.state IN ('sealed','finished') AND (NEW.pending IS NOT NULL OR NEW.tail IS NULL
      OR NEW.tail_consumed IS NULL OR NEW.rounds=0))
  THEN RAISE EXCEPTION 'Invalid native page transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native dispatch reservations cannot be refunded';
END $$;
