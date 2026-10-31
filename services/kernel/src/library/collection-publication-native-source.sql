WITH input AS (SELECT :route::integer AS route,:owner_epoch::integer AS owner_epoch)
SELECT scope.identity,scope.frontier,scope.capture_id::text AS "sourceCaptureId",
       scope.committed_revision::text AS "sourceRevision",
       capture.capture_id::text AS "nativeCaptureId",capture.collection_id::text AS "nativeCollectionId",
       capture.account_id::text AS "nativeAccountId",capture.incarnation AS "nativeIncarnation",
       capture.generation::text AS "nativeGeneration",capture.scope AS "nativeScope",
       capture.owner_epoch AS "nativeOwnerEpoch",capture.receiving_epoch::text AS "nativeReceivingEpoch",
       capture.effect_key AS "nativeEffectKey",capture.driver AS "nativeDriver",
       capture.scanned::text AS "nativeScanned",capture.complete AS "nativeComplete",
       capture_receipt.transaction_id::text AS "nativeCaptureTransactionId",
       capture_receipt.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
         AND capture_receipt.xmin=capture.xmin AS "nativeCaptureCommitted",
       owner_basis.transaction_id::text AS "repairTransactionId",owner_basis.epoch AS "repairEpoch",
       owner_basis.position::text AS "repairPosition",
       owner_basis.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
         AND partition.position>=owner_basis.position AND partition.epoch=owner_basis.epoch AS "repairCommitted",
       identity_scope.source AS "identitySource",identity_scope.registration::text AS "holdId",
       identity_scope.capture_id::text AS "identityCaptureId",identity_scope.state AS "identityState",
       identity_scope.revision::text AS "identityRevision",identity_scope.active AS "identityActive",
       identity_scope.frontier AS "identityFrontier",identity_scope.scan_complete AS "identityScanComplete",
       canonical.generation::text AS "canonicalGeneration",canonical.basis AS "canonicalBasis",
       canonical.state AS "canonicalState",canonical.source_exhausted AS "canonicalExhausted",
       output.account_id::text AS "outputAccountId",
       output.source_generation::text AS "outputSourceGeneration",
       output.expected_members::text AS "outputExpectedMembers",output.output_mode AS "outputMode",
       output.state AS "outputState",selected.generation::text AS "selectedGeneration"
FROM input AS args
JOIN library.canonical_source_scope AS scope ON scope.route=args.route
JOIN library.native_source_capture AS capture
  ON capture.route=args.route AND capture.capture_id=(scope.frontier->>'captureId')::uuid
JOIN library.native_source_receipt AS capture_receipt
  ON capture_receipt.route=capture.route AND capture_receipt.capture_id=capture.capture_id
JOIN core.partition AS partition
  ON partition.partition_no=(capture.route >> 4) AND partition.epoch=capture_receipt.owner_epoch
  AND partition.position>=capture_receipt.position AND partition.write_state='active' AND partition.moved_to IS NULL
JOIN LATERAL (
  SELECT basis.transaction_id,basis.epoch,basis.position,basis.xmin
  FROM editorial.write_basis AS basis
  WHERE basis.partition_no=partition.partition_no AND basis.epoch=partition.epoch
    AND basis.position<=partition.position AND basis.principal_kind='account'
    AND basis.principal_id=:owner_account_id
  ORDER BY basis.position DESC LIMIT 1
) AS owner_basis ON TRUE
JOIN semantic.identity_scope_summary AS identity_scope
  ON identity_scope.partition_no=:partition AND identity_scope.source_key=:source_key
  AND identity_scope.scope_id=:scope_id
JOIN library.canonical_source_head AS canonical_head
  ON canonical_head.route=scope.route AND canonical_head.collection_id=scope.collection_id
JOIN library.canonical_source_generation AS canonical
  ON canonical.route=canonical_head.route AND canonical.collection_id=canonical_head.collection_id
  AND canonical.generation=canonical_head.generation
JOIN library.collection_source_output AS output
  ON output.route=scope.route AND output.collection_id=scope.collection_id
  AND output.generation=:output_generation
LEFT JOIN library.collection_source_output_head AS selected
  ON selected.route=scope.route AND selected.collection_id=scope.collection_id
WHERE scope.collection_id=:collection_id AND scope.source_fence=:source_fence
  AND capture.complete AND capture.driver='done'
  AND capture_receipt.owner_epoch=args.owner_epoch AND capture_receipt.position>0
  AND capture_receipt.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
  AND capture_receipt.xmin=capture.xmin
  AND owner_basis.epoch=args.owner_epoch AND owner_basis.position>0
  AND identity_scope.source=jsonb_build_object('kind','library','identity',scope.identity)
  AND identity_scope.state='ready' AND identity_scope.active=0 AND identity_scope.scan_complete
  AND identity_scope.frontier->>'driver'='done'
  AND NOT EXISTS (
    SELECT 1 FROM semantic.identity_scope_consumer_fence AS fence
    WHERE (fence.partition_no,fence.source_key,fence.scope_id)=
      (identity_scope.partition_no,identity_scope.source_key,identity_scope.scope_id)
  )
  AND canonical.state='complete' AND canonical.source_exhausted
  AND output.source_generation::text=:source_generation AND output.output_mode='whole_query'
  AND output.expected_members IS NULL AND output.state='building'
;
