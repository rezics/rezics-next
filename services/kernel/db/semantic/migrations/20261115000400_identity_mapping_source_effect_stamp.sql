-- migrate:up
-- The plan payload is deleted after the next released control acknowledgement.
-- A later unit cannot recover original or action from it, from the current fence,
-- or by recomputing the source image. The source command stamps both on the
-- effect row in the same image fill. Unstamped rows stay unproved.
ALTER TABLE semantic.identity_epoch_mapping_effect
 ADD COLUMN source_original uuid,
 ADD COLUMN source_action text,
 ADD CONSTRAINT identity_epoch_mapping_source_effect_stamp CHECK (
  (source_original IS NULL AND source_action IS NULL)
  OR (source_action IS NOT DISTINCT FROM 'source' AND source_original IS NOT NULL
    AND partition_no=((get_byte(uuid_send(source_original),10)*256+get_byte(uuid_send(source_original),11))/16))
 );

CREATE INDEX identity_epoch_mapping_effect_source_point
 ON semantic.identity_epoch_mapping_effect(partition_no,job_id,source_original,unit DESC)
 WHERE source_action='source';

CREATE FUNCTION semantic.capture_identity_epoch_source_image(
 p_home integer,p_job uuid,p_epoch bigint,p_unit integer,p_scope text,p_frame uuid,
 p_original uuid,p_action text
) RETURNS bytea LANGUAGE plpgsql AS $$
DECLARE saved record;destinations uuid[];image bytea;
BEGIN
 SELECT e.*,e.xmin::text AS creator_xid INTO saved
 FROM semantic.identity_epoch_mapping_effect e
 WHERE e.partition_no=p_home AND e.job_id=p_job AND e.unit=p_unit FOR UPDATE;
 IF NOT FOUND OR saved.creator_xid IS DISTINCT FROM pg_current_xact_id()::xid::text
  OR saved.job_epoch IS DISTINCT FROM p_epoch OR saved.scope_digest IS DISTINCT FROM p_scope
  OR saved.transaction_id IS DISTINCT FROM p_frame THEN
  RAISE EXCEPTION 'Native source image requires its exact effect frame' USING ERRCODE='23514';
 END IF;
 IF (p_original IS NULL) IS DISTINCT FROM (p_action IS NULL)
  OR (p_action IS NOT NULL AND p_action IS DISTINCT FROM 'source') THEN
  RAISE EXCEPTION 'Native source effect stamp does not match its frame' USING ERRCODE='23514';
 END IF;
 SELECT array_agg(f.destination) INTO destinations FROM (
  SELECT destination FROM semantic.identity_epoch_mapping_fence
  WHERE route/16=p_home AND transaction_id=p_frame AND job_id=p_job AND job_epoch=p_epoch
  ORDER BY route,destination LIMIT 2
 ) f;
 IF destinations IS NULL THEN
  IF p_original IS NOT NULL OR p_action IS NOT NULL THEN
   RAISE EXCEPTION 'Native source effect stamp does not match its frame' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
 END IF;
 IF cardinality(destinations)<>1 THEN
  RAISE EXCEPTION 'Native source image requires one source gate' USING ERRCODE='23514';
 END IF;
 IF p_action IS NOT NULL AND p_original IS DISTINCT FROM destinations[1] THEN
  RAISE EXCEPTION 'Native source effect stamp does not match its frame' USING ERRCODE='23514';
 END IF;
 IF saved.source_image_version IS NOT NULL THEN
  image:=semantic.identity_epoch_source_image_v1(p_home,destinations[1],p_frame);
  IF saved.source_image_version<>1 OR image IS NULL OR image IS DISTINCT FROM saved.source_image_digest
   OR saved.source_original IS DISTINCT FROM p_original OR saved.source_action IS DISTINCT FROM p_action THEN
   RAISE EXCEPTION 'Native source image replay changed' USING ERRCODE='23514';
  END IF;
  RETURN image;
 END IF;
 UPDATE semantic.identity_epoch_mapping_effect
  SET source_image_version=1,source_original=p_original,source_action=p_action
 WHERE partition_no=p_home AND job_id=p_job AND unit=p_unit
 RETURNING source_image_digest INTO image;
 RETURN image;
END; $$;

-- Callers and tests that capture an image without a source action keep this
-- overload. It cannot stamp a row, so an old or non-source image stays unproved.
CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_source_image(
 p_home integer,p_job uuid,p_epoch bigint,p_unit integer,p_scope text,p_frame uuid
) RETURNS bytea LANGUAGE plpgsql AS $$
BEGIN
 RETURN semantic.capture_identity_epoch_source_image(
  p_home,p_job,p_epoch,p_unit,p_scope,p_frame,NULL::uuid,NULL::text);
END; $$;

CREATE OR REPLACE FUNCTION semantic.guard_identity_epoch_mapping_source_image() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creator text;destinations uuid[];image bytea;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_image_version IS NOT NULL OR NEW.source_image_digest IS NOT NULL
   OR NEW.source_original IS NOT NULL OR NEW.source_action IS NOT NULL THEN
   RAISE EXCEPTION 'Native source image must be captured after source writes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' THEN
  RAISE EXCEPTION 'Identity mapping effects are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.source_image_version IS NOT NULL OR OLD.source_image_digest IS NOT NULL
  OR NEW.source_image_version IS DISTINCT FROM 1::smallint OR NEW.source_image_digest IS NOT NULL
  OR OLD.source_original IS NOT NULL OR OLD.source_action IS NOT NULL
  OR (NEW.source_original IS NULL) IS DISTINCT FROM (NEW.source_action IS NULL)
  OR (NEW.source_action IS NOT NULL AND NEW.source_action IS DISTINCT FROM 'source')
  OR (to_jsonb(NEW)-ARRAY['source_image_version','source_image_digest','source_original','source_action'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['source_image_version','source_image_digest','source_original','source_action']) THEN
  RAISE EXCEPTION 'Identity mapping effects are immutable' USING ERRCODE='23514';
 END IF;
 SELECT e.xmin::text INTO creator FROM semantic.identity_epoch_mapping_effect e
  WHERE e.partition_no=OLD.partition_no AND e.job_id=OLD.job_id AND e.unit=OLD.unit;
 IF creator IS DISTINCT FROM pg_current_xact_id()::xid::text THEN
  RAISE EXCEPTION 'Native source image requires its original frame' USING ERRCODE='23514';
 END IF;
 SELECT array_agg(f.destination) INTO destinations FROM (
  SELECT destination FROM semantic.identity_epoch_mapping_fence
  WHERE route/16=OLD.partition_no AND transaction_id=OLD.transaction_id
   AND job_id=OLD.job_id AND job_epoch=OLD.job_epoch
  ORDER BY route,destination LIMIT 2
 ) f;
 IF cardinality(destinations) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'Native source image requires one source gate' USING ERRCODE='23514';
 END IF;
 IF NEW.source_action IS NOT NULL AND (
  NEW.source_original IS DISTINCT FROM destinations[1] OR NOT EXISTS (
   SELECT 1 FROM semantic.identity_epoch_mapping_payload payload
   WHERE (payload.partition_no,payload.job_id,payload.unit)=(OLD.partition_no,OLD.job_id,OLD.unit)
    AND payload.xmin::text=creator AND payload.result->>'action'='source'
    AND payload.result->'change'->>'original'=NEW.source_original::text
  )
 ) THEN
  RAISE EXCEPTION 'Native source effect stamp does not match its frame' USING ERRCODE='23514';
 END IF;
 image:=semantic.identity_epoch_source_image_v1(OLD.partition_no,destinations[1],OLD.transaction_id);
 IF image IS NULL THEN
  RAISE EXCEPTION 'Native source image frame is unavailable' USING ERRCODE='23514';
 END IF;
 NEW.source_image_digest:=image;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION semantic.validate_identity_epoch_source_image_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE destinations uuid[];image bytea;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_native_commit n
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.write_state='active' AND p.position=n.position
  WHERE n.partition_no=NEW.partition_no AND n.transaction_id=NEW.transaction_id
   AND n.purpose='mapping' AND n.xmin::text=pg_current_xact_id()::xid::text
 ) THEN
  RAISE EXCEPTION 'Native source image lacks its committed command fence' USING ERRCODE='23514';
 END IF;
 SELECT array_agg(f.destination) INTO destinations FROM (
  SELECT destination FROM semantic.identity_epoch_mapping_fence
  WHERE route/16=NEW.partition_no AND transaction_id=NEW.transaction_id
   AND job_id=NEW.job_id AND job_epoch=NEW.job_epoch
  ORDER BY route,destination LIMIT 2
 ) f;
 IF cardinality(destinations) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'Native source image commit frame changed' USING ERRCODE='23514';
 END IF;
 IF (NEW.source_original IS NULL) IS DISTINCT FROM (NEW.source_action IS NULL)
  OR (NEW.source_action IS NOT NULL AND (NEW.source_action IS DISTINCT FROM 'source'
   OR NEW.source_original IS DISTINCT FROM destinations[1])) THEN
  RAISE EXCEPTION 'Native source effect stamp does not match its frame' USING ERRCODE='23514';
 END IF;
 image:=semantic.identity_epoch_source_image_v1(NEW.partition_no,destinations[1],NEW.transaction_id);
 IF NEW.source_image_version IS DISTINCT FROM 1::smallint OR image IS NULL
  OR image IS DISTINCT FROM NEW.source_image_digest THEN
  RAISE EXCEPTION 'Native source image changed before commit' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Mapping source effect stamps require a forward migration'; END; $$;
