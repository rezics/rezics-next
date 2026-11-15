-- migrate:up
ALTER TABLE semantic.identity_epoch_mapping_effect
 ADD COLUMN source_image_version smallint,
 ADD COLUMN source_image_digest bytea,
 ADD CONSTRAINT identity_epoch_mapping_source_image_shape CHECK (
  (source_image_version IS NULL AND source_image_digest IS NULL)
  OR (source_image_version IS NOT NULL AND source_image_version=1
    AND source_image_digest IS NOT NULL AND octet_length(source_image_digest)=32)
 );

-- Each lookup stops at two rows so an invalid multi-effect or multi-gate frame
-- cannot acquire image custody. The image itself adds no secondary index payload.
CREATE INDEX identity_epoch_mapping_effect_native_frame
 ON semantic.identity_epoch_mapping_effect(partition_no,transaction_id);
CREATE INDEX identity_epoch_mapping_fence_native_frame
 ON semantic.identity_epoch_mapping_fence((route/16),transaction_id);
CREATE INDEX identity_epoch_home_gate_native_frame
 ON semantic.identity_epoch_home_gate(route,destination,recorded_transaction_id);

-- This is an image of current source facts, not authorization. The receiving
-- caller independently verifies the effect's live job, scope and pinned input.
-- Core position advances after callbacks; neither it nor a clock enters the image.
CREATE FUNCTION semantic.identity_epoch_source_image_v1(p_home integer,p_original uuid,p_frame uuid)
RETURNS bytea LANGUAGE sql STABLE STRICT AS $$
 WITH frame AS MATERIALIZED (
  SELECT e.*,e.xmin::text AS creator_xid
  FROM semantic.identity_epoch_mapping_effect e
  WHERE e.partition_no=p_home AND e.transaction_id=p_frame
  ORDER BY e.job_id,e.unit LIMIT 2
 ), fences AS MATERIALIZED (
  SELECT f.*,f.xmin::text AS creator_xid
  FROM semantic.identity_epoch_mapping_fence f
  WHERE f.route/16=p_home AND f.transaction_id=p_frame
  ORDER BY f.route,f.destination LIMIT 2
 ), gates AS MATERIALIZED (
  SELECT g.*,g.xmin::text AS creator_xid
  FROM semantic.identity_epoch_home_gate g
  WHERE g.route=(get_byte(uuid_send(p_original),10)*256+get_byte(uuid_send(p_original),11))
   AND g.destination=p_original AND g.recorded_transaction_id=p_frame
  ORDER BY g.original LIMIT 2
 )
 SELECT sha256(convert_to(jsonb_build_array(
  'rezics.semantic.identity-source-image/v1',
  jsonb_build_array(e.partition_no,e.job_id,e.job_epoch,e.unit,e.scope_digest,e.plan_digest,e.transaction_id),
  jsonb_build_array(p.partition_no,p.node,p.epoch,p.write_state,p.moved_to),
  jsonb_build_array(p_original,s.subject_id IS NOT NULL,s.recorded_transaction_id,s.xmin::text),
  jsonb_build_array(d.original IS NOT NULL,coalesce(d.revision,0)::text,coalesce(d.captured_revision,0)::text),
  jsonb_build_array(r.sequence,r.target,r.recorded_transaction_id),
  jsonb_build_array(m.route,m.original,m.terminal,m.epoch,m.origin,m.recorded_transaction_id,
   m.control_partition,m.control_group,m.source_revision,m.owner_epoch),
  jsonb_build_array(m.closure_state,m.closure_enrollment,m.closure_generation,m.closure_incarnation,
   m.closure_immediate,m.closure_export_transaction,m.closure_hold_transaction,m.closure_hold_xid,
   m.closure_registration_transaction,m.closure_install_transaction,m.closure_install_xid,
   m.closure_ack_transaction,m.closure_ack_xid,m.closure_withdraw_transaction,m.closure_withdraw_xid),
  jsonb_build_array(f.route,f.destination,f.job_id,f.job_epoch,f.transaction_id),
  jsonb_build_array(g.route,g.destination,g.original,g.terminal,g.epoch,
   g.pending_job,g.pending_epoch,g.recorded_transaction_id)
 )::text,'UTF8'))
 FROM core.partition p
 JOIN frame e ON e.partition_no=p.partition_no
 JOIN semantic.identity_epoch_native_commit n
  ON n.partition_no=e.partition_no AND n.transaction_id=e.transaction_id
   AND n.purpose='mapping' AND n.epoch=p.epoch AND n.xmin::text=e.creator_xid
 JOIN fences f ON f.job_id=e.job_id AND f.job_epoch=e.job_epoch
  AND f.destination=p_original AND f.creator_xid=e.creator_xid
 JOIN gates g ON g.route=f.route AND g.destination=f.destination
  AND g.pending_job=e.job_id AND g.pending_epoch=e.job_epoch AND g.creator_xid=e.creator_xid
 LEFT JOIN semantic.subject s ON s.route=f.route AND s.subject_id=f.destination
 LEFT JOIN semantic.identity_epoch_mapping m ON m.route=f.route AND m.original=f.destination
 LEFT JOIN semantic.identity_epoch_dirty d ON d.route=f.route AND d.original=f.destination
 LEFT JOIN LATERAL (
  SELECT redirect.sequence,redirect.target,redirect.recorded_transaction_id
  FROM semantic.redirect redirect
  WHERE redirect.route=f.route AND redirect.subject_id=f.destination
  ORDER BY redirect.sequence DESC LIMIT 1
 ) r ON true
 WHERE p.partition_no=p_home AND p_home BETWEEN 0 AND 4095 AND p.write_state='active'
  AND (SELECT count(*) FROM frame)=1 AND (SELECT count(*) FROM fences)=1
  AND (SELECT count(*) FROM gates)=1;
$$;

-- The old effect guard refused every UPDATE/DELETE for this table. Preserve
-- that rule except one server-computed fill in the original native transaction.
CREATE FUNCTION semantic.guard_identity_epoch_mapping_source_image() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creator text;destinations uuid[];image bytea;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_image_version IS NOT NULL OR NEW.source_image_digest IS NOT NULL THEN
   RAISE EXCEPTION 'Native source image must be captured after source writes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' THEN
  RAISE EXCEPTION 'Identity mapping effects are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.source_image_version IS NOT NULL OR OLD.source_image_digest IS NOT NULL
  OR NEW.source_image_version IS DISTINCT FROM 1::smallint OR NEW.source_image_digest IS NOT NULL
  OR (to_jsonb(NEW)-ARRAY['source_image_version','source_image_digest'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['source_image_version','source_image_digest']) THEN
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
 image:=semantic.identity_epoch_source_image_v1(OLD.partition_no,destinations[1],OLD.transaction_id);
 IF image IS NULL THEN
  RAISE EXCEPTION 'Native source image frame is unavailable' USING ERRCODE='23514';
 END IF;
 NEW.source_image_digest:=image;
 RETURN NEW;
END; $$;

DROP TRIGGER identity_epoch_mapping_effect_immutable ON semantic.identity_epoch_mapping_effect;
CREATE TRIGGER identity_epoch_mapping_effect_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON semantic.identity_epoch_mapping_effect FOR EACH ROW
 EXECUTE FUNCTION semantic.guard_identity_epoch_mapping_source_image();

CREATE FUNCTION semantic.capture_identity_epoch_source_image(
 p_home integer,p_job uuid,p_epoch bigint,p_unit integer,p_scope text,p_frame uuid
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
 SELECT array_agg(f.destination) INTO destinations FROM (
  SELECT destination FROM semantic.identity_epoch_mapping_fence
  WHERE route/16=p_home AND transaction_id=p_frame AND job_id=p_job AND job_epoch=p_epoch
  ORDER BY route,destination LIMIT 2
 ) f;
 IF destinations IS NULL THEN RETURN NULL; END IF;
 IF cardinality(destinations)<>1 THEN
  RAISE EXCEPTION 'Native source image requires one source gate' USING ERRCODE='23514';
 END IF;
 IF saved.source_image_version IS NOT NULL THEN
  image:=semantic.identity_epoch_source_image_v1(p_home,destinations[1],p_frame);
  IF saved.source_image_version<>1 OR image IS NULL OR image IS DISTINCT FROM saved.source_image_digest THEN
   RAISE EXCEPTION 'Native source image replay changed' USING ERRCODE='23514';
  END IF;
  RETURN image;
 END IF;
 UPDATE semantic.identity_epoch_mapping_effect SET source_image_version=1
 WHERE partition_no=p_home AND job_id=p_job AND unit=p_unit
 RETURNING source_image_digest INTO image;
 RETURN image;
END; $$;

-- Later callbacks cannot commit a stale image. This checks the final source
-- against the same image function without granting any retained-page disposal.
CREATE FUNCTION semantic.validate_identity_epoch_source_image_commit() RETURNS trigger LANGUAGE plpgsql AS $$
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
 image:=semantic.identity_epoch_source_image_v1(NEW.partition_no,destinations[1],NEW.transaction_id);
 IF NEW.source_image_version IS DISTINCT FROM 1::smallint OR image IS NULL
  OR image IS DISTINCT FROM NEW.source_image_digest THEN
  RAISE EXCEPTION 'Native source image changed before commit' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_source_image_commit AFTER UPDATE
 ON semantic.identity_epoch_mapping_effect DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION semantic.validate_identity_epoch_source_image_commit();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Native source image custody requires a forward migration'; END; $$;
