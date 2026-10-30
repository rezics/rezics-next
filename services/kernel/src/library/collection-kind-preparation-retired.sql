-- A token alone cannot select a custody obligation for release.
SELECT true AS retired
FROM library.collection_kind_retired
WHERE route=:route::integer AND collection_id=:collection_id::uuid
  AND account_id=:account_id::uuid AND capture=:capture::text
ORDER BY audience COLLATE "C", generation LIMIT 1 FOR UPDATE;
