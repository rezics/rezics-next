-- migrate:up
ALTER TABLE economy.funding_dispatch
  ADD COLUMN test_lane text CHECK (test_lane ~ '^[0-9a-f]{64}$');

-- Preserve open intents accepted by the previous development HTTP intake.
-- These identifier components are ASCII, and array_to_json emits compact JSON.
UPDATE economy.funding_dispatch AS dispatch
SET test_lane = encode(sha256(convert_to(array_to_json(
  ARRAY['test-funding-lane', intent.book_id, intent.asset_id, intent.provider_namespace]
)::text, 'UTF8')), 'hex')
FROM economy.funding_intent AS intent
WHERE dispatch.book_id = intent.book_id
  AND dispatch.intent_id = intent.intent_id
  AND dispatch.closed_at IS NULL
  AND intent.provider_mode = 'test'
  AND intent.intent_id ~ '^[0-9a-f]{64}$'
  AND intent.destination_ref = encode(sha256(convert_to(array_to_json(
    ARRAY['test-funding-destination', intent.book_id, intent.provider_namespace, intent.wallet_id::text]
  )::text, 'UTF8')), 'hex');

CREATE INDEX funding_dispatch_test_due_idx ON economy.funding_dispatch (book_id, test_lane, due_at, intent_id)
  WHERE closed_at IS NULL AND test_lane IS NOT NULL;

-- migrate:down
ALTER TABLE economy.funding_dispatch DROP COLUMN test_lane;
