-- migrate:up
-- Activate under migration DDL locks. Old observations and prepared writers cannot
-- create foreign identities without the same native receiving transaction.
CREATE FUNCTION library.guard_live_copy_listing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.route,NEW.subject_id,NEW.collection_id,NEW.collection_route)
    IS DISTINCT FROM (OLD.route,OLD.subject_id,OLD.collection_id,OLD.collection_route) THEN
  RAISE EXCEPTION 'Live listing identity is immutable' USING ERRCODE='23514';
 END IF;
 -- Negative cleanup may advance an EXISTING exclusion cut, but cannot insert a
 -- new personal identity or make a relationship positive. Delayed apply still
 -- goes through the immutable gate and monotone version CAS.
 IF TG_TABLE_NAME='subject_collection_version' AND TG_OP='UPDATE' AND NEW.multiplicity=0
   AND NEW.source_partition=OLD.source_partition
   AND (NEW.source_epoch,NEW.source_position)>=(OLD.source_epoch,OLD.source_position) THEN
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM access.live_copy_gate g
   WHERE g.route=NEW.route AND g.applying_transaction=pg_current_xact_id() AND g.outcome='applying'
     AND g.module='library.subject-listing' AND NOT g.retired
     AND g.payload->>'subjectId'=NEW.subject_id::text AND g.payload->>'collectionId'=NEW.collection_id::text
     AND (g.payload->>'collectionRoute')::integer=NEW.collection_route
     AND (g.payload->>'multiplicity')::integer=NEW.multiplicity
     AND (g.payload->'stamp'->>'partition')::integer=NEW.source_partition
     AND (g.payload->'stamp'->>'epoch')::integer=NEW.source_epoch
     AND (g.payload->'stamp'->>'position')::bigint=NEW.source_position) THEN
  RAISE EXCEPTION 'Listing write requires native live receiving gate' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER live_copy_listing_guard BEFORE INSERT OR UPDATE ON library.subject_collection
 FOR EACH ROW EXECUTE FUNCTION library.guard_live_copy_listing();
CREATE TRIGGER live_copy_listing_version_guard BEFORE INSERT OR UPDATE ON library.subject_collection_version
 FOR EACH ROW EXECUTE FUNCTION library.guard_live_copy_listing();
-- migrate:down
-- Forward only: terminal exclusion must not be disabled during rollback.
