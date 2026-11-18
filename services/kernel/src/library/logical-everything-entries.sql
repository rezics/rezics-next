-- unbound: complete explicit self-pairs from the owner worker's published generation.
-- A zero limit rechecks the publication and current scope without reopening its immutable references.
WITH binding AS MATERIALIZED (
  SELECT l.route,l.account_id,l.collection_id,l.incarnation,l.generation::text AS version,p.partition_no,p.epoch,
         a.xmin::text AS account_tuple,a.transaction_id AS account_version,a.kind,a.state,a.authn_fenced AS fenced,a.minimum_authn_epoch::text AS floor
  FROM library.logical_everything_source l
  JOIN core.partition p ON p.partition_no=$4 AND p.write_state='active' AND p.moved_to IS NULL
  JOIN access.account a USING (route,account_id)
  WHERE (l.route,l.account_id,l.collection_id)=($1,$2,$3)
    AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference ref WHERE
      (ref.route,ref.collection_id)=(l.route,l.collection_id))
    AND NOT EXISTS (SELECT 1 FROM library.entry_clear clear WHERE
      (clear.route,clear.account_id)=(l.route,l.account_id))
    AND NOT EXISTS (SELECT 1 FROM library.owner_index_pin pin WHERE
      (pin.route,pin.account_id)=(l.route,l.account_id) AND NOT pin.meaning_ready)
), publication AS MATERIALIZED (
  SELECT l.*,h.generation AS published,g.basis,g.state AS publication_state,g.source_exhausted,
         g.logical_owner_id,g.query_capture_id,g.query_capture_revision,c.source_fence,c.identity,
         c.logical_owner_id AS scope_owner,c.capture_id,c.committed_revision
  FROM binding l
  LEFT JOIN library.canonical_source_head h USING (route,collection_id)
  LEFT JOIN library.canonical_source_generation g ON (g.route,g.collection_id,g.generation)=(h.route,h.collection_id,h.generation)
  LEFT JOIN library.canonical_source_scope c ON (c.route,c.collection_id,c.source_fence)=
    (l.route,l.collection_id,g.basis->>'sourceFence')
), owner AS MATERIALIZED (
  SELECT l.route,l.account_id,l.collection_id,l.published AS generation,
         l.query_capture_id AS capture,l.query_capture_revision::text AS revision
  FROM publication l
  JOIN semantic.identity_scope_summary s ON (s.partition_no,s.source_key,s.scope_id)=(l.partition_no,$6,'collection-source')
  WHERE l.scope_owner=l.account_id AND l.logical_owner_id=l.account_id
    AND l.identity=jsonb_build_object('route',l.route,'accountId',l.account_id,'collectionId',l.collection_id,
      'incarnation',l.incarnation,'scope','private_builtin','generation',l.version,
      'ownerEpoch',l.epoch,'receivingEpoch',l.epoch::text,'effectKey','collection-source:' || l.source_fence)
    AND l.publication_state='complete' AND l.source_exhausted AND l.basis->>'originalCoverage'='owner-facts-v2'
    AND (l.capture_id,l.committed_revision)=(l.query_capture_id,l.query_capture_revision)
    AND (s.capture_id,s.revision)=(l.capture_id,l.committed_revision)
    AND s.source=jsonb_build_object('kind','library','identity',l.identity)
    AND s.state='ready' AND s.active=0 AND s.scan_complete
    AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_consumer_fence f WHERE
      (f.partition_no,f.source_key,f.scope_id)=(s.partition_no,s.source_key,s.scope_id))
)
SELECT b.version,b.epoch,o.generation,o.capture,o.revision,b.account_tuple AS "accountTuple",
       b.account_version AS "accountVersion",b.kind,b.state,b.fenced,b.floor,
       (o.generation IS NULL AND (b.published IS NULL OR b.identity->>'generation' <> b.version)
         AND EXISTS (SELECT 1 FROM library.owner_member_support m
           WHERE (m.route,m.account_id)=(b.route,b.account_id))) AS preparing,
       r.original AS id, (r.driver=1 AND r.original=r.terminal AND r.fact_id=r.original AND e.state IS NOT NULL) AS explicit
FROM publication b LEFT JOIN owner o USING (route,account_id,collection_id)
LEFT JOIN LATERAL (
  SELECT stored_subject_id AS original,canonical_subject_id AS terminal,driver,fact_id
  FROM library.canonical_source_reference r WHERE
    (r.route,r.collection_id,r.generation)=(o.route,o.collection_id,o.generation)
  ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT $5
) r ON true
LEFT JOIN library.entry e ON (e.route,e.account_id,e.subject_id)=(o.route,o.account_id,r.original)
ORDER BY r.terminal,r.original,r.driver,r.fact_id;
