UPDATE library.copy
SET deletion_id = :deletion_id::uuid, deleted_at = :time::timestamptz,
    restore_until = :time::timestamptz + interval '720 hours', revision = revision + 1
WHERE route = :route::integer AND copy_id = :copy_id::uuid AND revision = :revision::integer
  AND deletion_id IS NULL AND revision <= 2147483644
RETURNING deletion_id AS "deletionId", revision;
