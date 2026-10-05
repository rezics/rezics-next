-- Width rendition requests retain identity after success, cancellation or
-- exhausted retries. Asking again never creates a second exact transform.
CREATE UNIQUE INDEX transform_job_width_identity_idx ON media.transform_job (source_id,profile,(COALESCE(crop,'')))
  NULLS NOT DISTINCT WHERE profile ~ '^image-width-[1-9][0-9]{0,3}-(avif|webp)-v1$';
CREATE INDEX transform_job_width_queue_idx ON media.transform_job (created_at,id)
  WHERE status = 'queued' AND profile ~ '^image-width-[1-9][0-9]{0,3}-(avif|webp)-v1$';
CREATE INDEX transform_job_width_lease_idx ON media.transform_job (lease_expires_at,id)
  WHERE status = 'leased' AND profile ~ '^image-width-[1-9][0-9]{0,3}-(avif|webp)-v1$';
-- Empty text is not a valid saved crop; the expression makes the uncropped key
-- and every exact crop equally indexable, without scanning another Use's crops.
CREATE INDEX representation_width_candidates_idx ON media.representation
  (source_id,(COALESCE(crop,'')),pixel_width,media_type,id) INCLUDE (pixel_height)
  WHERE kind = 'rendition' AND availability = 'available'
    AND profile ~ '^image-width-[1-9][0-9]{0,3}-(avif|webp)-v1$'
    AND media_type IN ('image/avif','image/webp');

-- Every existing delivery surface calls this predicate. A retained rendition
-- cannot serve an unavailable original, even if its own immutable bytes remain.
-- Presentation labels and historical classifier holds still do not gate reads.
CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.availability <> 'available' OR media.digest_suppressed(o.byte_digest)
    OR (o.clearance = 'rejected' AND o.clearance_reason = 'staff-rejected')
    THEN 'rejected' ELSE 'cleared' END FROM media.representation o
    WHERE o.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END AND o.kind = 'original'
$$;
