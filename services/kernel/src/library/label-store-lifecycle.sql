WITH input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :revision::integer AS revision, :time::timestamptz AS time, :restore::boolean AS restore,
         :transaction_id::uuid AS operation_transaction_id
), current AS MATERIALIZED (
  SELECT label.* FROM library.personal_label AS label, input
  WHERE label.route = input.route AND label.account_id = input.account_id AND label.label_id = input.label_id
  FOR UPDATE
), eligible AS MATERIALIZED (
  SELECT current.*, input.time, input.restore, input.operation_transaction_id FROM current, input
  WHERE current.revision = input.revision
    AND ((NOT input.restore AND current.deleted_at IS NULL)
      OR (input.restore AND current.deleted_at <= input.time AND input.time < current.purge_after))
), changed AS (
  UPDATE library.personal_label AS label
  SET revision = label.revision + 1, updated_at = eligible.time, transaction_id = eligible.operation_transaction_id,
      deleted_at = CASE WHEN eligible.restore THEN NULL ELSE eligible.time END,
      purge_after = CASE WHEN eligible.restore THEN NULL ELSE eligible.time + interval '720 hours' END
  FROM eligible
  WHERE label.route = eligible.route AND label.account_id = eligible.account_id AND label.label_id = eligible.label_id
    AND label.revision = eligible.revision
  RETURNING label.label_id AS id, label.normalized_name AS name, label.revision,
            label.created_at::text AS "createdAt", label.updated_at::text AS "updatedAt",
            label.deleted_at::text AS "deletedAt", label.purge_after::text AS "purgeAfter"
)
SELECT * FROM changed;
