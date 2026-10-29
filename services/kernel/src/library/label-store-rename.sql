WITH current AS (
  SELECT personal_label.*, :name::text AS next_name FROM library.personal_label
  WHERE route = :route AND account_id = :account_id AND label_id = :label_id
    AND revision = :revision AND deleted_at IS NULL
  FOR UPDATE
), changed AS (
  UPDATE library.personal_label AS label
  SET normalized_name = current.next_name, revision = label.revision + 1,
      updated_at = :time::timestamptz, transaction_id = :transaction_id
  FROM current
  WHERE label.route = :route AND label.account_id = :account_id AND label.label_id = :label_id
    AND label.route = current.route AND label.account_id = current.account_id AND label.label_id = current.label_id
    AND label.revision = current.revision AND current.normalized_name <> current.next_name
  RETURNING label.label_id AS id, label.normalized_name AS name, label.revision,
            label.created_at::text AS "createdAt", label.updated_at::text AS "updatedAt",
            label.deleted_at::text AS "deletedAt", label.purge_after::text AS "purgeAfter"
)
SELECT * FROM changed
UNION ALL
SELECT label_id AS id, normalized_name AS name, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM current WHERE normalized_name = next_name;
