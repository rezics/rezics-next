SELECT audience,generation::text,capture
FROM library.collection_kind_retired
WHERE route=:route::integer AND collection_id=:collection_id::uuid
ORDER BY audience COLLATE "C",generation LIMIT 1;
