-- The complete media PK is the only mutation target. Preserve publication,
-- provenance, claims and all byte keys for appeal; bigint arithmetic is lossless.
UPDATE content.media
SET taken_down = true, security_revision = security_revision + 1
WHERE route = :route::integer AND media_id = :media_id::uuid
  AND NOT erased AND NOT taken_down
RETURNING security_revision::text AS "securityRevision";
