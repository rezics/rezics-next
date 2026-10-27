UPDATE library.personal_label
SET revision = revision + 1, updated_at = :time::timestamptz, transaction_id = :transaction_id,
    deleted_at = CASE WHEN :restore::boolean THEN NULL ELSE :time::timestamptz END,
    purge_after = CASE WHEN :restore::boolean THEN NULL ELSE :time::timestamptz + interval '720 hours' END
WHERE route = :route AND account_id = :account_id AND label_id = :label_id AND revision = :revision
  AND ((NOT :restore::boolean AND deleted_at IS NULL)
    OR (:restore::boolean AND deleted_at <= :time::timestamptz AND :time::timestamptz < purge_after))
RETURNING label_id AS id, normalized_name AS name, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt",
          deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter";
