WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
), owner AS (
  SELECT 1 FROM library.collection AS parent, input
  WHERE parent.route=input.route AND parent.curator_account_id=input.account_id
    AND parent.collection_id=input.parent_id
), listing AS (
  DELETE FROM library.collection_listing_history AS history USING input
  WHERE history.route=input.route AND history.collection_id=input.parent_id AND EXISTS (SELECT 1 FROM owner)
  RETURNING true AS removed
), changes AS (
  DELETE FROM library.collection_metadata_history AS history USING input
  WHERE history.route=input.route AND history.collection_id=input.parent_id AND EXISTS (SELECT 1 FROM owner)
  RETURNING true AS removed
), state AS (
  DELETE FROM library.collection_metadata_history_state AS history USING input
  WHERE history.route=input.route AND history.collection_id=input.parent_id AND EXISTS (SELECT 1 FROM owner)
  RETURNING true AS removed
)
SELECT removed FROM listing UNION ALL SELECT removed FROM changes UNION ALL SELECT removed FROM state;
