WITH source AS MATERIALIZED (
  SELECT label_id AS id, normalized_name AS name, revision, deleted_at::text AS "deletedAt"
  FROM library.personal_label
  WHERE route = :route AND account_id = :account_id AND label_id > :after_label_id::uuid
  ORDER BY label_id
  LIMIT :limit::integer
)
SELECT * FROM source ORDER BY id;
