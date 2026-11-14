WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT history.collection_id
  FROM library.collection_listing_history AS history CROSS JOIN input
  WHERE history.route = input.route AND history.curator_account_id = input.account_id
  ORDER BY history.collection_id
  LIMIT 100
), scrubbed AS (
  UPDATE library.collection_listing_history AS history
  SET curator_account_id = NULL
  FROM keys, input
  WHERE history.route = input.route AND history.collection_id = keys.collection_id
    AND history.curator_account_id = input.account_id
  RETURNING true AS removed
)
SELECT removed FROM scrubbed;
