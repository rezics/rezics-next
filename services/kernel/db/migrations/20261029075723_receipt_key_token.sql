-- migrate:up
ALTER TABLE core.receipt DROP CONSTRAINT receipt_anonymous_key_check;
ALTER TABLE core.receipt ADD CONSTRAINT receipt_anonymous_key_check CHECK (
  principal_kind <> 'anonymous' OR
  idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
  idempotency_key ~ '^rk1\.(0|[1-9][0-9]{0,2})\.[A-Za-z0-9_-]{43}$'
);

-- migrate:down
-- Forward-only: tokenized anonymous receipts cannot be represented by the former constraint.
