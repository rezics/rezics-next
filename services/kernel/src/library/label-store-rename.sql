WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :name::text AS next_name
), current AS MATERIALIZED (
  SELECT label.*, input.next_name FROM input CROSS JOIN LATERAL (
    SELECT personal_label.* FROM library.personal_label
    WHERE personal_label.route = input.route AND personal_label.account_id = input.account_id
      AND personal_label.label_id = input.label_id
    ORDER BY personal_label.route, personal_label.account_id, personal_label.label_id
    FOR UPDATE
  ) AS label
), eligible AS MATERIALIZED (
  SELECT * FROM current WHERE revision = :revision AND deleted_at IS NULL
), changed AS (
  UPDATE library.personal_label AS label
  SET normalized_name = eligible.next_name, revision = label.revision + 1,
      updated_at = :time::timestamptz, transaction_id = :transaction_id
  FROM eligible
  WHERE label.route = eligible.route AND label.account_id = eligible.account_id
    AND label.label_id = eligible.label_id AND label.revision = eligible.revision
    AND eligible.normalized_name <> eligible.next_name
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
