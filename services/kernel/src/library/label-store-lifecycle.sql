WITH input AS (SELECT :time::timestamptz AS time, :restore::boolean AS restore)
UPDATE library.personal_label
SET revision = revision + 1, updated_at = input.time, transaction_id = :transaction_id,
    deleted_at = CASE WHEN input.restore THEN NULL ELSE input.time END,
    purge_after = CASE WHEN input.restore THEN NULL ELSE input.time + interval '720 hours' END
FROM input
WHERE route = :route AND account_id = :account_id AND label_id = :label_id AND revision = :revision
  AND ((NOT input.restore AND deleted_at IS NULL)
    OR (input.restore AND deleted_at <= input.time AND input.time < purge_after))
RETURNING label_id AS id, normalized_name AS name, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt",
          deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter";
