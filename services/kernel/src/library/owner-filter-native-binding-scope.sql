SELECT identity, capture_id::text AS "captureId", committed_revision::text AS revision
FROM library.canonical_source_scope
WHERE route = :route AND collection_id = :collection_id AND source_fence = :source_fence;
