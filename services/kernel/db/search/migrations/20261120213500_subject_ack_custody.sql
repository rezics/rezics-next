-- migrate:up
ALTER TABLE search.generation_publication ADD COLUMN ack_protocol smallint NOT NULL DEFAULT 0
  CHECK (ack_protocol=0 OR (ack_protocol=1 AND family='subjects' AND source_home=0));
CREATE TRIGGER generation_publication_ack_protocol_immutable
  BEFORE UPDATE OF ack_protocol ON search.generation_publication
  FOR EACH ROW WHEN (OLD.ack_protocol IS DISTINCT FROM NEW.ack_protocol)
  EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- Retirement releases the original native references only after observation admission
-- has closed and actual readers and PITs have drained. Keep the original protocol pin.
ALTER TABLE search.public_filter_coverage_preparation ADD COLUMN ack_retired boolean NOT NULL DEFAULT false
  CHECK (NOT ack_retired OR ack_protocol=1);
CREATE TRIGGER public_filter_ack_retirement_immutable
  BEFORE UPDATE OF ack_retired ON search.public_filter_coverage_preparation
  FOR EACH ROW WHEN (OLD.ack_retired AND NOT NEW.ack_retired)
  EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE UNIQUE INDEX public_filter_ack_manifest_observation
  ON search.public_filter_ack_manifest(partition_no,observation);

DROP TRIGGER public_filter_ack_manifest_immutable ON search.public_filter_ack_manifest;
CREATE TRIGGER public_filter_ack_manifest_immutable BEFORE UPDATE ON search.public_filter_ack_manifest
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE FUNCTION search.retire_public_filter_ack_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM FROM search.public_filter_observation o
    WHERE (o.partition_no,o.observation)=(OLD.partition_no,OLD.observation)
      AND o.state IN ('closing','closed') FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT FROM search.public_filter_reference f
    WHERE (f.partition_no,f.observation)=(OLD.partition_no,OLD.observation))
    OR EXISTS (SELECT FROM search.public_filter_pit p
      WHERE (p.partition_no,p.observation)=(OLD.partition_no,OLD.observation)) THEN
    RAISE EXCEPTION 'Original receiver manifest still has observation custody' USING ERRCODE='23514';
  END IF;
  UPDATE search.public_filter_coverage_preparation SET ack_retired=true
    WHERE (partition_no,registration,bootstrap)=(OLD.partition_no,OLD.registration,OLD.bootstrap);
  RETURN OLD;
END $$;
CREATE TRIGGER public_filter_ack_manifest_retire BEFORE DELETE ON search.public_filter_ack_manifest
  FOR EACH ROW EXECUTE FUNCTION search.retire_public_filter_ack_manifest();

CREATE FUNCTION search.require_public_filter_ack_live_cut() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM FROM search.public_filter_coverage_preparation c
    WHERE (c.partition_no,c.registration,c.bootstrap)=(NEW.partition_no,NEW.registration,NEW.bootstrap)
      AND c.ack_protocol=1 AND NOT c.ack_retired FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original receiver ACK cut has retired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
-- Runs after the bind trigger fills the original native keys.
CREATE TRIGGER public_filter_ack_manifest_live BEFORE INSERT ON search.public_filter_ack_manifest
  FOR EACH ROW EXECUTE FUNCTION search.require_public_filter_ack_live_cut();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'A retired receiver manifest requires forward migration'; END $$;
