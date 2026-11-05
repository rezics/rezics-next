DELETE FROM community.revision_locator
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND kind = :kind::text AND owner_route = :owner_route::integer
  AND owner_id = :owner_id::uuid AND revision_id = :revision_id::uuid
RETURNING revision_id;
