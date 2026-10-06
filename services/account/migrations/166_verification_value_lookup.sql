-- Password fences and operator resets revoke verification artifacts by owner
-- value. Keep those equality deletes inside that owner's neighbourhood. Hash
-- indexing also accepts the large JSON values stored by other auth plugins.
CREATE INDEX IF NOT EXISTS account_verification_value_lookup
  ON public.verification USING hash (value);
