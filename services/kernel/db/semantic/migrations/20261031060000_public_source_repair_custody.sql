-- migrate:up
-- Keep only bounded ordered SHA-256 locators; old rows remain explicitly unverifiable.
ALTER TABLE semantic.public_filter_repair_step
  ADD COLUMN repair_locator_digests bytea,
  ADD CONSTRAINT public_filter_repair_locator_digests_bound CHECK
    (repair_locator_digests IS NULL OR
      (input_limit IS NOT NULL AND octet_length(repair_locator_digests) <= 8192
        AND mod(octet_length(repair_locator_digests),32) = 0
        AND octet_length(repair_locator_digests) / 32 <= input_limit));

-- migrate:down
ALTER TABLE semantic.public_filter_repair_step
  DROP CONSTRAINT public_filter_repair_locator_digests_bound,
  DROP COLUMN repair_locator_digests;
