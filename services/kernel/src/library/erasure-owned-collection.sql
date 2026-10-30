WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :after_id::nullable(uuid) AS after_id
)
SELECT collection_id AS id, listing_ever_public AS "everPublic",
       state='active' AND visibility='public' AND (
         membership_kind='curated' OR (membership_kind='dynamic' AND EXISTS (
           SELECT 1 FROM library.canonical_source_state AS source
           WHERE source.route=collection.route AND source.collection_id=collection.collection_id
             AND source.ready_generation IS NOT NULL
         ))
       ) AS retain
FROM library.collection, input
WHERE collection.route=input.route AND collection.curator_account_id=input.account_id
  AND (input.after_id IS NULL OR collection_id>input.after_id)
ORDER BY collection_id LIMIT 1;
