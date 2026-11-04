WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
)
DELETE FROM library.collection AS victim USING input
WHERE victim.route=input.route AND victim.curator_account_id=input.account_id AND victim.collection_id=input.parent_id
  AND NOT victim.listing_ever_public
  AND NOT (victim.state='active' AND victim.visibility='public')
  AND NOT EXISTS (SELECT 1 FROM library.collection_member WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.canonical_source_fact WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.canonical_source_state WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_listing_history WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history_state WHERE route=input.route AND collection_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_source_output WHERE route=input.route AND collection_id=input.parent_id)
RETURNING true AS removed;
