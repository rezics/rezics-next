WITH input AS (SELECT :time::timestamptz AS time)
INSERT INTO library.personal_label
  (route, account_id, label_id, normalized_name, revision, created_at, updated_at, transaction_id)
SELECT :route, :account_id, :label_id, :name, 1, input.time, input.time, :transaction_id
FROM input
RETURNING label_id AS id, normalized_name AS name, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt",
          deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter";
