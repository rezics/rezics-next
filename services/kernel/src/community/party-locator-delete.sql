DELETE FROM community.party_locator
WHERE route = :route::integer AND account_id = :account_id::uuid AND kind = :kind::text
  AND due_at = :due_at::timestamptz AND owner_route = :owner_route::integer
  AND owner_id = :owner_id::uuid AND key = :key::text
RETURNING key;
