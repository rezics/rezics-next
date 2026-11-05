-- migrate:up
-- The original Source cut retains locators only. Search keeps generation and engine custody.
ALTER TABLE semantic.public_filter_bootstrap
  ADD COLUMN publication_job uuid,
  ADD COLUMN publication_observation text,
  ADD COLUMN publication_execution text,
  ADD CONSTRAINT public_filter_bootstrap_publication_tuple CHECK (
    (publication_job IS NULL AND publication_observation IS NULL AND publication_execution IS NULL)
    OR (publication_job IS NOT NULL AND publication_observation IS NOT NULL AND publication_execution IS NOT NULL
      AND octet_length(publication_observation) BETWEEN 1 AND 4096
      AND octet_length(publication_execution) BETWEEN 1 AND 4096));
CREATE UNIQUE INDEX public_filter_bootstrap_publication_job
  ON semantic.public_filter_bootstrap(partition_no,publication_job) WHERE publication_job IS NOT NULL;

CREATE FUNCTION semantic.retain_public_filter_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.publication_job IS NOT NULL THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'Original Source publication requires native retirement' USING ERRCODE='23514';
    END IF;
    IF (NEW.publication_job,NEW.publication_observation,NEW.publication_execution,
        NEW.bootstrap,NEW.read_definition,NEW.consumer,NEW.snapshot_kind,NEW.native_snapshot::text,
        NEW.owner_epoch,NEW.source_position,NEW.coverage_generation,NEW.coverage_root,NEW.coverage_sealed)
      IS DISTINCT FROM
       (OLD.publication_job,OLD.publication_observation,OLD.publication_execution,
        OLD.bootstrap,OLD.read_definition,OLD.consumer,OLD.snapshot_kind,OLD.native_snapshot::text,
        OLD.owner_epoch,OLD.source_position,OLD.coverage_generation,OLD.coverage_root,OLD.coverage_sealed) THEN
      RAISE EXCEPTION 'Original Source publication operands are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.publication_job IS NOT NULL AND
    (NEW.snapshot_kind<>'prepared' OR NOT NEW.coverage_sealed
      OR NEW.state NOT IN ('begun','adopted','aborting','aborted')
      OR (NEW.queried IS NOT NULL AND NEW.queried<>NEW.publication_observation)) THEN
    RAISE EXCEPTION 'Source publication requires its original prepared observation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_bootstrap_publication_immutable
  BEFORE UPDATE OR DELETE ON semantic.public_filter_bootstrap
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_publication();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original Source publication requires native retirement'; END $$;
