WITH input AS (SELECT :time::timestamptz AS time)
UPDATE library.copy
SET deletion_id = :deletion_id::uuid, deleted_at = input.time,
    restore_until = input.time + interval '720 hours', revision = revision + 1
FROM input
WHERE route = :route::integer AND copy_id = :copy_id::uuid AND revision = :revision::integer
  AND deletion_id IS NULL AND revision <= 2147483644
RETURNING deletion_id AS "deletionId", revision;
