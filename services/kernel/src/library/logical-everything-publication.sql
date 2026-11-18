-- unbound: only the current logical owner view can supply this headerless publication.
SELECT s.generation::text AS version,s.incarnation,g.generation,g.basis,c.identity,
       c.capture_id AS capture,c.committed_revision::text AS revision
FROM library.logical_everything_source s
JOIN core.partition p ON p.partition_no=(s.route >> 4) AND p.write_state='active'
  AND p.moved_to IS NULL AND p.epoch=$5
JOIN library.canonical_source_head h ON (h.route,h.collection_id)=(s.route,s.collection_id)
JOIN library.canonical_source_generation g
  ON (g.route,g.collection_id,g.generation)=(h.route,h.collection_id,h.generation)
JOIN library.canonical_source_scope c
  ON (c.route,c.collection_id,c.source_fence)=(g.route,g.collection_id,g.basis->>'sourceFence')
WHERE (s.route,s.collection_id,s.account_id)=($1,$2,$3)
  AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference ref
    WHERE (ref.route,ref.collection_id)=(s.route,s.collection_id))
  AND s.generation=$4::bigint AND g.logical_owner_id=s.account_id
  AND g.state='complete' AND g.source_exhausted AND c.logical_owner_id=s.account_id
  AND g.query_capture_id IS NOT NULL
  AND (g.query_capture_id,g.query_capture_revision)=(c.capture_id,c.committed_revision);
