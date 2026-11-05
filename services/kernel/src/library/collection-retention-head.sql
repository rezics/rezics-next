-- Called only after bounded children are exhausted under the locked, revalidated head.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id
)
DELETE FROM library.collection AS victim USING input
WHERE victim.route = input.route AND victim.collection_id = input.collection_id
  AND curator_account_id = :account_id::uuid AND revision = :revision::integer
  AND source_generation = :source_generation::bigint
  AND visibility <> 'public' AND NOT listing_ever_public
  AND NOT EXISTS (SELECT 1 FROM library.collection_member WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.canonical_source_fact WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.canonical_source_state WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.builtin_state_reference_source WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_listing_history WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.native_source_capture WHERE route = input.route AND collection_id = input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_source_output WHERE route=input.route AND collection_id=input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history WHERE route=input.route AND collection_id=input.collection_id)
  AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history_state WHERE route=input.route AND collection_id=input.collection_id)
RETURNING true AS removed;
