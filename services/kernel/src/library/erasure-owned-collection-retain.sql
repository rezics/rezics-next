WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
)
UPDATE library.collection AS retained SET curator_account_id=NULL
FROM input
WHERE retained.route=input.route AND retained.curator_account_id=input.account_id AND retained.collection_id=input.parent_id
  AND retained.state='active' AND retained.visibility='public'
  AND NOT EXISTS (SELECT 1 FROM library.canonical_source_fact WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.canonical_source_state WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_listing_history WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history_state WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_source_output WHERE route=input.route AND collection_id=input.parent_id)
RETURNING true AS removed;
