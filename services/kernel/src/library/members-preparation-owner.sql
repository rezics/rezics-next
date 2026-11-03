WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :owner_account_id::uuid AS owner_account_id)
INSERT INTO library.members_preparation_owner (route, owner_account_id)
SELECT (SELECT route FROM input), (SELECT owner_account_id FROM input)
WHERE EXISTS (
  SELECT 1 FROM library.collection
  WHERE route = (SELECT route FROM input) AND collection_id = :collection_id::uuid
    AND curator_account_id = (SELECT owner_account_id FROM input) AND state = 'active' AND membership_kind = 'curated'
)
ON CONFLICT (route, owner_account_id) DO NOTHING;
