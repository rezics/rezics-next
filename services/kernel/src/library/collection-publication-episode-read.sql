-- Exact native operation and immutable source. Missing native commit evidence is unavailable.
SELECT o.owner_account_id::text AS owner,o.collection_id::text AS collection,o.source_id::text AS "sourceId",
       o.transaction_id::text AS "transactionId",s.transaction_id::text AS "sourceTransaction",
       s.publication_id::text AS "sourceOperation",s.bytes AS "sourceBytes",o.record,
       e.phase,e.version::text AS version,o.commitment,o.source_digest AS "sourceDigest",o.creation_storage_key AS "storageKey"
FROM library.collection_publication_operation o
JOIN library.collection_publication_source s
  ON (s.route,s.source_id)=(o.route,o.source_id) AND s.publication_id=o.publication_id AND s.transaction_id=o.transaction_id
JOIN library.collection_publication_episode e
  ON (e.route,e.publication_id,e.source_id,e.collection_id,e.owner_account_id)=
     (o.route,o.publication_id,o.source_id,o.collection_id,o.owner_account_id)
JOIN editorial.write_basis b ON b.partition_no=(o.route >> 4) AND b.transaction_id=o.transaction_id
JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.epoch AND p.position>=b.position
WHERE o.route=$1 AND o.publication_id=$2 AND o.source_id=$3
  AND b.principal_kind='account' AND b.principal_id=o.owner_account_id AND b.position>0
  AND b.client_id=o.record->'actor'->>'clientId'
  AND b.requested_by IS NOT DISTINCT FROM (o.record->'actor'->>'requestedBy')
  AND o.xmin=b.xmin AND s.xmin=o.xmin
  AND p.write_state='active' AND p.moved_to IS NULL
  AND o.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned();
