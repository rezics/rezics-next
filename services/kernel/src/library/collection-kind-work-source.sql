-- Exact source capture from the retained token, cross-checked against its committed scope receipt.
WITH input AS (
  SELECT :capture_id::uuid AS capture_id
)
SELECT scope.identity, scope.frontier, scope.capture_id::text AS capture,
       scope.committed_revision::text AS revision,
       capture.capture_id::text AS "nativeCaptureId", capture.scanned::text AS scanned, capture.complete,
       receipt.transaction_id::text AS "transactionId",
       receipt.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
         AND receipt.xmin=capture.xmin AS committed
FROM library.canonical_source_scope AS scope
JOIN input ON true
JOIN library.native_source_capture AS capture
  ON capture.route=scope.route AND capture.capture_id=input.capture_id
JOIN library.native_source_receipt AS receipt
  ON receipt.route=capture.route AND receipt.capture_id=capture.capture_id
WHERE scope.route=:route::integer
  AND scope.collection_id=:collection_id::uuid
  AND scope.source_fence=:source_fence::text
  AND scope.frontier->>'captureId'=input.capture_id::text
FOR UPDATE OF scope,capture,receipt;
