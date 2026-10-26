-- migrate:up
CREATE UNIQUE INDEX committed_continuation_barrier
ON access.committed_continuation (route, account_id, barrier_receipt_id);
CREATE INDEX committed_continuation_operator_latest
ON access.committed_continuation (route, account_id, minimum_authn_epoch DESC)
WHERE allowlist @> '[{"step":"operator-responsibility-page"}]'::jsonb;
ALTER TABLE access.lifecycle_fence_receipt
  ADD COLUMN operator_account_id uuid,
  ADD COLUMN operator_reservation_id uuid,
  ADD COLUMN operator_continuation_id uuid,
  ADD CONSTRAINT lifecycle_fence_operator_origin CHECK (
    (operator_account_id IS NULL AND operator_reservation_id IS NULL AND operator_continuation_id IS NULL)
    OR (operator_account_id IS NOT NULL AND operator_reservation_id IS NOT NULL AND operator_continuation_id IS NOT NULL)
  );
-- Preserve provenance for fences committed before this migration. Native command
-- keys bind the suspension root and reservation; receipt identity and transaction
-- bind the exact subject mutation. This one-time backfill is never a page scan.
UPDATE access.lifecycle_fence_receipt f
SET operator_account_id = c.account_id,
    operator_reservation_id = split_part(r.idempotency_key, ':', 5)::uuid,
    operator_continuation_id = c.continuation_id
FROM core.receipt r, access.committed_continuation c
WHERE r.principal_kind = 'account'
  AND r.principal_id = '00000000-0000-8000-8000-000000000001'::uuid
  AND r.command_kind = 'access.operator.subject-fenced'
  AND r.idempotency_key ~ '^[0-9]+:wf:[0-9a-f]{64}:fence:[0-9a-f-]{36}$'
  AND r.transaction_id = f.transaction_id
  AND r.response->>'accountId' = f.account_id::text
  AND r.response->>'receiptId' = f.receipt_id::text AND r.response->>'fenced' = 'true'
  AND r.idempotency_key = f.route::text || ':' || c.command_key_prefix || ':fence:' || split_part(r.idempotency_key, ':', 5)
  AND c.allowlist @> '[{"step":"operator-responsibility-page"}]'::jsonb;
-- migrate:down
ALTER TABLE access.lifecycle_fence_receipt
  DROP CONSTRAINT lifecycle_fence_operator_origin,
  DROP COLUMN operator_account_id,
  DROP COLUMN operator_reservation_id,
  DROP COLUMN operator_continuation_id;
DROP INDEX access.committed_continuation_operator_latest;
DROP INDEX access.committed_continuation_barrier;
