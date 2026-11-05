SELECT kind, owner_route, owner_id, revision_id
FROM community.revision_locator
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND (kind, owner_route, owner_id, revision_id) >
      (:kind::text COLLATE "C", :owner_route::integer, :owner_id::uuid, :revision_id::uuid)
ORDER BY kind, owner_route, owner_id, revision_id
LIMIT 50;
