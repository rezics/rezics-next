-- migrate:up
-- The same immutable receiving ledger retains the actual Search hold, independently of Library captures.
ALTER TABLE semantic.identity_epoch_receiving_record ADD COLUMN native_hold jsonb;
ALTER TABLE semantic.identity_epoch_receiving_record ADD CONSTRAINT identity_epoch_receiving_native_variant CHECK (COALESCE((
 (binding->>'step'='library-private-follow-counts' AND native_hold IS NULL) OR
 (binding->>'step'='search-canonical-index' AND native_hold IS NOT NULL
  AND jsonb_typeof(native_hold)='object' AND octet_length(native_hold::text)<=4096
  AND native_hold->'source'=binding->'source'
  AND native_hold->'locator'=binding->'source'->'locator'
  AND native_hold->>'holdId' IS NOT NULL)
), false));

-- migrate:down
ALTER TABLE semantic.identity_epoch_receiving_record DROP CONSTRAINT identity_epoch_receiving_native_variant;
ALTER TABLE semantic.identity_epoch_receiving_record DROP COLUMN native_hold;
