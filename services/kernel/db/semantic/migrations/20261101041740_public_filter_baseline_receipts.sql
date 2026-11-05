-- migrate:up
-- Original owner receipts are immutable after sealing. Older enrollment rows
-- deliberately remain unsealed: their missing creation/change bridge is unknown.
ALTER TABLE semantic.public_filter_home_enrollment
  ADD COLUMN creation_position bigint CHECK (creation_position >= 0),
  ADD COLUMN native_enqueue_revision bigint CHECK (native_enqueue_revision >= 0),
  ADD COLUMN key_digest text CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN receipt text CHECK (receipt ~ '^[0-9a-f]{64}$');

ALTER TABLE semantic.public_filter_bootstrap
  ADD COLUMN coverage_generation bigint CHECK (coverage_generation >= 0),
  ADD COLUMN coverage_after integer NOT NULL DEFAULT 0 CHECK (coverage_after BETWEEN 0 AND 4096),
  ADD COLUMN coverage_root text CHECK (coverage_root ~ '^[0-9a-f]{64}$'),
  ADD COLUMN coverage_sealed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT public_filter_bootstrap_complete_coverage CHECK
    (NOT coverage_sealed OR (coverage_after = 4096 AND coverage_generation IS NOT NULL AND coverage_root IS NOT NULL));

CREATE FUNCTION semantic.retain_public_filter_home_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.receipt IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Original public-filter home receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.receipt IS NOT NULL AND
    (NOT NEW.complete OR NEW.creation_position IS NULL OR NEW.native_enqueue_revision IS NULL OR NEW.key_digest IS NULL)
  THEN
    RAISE EXCEPTION 'Incomplete public-filter home receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_home_receipt_immutable
  BEFORE UPDATE ON semantic.public_filter_home_enrollment
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_home_receipt();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original public-filter baseline custody requires retained retirement'; END $$;
