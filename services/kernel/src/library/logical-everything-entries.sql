-- unbound: complete explicit self-pairs from the owner worker's published generation.
-- A zero limit rechecks the publication and current scope without reopening its immutable references.
WITH owner AS MATERIALIZED (
  SELECT l.route,l.account_id,l.collection_id,l.generation::text AS version,p.epoch,
         g.generation,g.query_capture_id AS capture,g.query_capture_revision::text AS revision,
         a.xmin::text AS account_tuple,a.transaction_id AS account_version,a.kind,a.state,a.authn_fenced AS fenced,a.minimum_authn_epoch::text AS floor
  FROM library.logical_everything_source l
  JOIN core.partition p ON p.partition_no=$4 AND p.write_state='active' AND p.moved_to IS NULL
  JOIN access.account a USING (route,account_id)
  JOIN library.canonical_source_head h USING (route,collection_id)
  JOIN library.canonical_source_generation g ON (g.route,g.collection_id,g.generation)=(h.route,h.collection_id,h.generation)
  JOIN library.canonical_source_scope c ON (c.route,c.collection_id,c.source_fence)=
    (l.route,l.collection_id,g.basis->>'sourceFence')
  JOIN semantic.identity_scope_summary s ON (s.partition_no,s.source_key,s.scope_id)=(p.partition_no,$6,'collection-source')
  WHERE (l.route,l.account_id,l.collection_id)=($1,$2,$3)
    AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference ref WHERE
      (ref.route,ref.collection_id)=(l.route,l.collection_id))
    AND NOT EXISTS (SELECT 1 FROM library.entry_clear clear WHERE
      (clear.route,clear.account_id)=(l.route,l.account_id))
    AND NOT EXISTS (SELECT 1 FROM library.owner_index_pin pin WHERE
      (pin.route,pin.account_id)=(l.route,l.account_id) AND NOT pin.meaning_ready)
    AND c.logical_owner_id=l.account_id AND g.logical_owner_id=l.account_id
    AND c.identity=jsonb_build_object('route',l.route,'accountId',l.account_id,'collectionId',l.collection_id,
      'incarnation',l.incarnation,'scope','private_builtin','generation',l.generation::text,
      'ownerEpoch',p.epoch,'receivingEpoch',p.epoch::text,'effectKey','collection-source:' || c.source_fence)
    AND g.state='complete' AND g.source_exhausted AND g.basis->>'originalCoverage'='owner-facts-v2'
    AND (c.capture_id,c.committed_revision)=(g.query_capture_id,g.query_capture_revision)
    AND (s.capture_id,s.revision)=(c.capture_id,c.committed_revision)
    AND s.source=jsonb_build_object('kind','library','identity',c.identity)
    AND s.state='ready' AND s.active=0 AND s.scan_complete
    AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_consumer_fence f WHERE
      (f.partition_no,f.source_key,f.scope_id)=(s.partition_no,s.source_key,s.scope_id))
)
SELECT o.version,o.epoch,o.generation,o.capture,o.revision,o.account_tuple AS "accountTuple",o.account_version AS "accountVersion",o.kind,o.state,o.fenced,o.floor,
       r.original AS id, (r.driver=1 AND r.original=r.terminal AND r.fact_id=r.original AND e.state IS NOT NULL) AS explicit
FROM owner o LEFT JOIN LATERAL (
  SELECT stored_subject_id AS original,canonical_subject_id AS terminal,driver,fact_id
  FROM library.canonical_source_reference r WHERE
    (r.route,r.collection_id,r.generation)=(o.route,o.collection_id,o.generation)
  ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT $5
) r ON true
LEFT JOIN library.entry e ON (e.route,e.account_id,e.subject_id)=(o.route,o.account_id,r.original)
ORDER BY r.terminal,r.original,r.driver,r.fact_id;
