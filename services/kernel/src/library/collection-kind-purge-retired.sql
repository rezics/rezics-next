DELETE FROM library.collection_kind_retired
WHERE route=:route::integer AND collection_id=:collection_id::uuid
  AND audience=:audience::text AND generation=:generation::uuid
RETURNING true AS removed;
