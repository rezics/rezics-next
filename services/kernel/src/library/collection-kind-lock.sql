SELECT generation::text, version::text, complete, capture
FROM library.collection_kind_observation
WHERE route=:route::integer AND collection_id=:collection_id::uuid AND audience=:audience::text
LIMIT 1 FOR UPDATE;
