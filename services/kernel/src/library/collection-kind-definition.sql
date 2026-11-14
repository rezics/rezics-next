-- Eight keyed rows at most: Collection, partition, owner fact head, scope
-- summary, finish association/component/completion and
-- one receiving prefix row. The association supplies the exact repair job;
-- never search historical attempts or infer a receipt from a partition head.
WITH input AS (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :owner_account_id::uuid AS owner_account_id,
         :partition_no::integer AS partition_no, :source_key::text AS source_key,
         :scope_id::text AS scope_id, :capture_id::uuid AS capture_id,
         :revision::text::bigint AS revision, :source::jsonb AS source
)
SELECT collection.revision,
       collection.collection_id::text || ':' || extract(epoch FROM collection.created_at)::text AS incarnation,
       collection.source_generation::text AS "sourceGeneration",
       collection.membership_kind AS "membershipKind", collection.rule_source AS "ruleSource",
       collection.builtin_kind AS "builtinKind",
       COALESCE(collection.builtin_release_digest,collection.rule_release_digest) AS "sourceRelease",
       collection.builtin_profile_id AS "profileId", collection.builtin_state_set_id AS "stateSetId",
       collection.builtin_state_id AS "stateId", collection.rule_revision::text AS "ruleRevision",
       collection.rule_release_digest AS "ruleRelease",
       (collection.rule_filter IS NOT NULL AND collection.rule_sort='id'
         AND collection.rule_release_digest IS NOT NULL) AS "ruleReady",
       facts.generation AS "factGeneration",
       partition.epoch AS "ownerEpoch", partition.position::text AS "partitionPosition",
       summary.registration::text, summary.state AS "scopeState",
       finished.job_id::text AS "jobId", finished.job_epoch::text AS "jobEpoch", finished.attempt,
       receiving.directory_transaction::text AS "directoryTransactionId",
       receiving.page_id AS "pageId", receiving.ordinal, receiving.disposition
FROM input i
JOIN library.collection AS collection
  ON (collection.route,collection.collection_id,collection.curator_account_id)=
     (i.route,i.collection_id,i.owner_account_id)
JOIN core.partition AS partition ON partition.partition_no=i.partition_no
JOIN semantic.identity_scope_summary AS summary
  ON (summary.partition_no,summary.source_key,summary.scope_id)=
     (i.partition_no,i.source_key,i.scope_id)
LEFT JOIN LATERAL (
  SELECT fact.generation::text FROM library.fact_source_head AS fact
  WHERE collection.membership_kind='dynamic'
    AND (fact.route,fact.account_id)=(i.route,i.owner_account_id)
  FOR SHARE OF fact
) AS facts ON true
LEFT JOIN LATERAL (
  SELECT association.job_id,association.job_epoch,completion.attempt
  FROM semantic.identity_scope_native_association AS association
  JOIN semantic.identity_epoch_native_commit AS native
    ON (native.partition_no,native.transaction_id)=(association.partition_no,association.transaction_id)
  JOIN semantic.identity_scope_completion AS completion
    ON (completion.partition_no,completion.source_key,completion.scope_id,completion.registration,
        completion.job_id,completion.job_epoch)=
       (association.partition_no,association.source_key,association.scope_id,association.registration,
        association.job_id,association.job_epoch)
  WHERE (association.partition_no,association.source_key,association.scope_id,association.registration,
         association.capture_id,association.revision,association.phase)=
        (summary.partition_no,summary.source_key,summary.scope_id,summary.registration,summary.capture_id,
         summary.revision-CASE WHEN summary.state='ready' THEN 1 ELSE 0 END,'finish')
    AND association.source=summary.source AND association.scan_complete
    AND completion.capture_id=summary.capture_id AND completion.attempt=association.attempt
    AND completion.version=association.completion_version AND completion.complete
    AND completion.source_generation=collection.source_generation::text
    AND native.purpose='identity-scope-finish' AND native.purpose=association.purpose
    AND native.epoch=association.epoch AND native.position=association.position
    AND native.epoch=partition.epoch AND native.position<=partition.position
    AND native.xmin=association.xmin AND native.xmin=completion.xmin
    AND native.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
  FOR SHARE OF association,native,completion
) AS finished ON true
LEFT JOIN LATERAL (
  -- LIMIT precedes disposition/byte validation. All retained rows of a live
  -- finished attempt are unsafe; cancellation makes Semantic's hold refuse.
  -- Filtering before LIMIT would scan an unbounded receiving history on a miss.
  SELECT receipt.directory_transaction,
         CASE WHEN octet_length(receipt.page_id)<=256 THEN receipt.page_id END AS page_id,
         receipt.ordinal,receipt.disposition
  FROM semantic.identity_scope_prearm_receipt AS receipt
  WHERE (receipt.partition_no,receipt.source_key,receipt.scope_id,receipt.registration,
         receipt.job_id,receipt.job_epoch)=
        (summary.partition_no,summary.source_key,summary.scope_id,summary.registration,
         finished.job_id,finished.job_epoch)
  ORDER BY receipt.directory_transaction,receipt.page_id,receipt.ordinal,receipt.disposition
  LIMIT 1 FOR SHARE OF receipt
) AS receiving ON true
WHERE collection.state='active' AND partition.write_state='active' AND partition.moved_to IS NULL
  AND summary.capture_id=i.capture_id AND summary.revision=i.revision AND summary.source=i.source
  AND summary.state IN ('ready','repair') AND summary.active=0 AND summary.scan_complete
  AND summary.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
LIMIT 1 FOR SHARE OF collection,partition,summary;
