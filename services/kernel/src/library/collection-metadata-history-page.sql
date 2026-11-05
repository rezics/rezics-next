WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :curator_account_id::uuid AS curator_account_id, :after_revision::nullable(integer) AS after_revision,
         :page_limit::integer AS page_limit
)
SELECT history.revision, history.transaction_id AS "transactionId", history.recorded_at AS "recordedAt",
       history.changed_fields AS "changedFields"
FROM library.collection_metadata_history AS history CROSS JOIN input
WHERE history.route = input.route AND history.collection_id = input.collection_id
  AND history.curator_account_id = input.curator_account_id
  AND (input.after_revision IS NULL OR history.revision < input.after_revision)
ORDER BY history.revision DESC
LIMIT (SELECT page_limit FROM input);
