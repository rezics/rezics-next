-- Native committed Source metadata only. This lookup never certifies identity or disclosure readiness.
SELECT c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text AS incarnation,
       c.source_generation::text AS generation, c.revision, c.builtin_release_digest AS "releaseDigest",
       p.epoch, p.position::text AS position,
       s.identity, s.capture_id::text AS "captureId", s.committed_revision::text AS "committedRevision",
       s.identity->>'receivingEpoch' AS "receivingEpoch", s.identity->>'effectKey' AS "effectKey",
       g.basis->>'digest' AS "basisDigest", g.basis->'identity'->>'digest' AS "identityDigest"
FROM library.collection AS c
JOIN core.partition AS p ON p.partition_no = (c.route >> 4)
JOIN library.canonical_source_head AS h ON h.route = c.route AND h.collection_id = c.collection_id
JOIN library.canonical_source_generation AS g
  ON g.route = h.route AND g.collection_id = h.collection_id AND g.generation = h.generation
JOIN library.canonical_source_scope AS s
  ON s.route = c.route AND s.collection_id = c.collection_id AND s.source_fence = g.basis->>'sourceFence'
WHERE c.route = :route::integer AND c.collection_id = :collection_id::uuid
  AND c.curator_account_id = :owner_account_id::uuid AND c.state = 'active' AND c.membership_kind = 'curated'
  AND p.write_state = 'active'
  AND g.state = 'complete' AND g.source_exhausted
  AND g.basis->>'incarnation' = c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
  AND g.basis->'authority'->>'kind' = 'curated' AND g.basis->>'meaning' IS NULL
  AND s.identity->>'route' = c.route::text
  AND s.identity->>'collectionId' = c.collection_id::text
  AND s.identity->>'accountId' = c.curator_account_id::text
  AND s.identity->>'incarnation' = g.basis->>'incarnation'
  AND s.identity->>'generation' = c.source_generation::text
  AND s.identity->>'scope' = 'curated'
  AND s.identity->>'ownerEpoch' = p.epoch::text
  AND s.identity->>'receivingEpoch' = p.epoch::text
  AND s.identity->>'effectKey' = 'collection-source:' || s.source_fence
FOR SHARE OF c, p, h, g, s;
