WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
)
UPDATE library.collection AS retained SET curator_account_id=NULL
FROM input
WHERE retained.route=input.route AND retained.curator_account_id=input.account_id AND retained.collection_id=input.parent_id
  AND retained.state='active' AND retained.visibility='public' AND retained.membership_kind='curated'
RETURNING true AS removed;
