-- migrate:up
-- Preserve provisional rows and their copy keys; only new native rows carry a structured revision.
ALTER TABLE core.record_history_source_set
 ALTER COLUMN member_count DROP NOT NULL,
 DROP CONSTRAINT record_history_source_set_member_count_check,
 ADD CHECK(member_count BETWEEN 0 AND 512),
 ADD COLUMN native_revision integer CHECK(native_revision>0),
 ADD COLUMN snapshot_digest text CHECK(snapshot_digest<>''),
 ADD COLUMN metadata_state text NOT NULL DEFAULT 'legacy' CHECK(metadata_state IN ('legacy','building','native-snapshot')),
 ADD CHECK (
   (metadata_state='legacy' AND native_revision IS NULL AND snapshot_digest IS NULL AND member_count IS NOT NULL)
   OR (metadata_state='building' AND native_revision IS NOT NULL AND snapshot_digest IS NULL AND member_count IS NULL)
   OR (metadata_state='native-snapshot' AND native_revision IS NOT NULL AND snapshot_digest IS NOT NULL AND member_count IS NOT NULL)
 );
ALTER TABLE core.record_history_purge_set
 DROP CONSTRAINT record_history_purge_set_member_count_check,
 ADD CHECK(member_count BETWEEN 0 AND 512),
 ADD COLUMN native_revision integer CHECK(native_revision>0),
 ADD COLUMN snapshot_digest text CHECK(snapshot_digest<>''),
 ADD CHECK((native_revision IS NULL)=(snapshot_digest IS NULL));
ALTER TABLE core.record_history_purge
 ADD COLUMN native_set_frontier text,
 ADD COLUMN native_set_index_complete boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION core.record_history_preserve_source_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514'; END IF;
 -- The one allowed enrichment is an exact native immutable snapshot after Source seal.
 IF to_jsonb(OLD)->>'metadata_state'='building' AND to_jsonb(NEW)->>'metadata_state'='native-snapshot' THEN
  IF (to_jsonb(NEW)-ARRAY['original_position','metadata_state','snapshot_digest','member_count'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['original_position','metadata_state','snapshot_digest','member_count'])
     OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position) THEN
   RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['original_position','state','next_attempt','gap'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['original_position','state','next_attempt','gap'])
   OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position)
   OR (to_jsonb(OLD)->>'state'='minimized' AND to_jsonb(NEW)->>'state'<>'minimized') THEN
   RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
-- migrate:down
-- Forward only: retain original source and copy provenance.
