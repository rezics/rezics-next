DELETE FROM library.canonical_source_state
WHERE route = :route::integer AND collection_id = :collection_id::uuid
RETURNING true AS removed;
