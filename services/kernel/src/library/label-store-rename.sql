WITH current AS MATERIALIZED (
  SELECT personal_label.*, :name::text AS next_name FROM library.personal_label
  WHERE personal_label.route = :route AND personal_label.account_id = :account_id
    AND personal_label.label_id = :label_id
  FOR UPDATE
), eligible AS MATERIALIZED (
  SELECT * FROM current WHERE revision = :revision AND deleted_at IS NULL
), changed AS (
  UPDATE library.personal_label AS label
  SET normalized_name = eligible.next_name, revision = label.revision + 1,
      updated_at = :time::timestamptz, transaction_id = :transaction_id
  FROM eligible
  WHERE label.route = :route AND label.account_id = :account_id AND label.label_id = :label_id
    AND label.route = eligible.route AND label.account_id = eligible.account_id AND label.label_id = eligible.label_id
    AND label.revision = eligible.revision AND eligible.normalized_name <> eligible.next_name
  RETURNING label.label_id AS id, label.normalized_name AS name, label.revision,
            label.created_at::text AS "createdAt", label.updated_at::text AS "updatedAt",
            label.deleted_at::text AS "deletedAt", label.purge_after::text AS "purgeAfter"
)
SELECT * FROM changed
UNION ALL
SELECT label_id AS id, normalized_name AS name, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM eligible WHERE normalized_name = next_name;
