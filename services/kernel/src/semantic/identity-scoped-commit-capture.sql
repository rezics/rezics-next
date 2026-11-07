UPDATE library.canonical_source_scope AS scope
SET frontier = identity_scope.frontier,
    capture_id = identity_scope.capture_id,
    committed_revision = identity_scope.revision
FROM semantic.identity_scope_summary AS identity_scope
WHERE scope.route = :route::integer
  AND scope.collection_id = :collection_id::uuid
  AND scope.source_fence = :source_fence::text
  AND identity_scope.partition_no = :partition_no::integer
  AND identity_scope.source_key = :source_key::text
  AND identity_scope.scope_id = :scope_id::text
  AND identity_scope.capture_id = :capture_id::uuid
  AND identity_scope.revision = :revision::bigint
  AND identity_scope.state = 'ready'
  AND identity_scope.active = 0
  AND identity_scope.scan_complete
  AND identity_scope.source = jsonb_build_object('kind', 'library', 'identity', scope.identity)
  AND identity_scope.frontier->>'driver' = 'done'
  AND (identity_scope.frontier->>'captureId')::uuid = identity_scope.capture_id;
