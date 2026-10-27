SELECT label_id AS id, normalized_name AS name, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM library.personal_label
WHERE route = :route AND account_id = :account_id AND label_id = :label_id
  AND (:include_deleted::boolean OR deleted_at IS NULL);
